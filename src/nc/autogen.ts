import { arcPoints } from './interpreter';
import type { Vec } from './types';
import { toolShape, type ToolDef, type ToolOffset } from '../machine/tools';
import { drawingMoves, splitDrawing, type DrawingMove } from '../sim/compare';
import { protrusionOf, type StockConfig } from '../sim/simulator';
import { coarsePitch, parseFeatures } from '../sim/features';

/**
 * 도면(목표 형상) → 모범 답안 프로그램.
 * 연습용이라 외경 단면 · G71 황삭 · G70 정삭(G42), 도면 탭에 적힌 널링 · 나사(G76) 만 만든다.
 * 홈(안쪽으로 파인 곳)은 G71 기본형으로 깎을 수 없으므로 메워서 지나가고, 주석으로만 알려 준다.
 * 절삭 조건 계산 · 공구 간섭 검사 · 공정 순서 · 2차 가공은 하지 않는다 (조건은 고정값).
 */
export interface AutoProgram {
  code: string;
  /** 건너뛴 홈 (Z 큰 쪽 → 작은 쪽, 가장 깊은 직경) */
  grooves: Groove[];
  /** 내경(드릴 · 보링)도 넣었는지 */
  bore: boolean;
}

/**
 * G71 이 메워서 지나간 홈 (끝면 쪽 z0 → 척 쪽 z1).
 * 내경은 반경 부호를 뒤집어 계산하므로 minDia · level 도 뒤집힌 값.
 */
export interface Groove {
  z0: number;
  z1: number;
  /** 가장 깊은 곳의 지름 */
  minDia: number;
  /** 메운 높이(반경) */
  level: number;
  /** 척 쪽 끝까지 다시 올라오지 않음 (끝 모따기·단) */
  toEnd: boolean;
}

export interface AutoInput {
  drawing: string;
  stock: StockConfig;
  tools: ToolDef[];
  offsets: ToolOffset[];
}

const EPS = 1e-4;
/** 사이클 시작점 Z (끝면에서 띄우는 거리) */
const CLEAR_Z = 2;

const fmt = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  const s = (Object.is(r, -0) ? 0 : r).toString();
  return s.includes('.') ? s : s + '.';
};
const same = (a: Vec, b: Vec) => Math.abs(a.z - b.z) < EPS && Math.abs(a.r - b.r) < EPS;

function points(m: DrawingMove): Vec[] {
  return m.kind === 'arc' ? arcPoints(m.a, m.b, m.c, m.ccw) : [m.a, m.b];
}

/** 같은 원 위에서 시작/끝만 바꾼 이동 */
function part(m: DrawingMove, a: Vec, b: Vec): DrawingMove {
  return m.kind === 'arc' ? { ...m, a, b } : { kind: 'line', a, b };
}

/** 끝면 → 척 방향으로 X 가 줄지 않고 Z 가 늘지 않는 점까지의 개수 (G71 Type I 조건) */
function monotonicCount(pts: Vec[]): number {
  let k = 1;
  while (k < pts.length && pts[k].r >= pts[k - 1].r - EPS && pts[k].z <= pts[k - 1].z + EPS) k++;
  return k;
}

/** 이동 m 위에서 반경이 level 이 되는 점 (from 에 가장 가까운 쪽) */
function pointAtLevel(m: DrawingMove, level: number, near: Vec): Vec {
  if (m.kind === 'line') {
    const t = Math.abs(m.b.r - m.a.r) < 1e-12 ? 0 : (level - m.a.r) / (m.b.r - m.a.r);
    return { z: m.a.z + (m.b.z - m.a.z) * t, r: level };
  }
  const R = Math.hypot(m.a.z - m.c.z, m.a.r - m.c.r);
  const h = Math.sqrt(Math.max(0, R * R - (level - m.c.r) ** 2));
  const z = Math.abs(m.c.z + h - near.z) < Math.abs(m.c.z - h - near.z) ? m.c.z + h : m.c.z - h;
  return { z, r: level };
}

/**
 * G71 로 깎을 수 있게 외곽선을 고친다: 홈은 위를 직선(Z 방향)으로 메운다.
 * 원호 일부만 오목하면 원호를 거기서 자른다.
 */
