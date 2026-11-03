import { arcPoints } from './interpreter';
import type { Vec } from './types';
import type { ToolDef, ToolOffset } from '../machine/tools';
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
  grooves: { z0: number; z1: number; minDia: number }[];
  /** 내경(드릴 · 보링)도 넣었는지 */
  bore: boolean;
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
      grooves.push({ z0: q.z, z1: endZ, minDia: 2 * minR });
      break;
    }
    out.push({ kind: 'line', a: q, b: hit });
    grooves.push({ z0: q.z, z1: hit.z, minDia: 2 * minR });
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
  if (dr > wall - 0.3) {
    const fit = Math.floor(2 * wall - 2);
    throw new Error(`드릴 Ø${fmt(drill.width)} 이 구멍 Ø${fmt(2 * wall)} 보다 너무 큽니다. 설정에서 ${toolCode(drill.no).slice(0, 3)} 드릴 지름을 Ø${fit} 이하로 바꿔 주세요`);
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
  const tipLen = dr / Math.tan((59 * Math.PI) / 180);
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
  for (const gr of env.grooves)
    lines.push(`(내경 홈 Z${fmt(gr.z0)} ~ Z${fmt(gr.z1)} 최대 Ø${fmt(-gr.minDia)} : G71 로는 깎을 수 없어 메워서 지나감)`);
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
  return lines;
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
  for (const gr of grooves)
    code.push(`(홈 Z${fmt(gr.z0)} ~ Z${fmt(gr.z1)} 최소 Ø${fmt(gr.minDia)} : G71 로는 깎을 수 없어 메워서 지나감. 홈 바이트로 따로 연습)`);
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
  if (innerRaw.length) code.push(...boreBlocks(faceFirst(innerRaw), faceZ, input));

  const inside = (z0: number, z1: number, what: string) => {
    if (z0 > faceZ + EPS || z1 < endZ - EPS) throw new Error(`${what} 구간 Z${fmt(z0)} ~ Z${fmt(z1)} 이 도면(Z${fmt(faceZ)} ~ Z${fmt(endZ)}) 밖에 있습니다`);
  };

  // 널링: 정삭이 끝난 지름에 롤러를 눌러 Z 방향으로 지나간다 (깎지 않음)
  const knurlTool = input.tools.find((t) => t.type === 'knurl');
  for (const k of feat.knurls) {
    inside(k.z0, k.z1, '널링');
    if (!knurlTool) {
      code.push(`(널링 Z${fmt(k.z0)} ~ Z${fmt(k.z1)} : 설정에 널링 공구가 없어 생략)`);
      continue;
    }
    const d = 2 * radiusAt(out, (k.z0 + k.z1) / 2);
    const w = Math.min(knurlTool.width > 0 ? knurlTool.width : 8, k.z0 - k.z1) / 2;
    code.push(
      `(널링 Z${fmt(k.z0)} ~ Z${fmt(k.z1)} Ø${fmt(d)} : 저속으로 롤러를 눌러 무늬를 냄. 기준점 = 롤러 폭 가운데)`,
      `${toolCode(knurlTool.no).slice(0, 3)}00 ;`,
      'G97 S150 M03 ;',
      `G00 X${fmt(D + 4)} Z${fmt(faceZ + 5)} ${toolCode(knurlTool.no)} M08 ;`,
      `Z${fmt(k.z0 - w)} ;`,
      `G01 X${fmt(d - 0.4)} F0.1 ;`,
      `Z${fmt(k.z1 + w)} F0.2 ;`,
      '(누른 채로 급속 후퇴하면 충돌이므로 이송으로 빼낸다)',
      `X${fmt(d + 2)} F0.5 ;`,
      `G00 X${fmt(D + 4)} ;`,
      `Z${fmt(faceZ + 5)} ;`,
      'G28 U0. W0. M09 ;',
      'M05 ;',
    );
  }

  // 나사: G76 (산높이 0.6134P, 첫 절입 ≈ 산높이의 38%, 정삭 2회)
  const threadTool = input.tools.find((t) => t.type === 'thread');
  for (const t of feat.threads) {
    inside(t.z0, t.z1, '나사');
    const spec = coarsePitch(t.dia) === t.pitch ? `M${t.dia}` : `M${t.dia}x${t.pitch}`;
    if (!threadTool) {
      code.push(`(나사 ${spec} : 설정에 나사 바이트가 없어 생략)`);
      continue;
    }
    const h = Math.round(t.pitch * 0.6134 * 1000) / 1000;
    const q = Math.max(100, Math.round((h * 0.38 * 1000) / 10) * 10);
    code.push(
      `(G76 나사 ${spec} : 산높이 ${fmt(h)} / 첫 절입 ${fmt(q / 1000)} / 골지름 X${fmt(t.dia - 2 * h)})`,
      `${toolCode(threadTool.no).slice(0, 3)}00 ;`,
      'G97 S600 M03 ;',
      `G00 X${fmt(t.dia + 4)} Z${fmt(t.z0 + 5)} ${toolCode(threadTool.no)} M08 ;`,
      'G76 P020060 Q50 R0.05 ;',
      `G76 X${fmt(t.dia - 2 * h)} Z${fmt(t.z1)} P${Math.round(h * 1000)} Q${q} F${fmt(t.pitch)} ;`,
      'G28 U0. W0. M09 ;',
      'M05 ;',
    );
  }
  code.push('M30 ;');
  return { code: code.join('\n') + '\n', grooves, bore: innerRaw.length > 0 };
}