function envelope(moves: DrawingMove[]): { out: DrawingMove[]; grooves: AutoProgram['grooves'] } {
  const out: DrawingMove[] = [];
  const grooves: AutoProgram['grooves'] = [];
  const queue = [...moves];
  while (queue.length) {
    const m = queue.shift()!;
    const pts = points(m);
    const k = monotonicCount(pts);
    if (k === pts.length) {
      out.push(m);
      continue;
    }
    // pts[k-1] 까지는 그대로 깎고, 거기서부터 홈
    const q = pts[k - 1];
    if (k > 1) out.push(part(m, m.a, q));
    const rest = [part(m, q, m.b), ...queue];
    let minR = q.r;
    let found = -1;
    let hit: Vec | null = null;
    for (let j = 0; j < rest.length && found < 0; j++) {
      const rp = points(rest[j]);
      for (let i = 1; i < rp.length; i++) {
        minR = Math.min(minR, rp[i].r);
        if (rp[i].r >= q.r - EPS && rp[i - 1].r < q.r - EPS && rp[i].z <= q.z + EPS) {
          found = j;
          hit = pointAtLevel(rest[j], q.r, rp[i]);
          break;
        }
      }
    }
    queue.length = 0;
    if (found < 0 || !hit) {
      // 척 쪽 끝까지 다시 올라오지 않음 → 그 높이로 끝까지
      const endZ = rest[rest.length - 1].b.z;
      out.push({ kind: 'line', a: q, b: { z: endZ, r: q.r } });
      grooves.push({ z0: q.z, z1: endZ, minDia: 2 * minR, level: q.r, toEnd: true });
      break;
    }
    out.push({ kind: 'line', a: q, b: hit });
    grooves.push({ z0: q.z, z1: hit.z, minDia: 2 * minR, level: q.r, toEnd: false });
    const after = rest[found];
    if (!same(hit, after.b)) queue.push(part(after, hit, after.b));
    queue.push(...rest.slice(found + 1));
  }
  return { out, grooves };
}

/** 메운 외곽선에서 Z 위치의 반경 */
function radiusAt(moves: DrawingMove[], z: number): number {
  let best = 0;
  for (const m of moves) {
    const pts = points(m);
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const lo = Math.min(a.z, b.z);
      const hi = Math.max(a.z, b.z);
      if (z < lo - EPS || z > hi + EPS) continue;
      const t = hi - lo < EPS ? 1 : (z - a.z) / (b.z - a.z);
      best = Math.max(best, a.r + (b.r - a.r) * t);
    }
  }
  return best;
}

/**
 * G71 / G70 의 P~Q 블록. 같은 G 와 같은 좌표는 생략 (모달).
 * 첫 이동이 직선이면 그 직선을 Z2 까지 늘여서 들어가고(모따기를 끊김 없이), 마지막에 반경 endR 로 빠진다.
 */
function contourBody(out: DrawingMove[], faceZ: number, nP: number, nQ: number, endR: number): string[] {
  const body: string[] = [];
  let g = '';
  // r -1: 첫 블록(N)에는 X 를 반드시 쓴다
  let at: Vec = { z: CLEAR_Z + faceZ, r: -1 };
  const emit = (code: string, p: Vec, extra = '') => {
    const words: string[] = [];
    if (code !== g || code === 'G02' || code === 'G03') words.push(code);
    if (Math.abs(p.r - at.r) > EPS) words.push(`X${fmt(2 * p.r)}`);
    if (Math.abs(p.z - at.z) > EPS) words.push(`Z${fmt(p.z)}`);
    if (extra) words.push(extra);
    g = code;
    at = p;
    return words.join(' ');
  };

  const first = out[0];
  let rest = out;
  if (first.kind === 'line' && first.b.z < first.a.z - EPS) {
    const slope = (first.b.r - first.a.r) / (first.b.z - first.a.z);
    const r = first.a.r + (CLEAR_Z + faceZ - first.a.z) * slope;
    rest = r >= 0 ? out.slice(1) : out;
    body.push(`N${nP} ${emit('G00', { ...at, r: r >= 0 ? r : first.a.r })} ;`);
    body.push(`${emit('G01', r >= 0 ? first.b : first.a, 'F0.1')} ;`);
  } else {
    body.push(`N${nP} ${emit('G00', { ...at, r: first.a.r })} ;`);
    body.push(`${emit('G01', first.a, 'F0.1')} ;`);
  }
  for (const m of rest) {
    if (m.kind === 'line') {
      const line = emit('G01', m.b);
      if (line) body.push(`${line} ;`);
    } else {
      const R = Math.hypot(m.a.z - m.c.z, m.a.r - m.c.r);
      // 180° 넘는 원호는 R 을 음수로
      const a0 = Math.atan2(m.a.r - m.c.r, m.a.z - m.c.z);
      const a1 = Math.atan2(m.b.r - m.c.r, m.b.z - m.c.z);
      let sweep = m.ccw ? a1 - a0 : a0 - a1;
      while (sweep <= 1e-9) sweep += Math.PI * 2;
      body.push(`${emit(m.ccw ? 'G03' : 'G02', m.b, `R${fmt(sweep > Math.PI ? -R : R)}`)} ;`);
    }
  }
  const last = emit('G01', { ...at, r: endR });
  body.push(`N${nQ} ${last || `G01 X${fmt(2 * endR)}`} ;`);
  return body;
}

/** 반경 부호를 뒤집은 이동 (내경을 외경과 같은 계산으로 다루기 위해) */
function flipR(m: DrawingMove): DrawingMove {
  const f = (p: Vec): Vec => ({ z: p.z, r: -p.r });
  return m.kind === 'arc' ? { kind: 'arc', a: f(m.a), b: f(m.b), c: f(m.c), ccw: !m.ccw } : { kind: 'line', a: f(m.a), b: f(m.b) };
}

/** 끝면 → 안쪽(척) 방향으로 맞춘다 */
function faceFirst(moves: DrawingMove[]): DrawingMove[] {
  if (moves[0].a.z >= moves[moves.length - 1].b.z) return moves;
  return [...moves].reverse().map((m) => (m.kind === 'arc' ? { ...m, a: m.b, b: m.a, ccw: !m.ccw } : { kind: 'line', a: m.b, b: m.a }));
}

/**
 * 내경: 드릴(G74) → 보링 황삭(G71, 정삭 여유 U 마이너스) → 보링 정삭(G70 + G41).
 * 보링은 드릴 구멍보다 0.5mm 안쪽(반경)에서 시작하고, 그보다 작은 곳(막힌 구멍 바닥 가운데의 드릴 끝 모양)은 남는다.
 */
function boreBlocks(inner: DrawingMove[], faceZ: number, input: AutoInput): string[] {
  const drill = input.tools.find((t) => t.type === 'drill');
  const bar = input.tools.find((t) => t.type === 'boring');
  if (!drill) throw new Error('도면에 구멍(내경)이 있는데 설정에 드릴이 없습니다');
  if (!bar) throw new Error('도면에 구멍(내경)이 있는데 설정에 보링바가 없습니다');

  // 구멍 쪽으로 파인 곳(내경 홈)은 외경 홈과 같은 방법으로 메운다 (반경 부호를 뒤집어 계산)
  const env = envelope(inner.map(flipR));
  const out = env.out.map(flipR);
  const pts = out.flatMap(points);
  const wall = Math.min(...pts.filter((p) => p.r > EPS).map((p) => p.r));
  const dr = drill.width / 2;
  if (!(wall > 0)) throw new Error('내경 윤곽에 구멍 지름이 없습니다');
  const tName = toolCode(drill.no).slice(0, 3);
  const tipLen = dr / Math.tan((59 * Math.PI) / 180);

  // 드릴 지름 = 구멍 지름인 곧은 구멍(입구 모따기는 있어도 됨)은 드릴로만 뚫는다
  const body = inner[0].kind === 'line' && inner[0].a.r > inner[0].b.r + EPS && Math.abs(inner[0].b.r - wall) < 0.01 ? inner.slice(1) : inner;
  const straight = body.every((m) => points(m).every((p) => p.r <= wall + 0.01));
  if (straight && Math.abs(drill.width - 2 * wall) <= 0.05) {
    // 막힌 구멍은 드릴 몸통(지름 전체)이 바닥까지 가게 → 끝 원뿔은 바닥보다 더 들어간다
    const bottom = pts.find((p) => p.r < wall - 0.01);
    const through = !bottom;
    const drillZ = through ? Math.floor((pts[pts.length - 1].z - tipLen - 1) * 10) / 10 : Math.round((bottom!.z - tipLen) * 1000) / 1000;
    return [
      `(드릴 Ø${fmt(drill.width)} : 구멍 지름과 같아서 드릴로만 뚫음 · G74 로 5mm 씩 쪼아 들어감${through ? ', 관통' : ''})`,
      ...(body !== inner ? ['(입구 모따기는 드릴로 못 깎으므로 남음)'] : []),
      ...(through ? [] : [`(드릴 끝 118° 원뿔이 바닥 Z${fmt(bottom!.z)} 보다 ${fmt(tipLen)} 더 들어감)`]),
      `${tName}00 ;`,
      'G97 S500 M03 ;',
      `G00 X0. Z${fmt(faceZ + 5)} ${toolCode(drill.no)} M08 ;`,
      'G74 R1. ;',
      `G74 Z${fmt(drillZ)} Q5000 F0.1 ;`,
      'G28 U0. W0. M09 ;',
      'M05 ;',
    ];
  }

  if (dr > wall + 0.005) {
    const fit = Math.floor(2 * wall - 2);
    throw new Error(`드릴 Ø${fmt(drill.width)} 이 구멍 Ø${fmt(2 * wall)} 보다 너무 큽니다. 설정에서 ${tName} 드릴 지름을 Ø${fit} 이하로 바꿔 주세요`);
  }
  // 보링바가 드릴 구멍에 들어가려면: 인서트가 축 건너편으로 넘어간 만큼이 드릴 구멍 반경보다 작아야 한다
  // (시작 위치: 공구 끝 반경 = 드릴 반경 - 0.5, 0.2 여유)
  const reach = -Math.min(...toolShape(bar).map((p) => p.r));
  const minDrill = Math.ceil(0.5 + reach + 0.2);
  if (drill.width < minDrill) {
    const maxDrill = Math.floor(2 * wall - 2);
    const same = `${tName} 드릴을 구멍과 같은 Ø${fmt(2 * wall)} 로 바꾸면 드릴로만 뚫습니다`;
    if (minDrill > maxDrill)
      throw new Error(
        `구멍 Ø${fmt(2 * wall)} 은 보링바(${toolCode(bar.no).slice(0, 3)})가 들어가기에 너무 작습니다 (드릴 구멍이 Ø${minDrill} 이상이어야 함).` +
          (straight ? ` 설정에서 ${same}` : ''),
      );
    throw new Error(
      `드릴 Ø${fmt(drill.width)} 구멍에는 보링바가 들어가지 못합니다. 설정에서 ${tName} 드릴 지름을 Ø${minDrill} ~ Ø${maxDrill} 로 바꿔 주세요` +
        (straight ? ` (또는 ${same})` : ''),
    );
  }
  const rStop = dr - 0.5;

  // 보링 형상: 반경이 rStop 까지 내려가는 곳에서 자른다
  const cut: DrawingMove[] = [];
  let through = true;
  for (const m of out) {
    const mp = points(m);
    if (mp[mp.length - 1].r > rStop + EPS) {
      cut.push(m);
      continue;
    }
    const hit = pointAtLevel(m, rStop, mp[0]);
    if (Math.abs(hit.z - m.a.z) > EPS || Math.abs(hit.r - m.a.r) > EPS) cut.push(part(m, m.a, hit));
    through = false;
    break;
  }
  const endZ = cut[cut.length - 1].b.z;
  // 드릴 깊이: 관통이면 끝까지 뚫고 나가게, 막힌 구멍이면 드릴 몸통 지름이 들어갈 수 있는 곳까지 끝을 맞춘다
  let drillZ = Math.floor((endZ - tipLen - 1) * 10) / 10;
  if (!through) {
    drillZ = endZ;
    for (const m of out) {
      const mp = points(m);
      if (mp[mp.length - 1].r >= dr - EPS) continue;
      drillZ = pointAtLevel(m, dr, mp[0]).z;
      break;
    }
  }
  const off = input.offsets[bar.no - 1];
  const sx = fmt(2 * rStop);
  const zc = fmt(faceZ + CLEAR_Z);
  const lines: string[] = [];
  lines.push(
    `(드릴 Ø${fmt(drill.width)} : G74 로 5mm 씩 쪼아 들어감${through ? ', 관통' : ''})`,
    `${toolCode(drill.no).slice(0, 3)}00 ;`,
    'G97 S500 M03 ;',
    `G00 X0. Z${fmt(faceZ + 5)} ${toolCode(drill.no)} M08 ;`,
    'G74 R1. ;',
    `G74 Z${fmt(drillZ)} Q5000 F0.1 ;`,
    'G28 U0. W0. M09 ;',
    'M05 ;',
    '(내경 황삭 G71 : 내경이므로 정삭 여유 U 가 마이너스)',
    `G50 S2000 ${toolCode(bar.no).slice(0, 3)}00 ;`,
    'G96 S120 M03 ;',
    `G00 X${sx} Z${zc} ${toolCode(bar.no)} M08 ;`,
    'G71 U1. R0.5 ;',
    'G71 P30 Q40 U-0.4 W0.1 F0.2 ;',
    ...contourBody(cut, faceZ, 30, 40, rStop),
    `(내경 정삭 : 구멍 안쪽은 G41${off && off.R > 0 ? '' : ` - 공구 보정 ${String(bar.no).padStart(2, '0')}번에 R 과 T(2) 를 넣어야 보정됩니다`})`,
    `G41 G00 X${sx} Z${zc} ;`,
    'G70 P30 Q40 ;',
    `G40 G00 Z${fmt(faceZ + 5)} ;`,
    'G28 U0. W0. M09 ;',
    'M05 ;',
  );
  if (!through) lines.splice(lines.length - 2, 0, `(구멍 바닥 가운데 Ø${sx} 안쪽은 드릴 끝 모양이 조금 남을 수 있음)`);
  lines.push(...grooveBlocks(env.grooves, inner.map(flipR), -1, input.tools.find((t) => t.type === 'igroove'), faceZ, 0));
  return lines;
}

/**
 * G71 이 메운 홈을 홈 바이트로 깎는다 (공구는 한 번만 불러서 홈을 차례로).
 * 바닥이 평평한 부분은 G75, 홈 옆 모따기·경사는 바이트 모서리로 G01 로 따라간다
 * (끝면 쪽 경사 = 끝면 쪽 모서리, 척 쪽 경사 = 척 쪽 모서리. 기준점 = 척 쪽 모서리, 날폭은 +Z).
 * moves 는 홈을 찾을 때 쓴 형상 (내경이면 반경을 뒤집은 것), side = 1 외경 / -1 내경.
 * 바이트보다 좁은 홈, 척 쪽 끝의 모따기·단은 남기고 주석으로 알린다.
 */
function grooveBlocks(grooves: Groove[], moves: DrawingMove[], side: 1 | -1, tool: ToolDef | undefined, faceZ: number, D: number): string[] {
  const notes: string[] = [];
  const cuts: string[][] = [];
  const name = side > 0 ? '홈' : '내경 홈';
  const toolName = side > 0 ? '홈 바이트' : '내경 홈 바이트';
  const pts = moves.flatMap(points);
  const X = (r: number) => `X${fmt(2 * side * r)}`;
  const w = tool && tool.width > 0 ? tool.width : 3;
  for (const g of grooves) {
    const where = `Z${fmt(g.z0)} ~ Z${fmt(g.z1)} Ø${fmt(Math.abs(g.minDia))}`;
    if (g.toEnd) {
      notes.push(`(${name} ${where} : 척 쪽 끝의 모따기·단은 반대로 물려서 2차 가공)`);
      continue;
    }
    if (!tool) {
      notes.push(`(${name} ${where} : 설정에 ${toolName}가 없어 메워서 지나감)`);
      continue;
    }
    // 바닥(가장 깊은 곳)이 평평한 Z 범위
    const inside = pts.filter((q) => q.z <= g.z0 + EPS && q.z >= g.z1 - EPS);
    const deep = Math.min(...inside.map((q) => q.r));
    const flat = inside.filter((q) => q.r < deep + 0.005).map((q) => q.z);
    const za = Math.max(...flat);
    const zb = Math.min(...flat);
    if (za - zb < w - 1e-6) {
      notes.push(`(${name} ${where} : 홈 폭 ${fmt(za - zb)} 이 바이트 폭 ${fmt(w)} 보다 좁아 메워서 지나감)`);
      continue;
    }
    const start = g.level + 1;
    const q = Math.max(100, Math.floor((w * 800) / 100) * 100);
    const body = [
      `(${name} ${where} : G75 로 1mm 씩 쪼아 들어감)`,
      `G00 ${X(start)} Z${fmt(za - w)} ;`,
      'G75 R0.5 ;',
      `G75 ${X(deep)} Z${fmt(zb)} P1000 Q${q} F0.07 ;`,
    ];
    // 홈 벽(바닥보다 높은 점)을 형상 순서대로, 같은 점은 한 번만
    const wall = (keep: (q: Vec) => boolean) =>
      inside.filter((q) => keep(q) && q.r > deep + 0.005).filter((q, i, arr) => i === 0 || !same(q, arr[i - 1]));
    // 끝면 쪽 경사: 바닥에서 끝면 쪽 모서리로 벽을 따라 올라간다
    const faceSide = wall((q) => q.z > za - EPS).reverse();
    if (faceSide.some((q) => q.z > za + EPS)) {
      body.push(`(끝면 쪽 모따기 Z${fmt(za)} ~ Z${fmt(g.z0)} : 바이트 끝면 쪽 모서리로 따라감)`, `G01 ${X(deep)} F0.05 ;`);
      for (const p of faceSide) body.push(`${X(p.r)} Z${fmt(p.z - w)} ;`);
      body.push(`G00 ${X(start)} ;`);
    }
    // 척 쪽 경사: 바닥에서 척 쪽 모서리로 벽을 따라 올라간다
    const chuckSide = wall((q) => q.z < zb + EPS);
    if (chuckSide.some((q) => q.z < zb - EPS)) {
      body.push(`(척 쪽 모따기 Z${fmt(zb)} ~ Z${fmt(g.z1)} : 바이트 척 쪽 모서리로 따라감)`, `G00 Z${fmt(zb)} ;`, `G01 ${X(deep)} F0.05 ;`);
      for (const p of chuckSide) body.push(`${X(p.r)} Z${fmt(p.z)} ;`);
      body.push(`G00 ${X(start)} ;`);
    }
    // 다음 홈으로: 외경은 소재 밖으로, 내경은 구멍 밖(끝면 앞)으로 나간다
    body.push(side > 0 ? `G00 X${fmt(D + 4)} ;` : `G00 Z${fmt(faceZ + 5)} ;`);
    cuts.push(body);
  }
  if (!cuts.length || !tool) return notes;
  const t = toolCode(tool.no);
  return [
    ...notes,
    `(${toolName} 폭 ${fmt(w)} : 기준점 = 척 쪽 모서리, 날폭은 끝면 쪽으로)`,
    `${t.slice(0, 3)}00 ;`,
    'G97 S500 M03 ;',
    `G00 ${side > 0 ? `X${fmt(D + 4)}` : 'X0.'} Z${fmt(faceZ + 5)} ${t} M08 ;`,
    ...cuts.flat(),
    'G28 U0. W0. M09 ;',
    'M05 ;',
  ];
}

const toolCode = (no: number) => `T${String(no).padStart(2, '0')}${String(no).padStart(2, '0')}`;

export function generateProgram(input: AutoInput): AutoProgram {
  const parts = splitDrawing(input.drawing);
  const { moves: raw, error } = drawingMoves(parts.outer);
  if (error) throw new Error(`도면 ${error.line + 1}행: ${error.message}`);
  if (!raw.length) throw new Error('도면 탭에 목표 형상이 없습니다');
  const feat = parseFeatures(input.drawing);
  if (feat.errors.length) throw new Error(`도면 ${feat.errors[0].line + 1}행: ${feat.errors[0].message}`);
  let innerRaw: DrawingMove[] = [];
  if (parts.inner !== null) {
    const r = drawingMoves(parts.inner);
    if (r.error) throw new Error(`도면 ${r.error.line + 1}행: ${r.error.message}`);
    innerRaw = r.moves;
  }

  // 끝면 → 척 방향으로 맞춘다
  const moves = faceFirst(raw);

  // 앞쪽 끝면(Z 가 그대로인 X 방향 직선)은 단면 가공으로 깎는다
  const faceZ = moves[0].a.z;
  let i0 = 0;
  while (i0 < moves.length && moves[i0].kind === 'line' && Math.abs(moves[i0].b.z - faceZ) < EPS && Math.abs(moves[i0].a.z - faceZ) < EPS) i0++;
  const profile = moves.slice(i0);
  if (!profile.length) throw new Error('도면에 끝면만 있고 외경 형상이 없습니다');

  const { out, grooves } = envelope(profile);

  const s = input.stock;
  const D = s.diameter;
  const maxDia = 2 * Math.max(...out.flatMap((m) => points(m).map((p) => p.r)));
  if (maxDia > D + 0.001) throw new Error(`도면 최대 지름 Ø${fmt(maxDia)} 이 소재 Ø${fmt(D)} 보다 큽니다. 소재 지름을 늘려 주세요`);
  const endZ = out[out.length - 1].b.z;
  const prot = protrusionOf(s);
  if (faceZ - endZ > prot + 0.001)
    throw new Error(`도면 길이 ${fmt(faceZ - endZ)} 이 척에서 나온 길이 ${fmt(prot)} 보다 깁니다. 소재 길이나 척 물림을 바꿔 주세요`);

  const rough = input.tools.find((t) => t.type === 'rough');
  if (!rough) throw new Error('설정에 외경 황삭 공구가 없습니다');
  const finish = input.tools.find((t) => t.type === 'finish') ?? rough;
  const finR = input.offsets[finish.no - 1]?.R ?? 0;

  const body = contourBody(out, faceZ, 10, 20, D / 2 + 1);

  const startX = fmt(D + 2);
  const faceStart = fmt(D + 4);
  const faceEnd = fmt(-2 * rough.noseR);
  const zc = fmt(faceZ + CLEAR_Z);
  const code: string[] = [
    'O0001 ;',
    `(모범 답안 : 도면 형상에서 자동으로 만든 외경 단면 · G71 황삭 · G70 정삭${innerRaw.length ? ' · 드릴 · 내경 보링' : ''})`,
    '(절삭 조건은 연습용 고정값입니다)',
  ];
  if (grooves.length) code.push('(홈은 G71 · G70 으로는 메워서 지나가고, 정삭 뒤에 홈 바이트로 따로 깎음)');
  code.push('G28 U0. W0. ;', `G50 S2000 ${toolCode(rough.no).slice(0, 3)}00 ;`, 'G96 S150 M03 ;');
  if (s.faceAllowance > EPS) {
    code.push(`G00 X${faceStart} Z${fmt(faceZ)} ${toolCode(rough.no)} M08 ;`);
    code.push(`(단면 : 노즈 반경만큼 중심을 지나가게 X${faceEnd})`);
    code.push(`G01 X${faceEnd} F0.2 ;`);
    code.push(`G00 X${startX} Z${zc} ;`);
  } else code.push(`G00 X${startX} Z${zc} ${toolCode(rough.no)} M08 ;`);
  code.push(
    '(G71 외경 황삭 : 절입 1.5 / 도피 0.5 / 정삭 여유 X0.4 Z0.1)',
    'G71 U1.5 R0.5 ;',
    'G71 P10 Q20 U0.4 W0.1 F0.25 ;',
    ...body,
    'G28 U0. W0. M09 ;',
    'M05 ;',
    `(G70 정삭 : G42 인선R보정${finR > 0 ? '' : ` - 공구 보정 ${String(finish.no).padStart(2, '0')}번에 R 과 T 를 넣어야 보정됩니다`})`,
    `G50 S2500 ${toolCode(finish.no).slice(0, 3)}00 ;`,
    'G96 S180 M03 ;',
    `G42 G00 X${startX} Z${zc} ${toolCode(finish.no)} M08 ;`,
    'G70 P10 Q20 ;',
    `G40 G00 X${fmt(D + 50)} Z${fmt(faceZ + 50)} ;`,
    'G28 U0. W0. M09 ;',
    'M05 ;',
  );
  code.push(...grooveBlocks(grooves, profile, 1, input.tools.find((t) => t.type === 'groove'), faceZ, D));
  if (innerRaw.length) code.push(...boreBlocks(faceFirst(innerRaw), faceZ, input));

  const inside = (z0: number, z1: number, what: string) => {
    if (z0 > faceZ + EPS || z1 < endZ - EPS) throw new Error(`${what} 구간 Z${fmt(z0)} ~ Z${fmt(z1)} 이 도면(Z${fmt(faceZ)} ~ Z${fmt(endZ)}) 밖에 있습니다`);
  };

  // 널링: 정삭이 끝난 지름에 롤러를 눌러 Z 방향으로 지나간다 (깎지 않음). 공구는 한 번만 불러서 끝면 쪽 구간부터
  const knurlTool = input.tools.find((t) => t.type === 'knurl');
  const knurls = [...feat.knurls].sort((a, b) => b.z0 - a.z0);
  for (const k of knurls) inside(k.z0, k.z1, '널링');
  if (knurls.length && !knurlTool) code.push(`(널링 : 설정에 널링 공구가 없어 생략)`);
  if (knurls.length && knurlTool) {
    const t = toolCode(knurlTool.no);
    code.push(
      '(널링 : 저속으로 롤러를 눌러 무늬를 냄. 기준점 = 롤러 폭 가운데. 누른 채로 급속 후퇴하면 충돌이므로 이송으로 빼낸다)',
      `${t.slice(0, 3)}00 ;`,
      'G97 S150 M03 ;',
      `G00 X${fmt(D + 4)} Z${fmt(faceZ + 5)} ${t} M08 ;`,
    );
    for (const k of knurls) {
      const d = 2 * radiusAt(out, (k.z0 + k.z1) / 2);
      const w = Math.min(knurlTool.width > 0 ? knurlTool.width : 8, k.z0 - k.z1) / 2;
      code.push(
        `(널링 Z${fmt(k.z0)} ~ Z${fmt(k.z1)} Ø${fmt(d)})`,
        `G00 Z${fmt(k.z0 - w)} ;`,
        `G01 X${fmt(d - 0.4)} F0.1 ;`,
        `Z${fmt(k.z1 + w)} F0.2 ;`,
        `X${fmt(d + 2)} F0.5 ;`,
        `G00 X${fmt(D + 4)} ;`,
      );
    }
    code.push(`Z${fmt(faceZ + 5)} ;`, 'G28 U0. W0. M09 ;', 'M05 ;');
  }

  // 나사: G76 (산높이 0.6134P, 첫 절입 ≈ 산높이의 38%, 정삭 2회)
  const threadTool = input.tools.find((t) => t.type === 'thread');
  const innerTool = input.tools.find((t) => t.type === 'ithread');
  for (const t of feat.threads) {
    inside(t.z0, t.z1, '나사');
    const spec = coarsePitch(t.dia) === t.pitch ? `M${t.dia}` : `M${t.dia}x${t.pitch}`;
    const tool = t.inner ? innerTool : threadTool;
    if (!tool) {
      code.push(`(나사 ${spec}${t.inner ? ' 내경' : ''} : 설정에 ${t.inner ? '내경 나사 바이트' : '나사 바이트'}가 없어 생략)`);
      continue;
    }
    const h = Math.round(t.pitch * 0.6134 * 1000) / 1000;
    const q = Math.max(100, Math.round((h * 0.38 * 1000) / 10) * 10);
    if (t.inner) {
      // 암나사: 구멍(안지름) 안쪽에서 시작해 바깥(호칭 지름)까지 깎아 나간다 → G76 X 는 호칭 지름
      if (!innerRaw.length) throw new Error(`내경 나사 ${spec} 가 있는데 도면에 (내경) 구멍 윤곽이 없습니다`);
      const minorDia = t.dia - 1.0825 * t.pitch;
      code.push(
        `(G76 내경 나사 ${spec} : 구멍은 안지름 Ø${fmt(minorDia)} 로 보링, 산높이 ${fmt(h)} / 첫 절입 ${fmt(q / 1000)})`,
        `${toolCode(tool.no).slice(0, 3)}00 ;`,
        'G97 S500 M03 ;',
        `G00 X${fmt(Math.floor((minorDia - 1) * 10) / 10)} Z${fmt(t.z0 + 5)} ${toolCode(tool.no)} M08 ;`,
        'G76 P020060 Q50 R0.05 ;',
        `G76 X${fmt(t.dia)} Z${fmt(t.z1)} P${Math.round(h * 1000)} Q${q} F${fmt(t.pitch)} ;`,
        'G28 U0. W0. M09 ;',
        'M05 ;',
      );
      continue;
    }
    code.push(
      `(G76 나사 ${spec} : 산높이 ${fmt(h)} / 첫 절입 ${fmt(q / 1000)} / 골지름 X${fmt(t.dia - 2 * h)})`,
      `${toolCode(tool.no).slice(0, 3)}00 ;`,
      'G97 S600 M03 ;',
      `G00 X${fmt(t.dia + 4)} Z${fmt(t.z0 + 5)} ${toolCode(tool.no)} M08 ;`,
      'G76 P020060 Q50 R0.05 ;',
      `G76 X${fmt(t.dia - 2 * h)} Z${fmt(t.z1)} P${Math.round(h * 1000)} Q${q} F${fmt(t.pitch)} ;`,
      'G28 U0. W0. M09 ;',
      'M05 ;',
    );
  }
  code.push('M30 ;');
  return { code: code.join('\n') + '\n', grooves, bore: innerRaw.length > 0 };
}
