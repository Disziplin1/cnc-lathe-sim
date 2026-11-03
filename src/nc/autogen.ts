import { arcPoints } from './interpreter';
import type { Vec } from './types';
import type { ToolDef, ToolOffset } from '../machine/tools';
import { drawingMoves, type DrawingMove } from '../sim/compare';
import { protrusionOf, type StockConfig } from '../sim/simulator';

/**
 * 도면(목표 형상) → 모범 답안 프로그램.
 * 연습용이라 외경 단면 · G71 황삭 · G70 정삭(G42) 만 만든다.
 * 홈(안쪽으로 파인 곳)은 G71 기본형으로 깎을 수 없으므로 메워서 지나가고, 주석으로만 알려 준다.
 * 나사 · 절삭 조건 계산 · 공구 간섭 검사 · 공정 순서 · 2차 가공은 하지 않는다 (조건은 고정값).
 */
export interface AutoProgram {
  code: string;
  /** 건너뛴 홈 (Z 큰 쪽 → 작은 쪽, 가장 깊은 직경) */
  grooves: { z0: number; z1: number; minDia: number }[];
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

const toolCode = (no: number) => `T${String(no).padStart(2, '0')}${String(no).padStart(2, '0')}`;

export function generateProgram(input: AutoInput): AutoProgram {
  const { moves: raw, error } = drawingMoves(input.drawing);
  if (error) throw new Error(`도면 ${error.line + 1}행: ${error.message}`);
  if (!raw.length) throw new Error('도면 탭에 목표 형상이 없습니다');

  // 끝면 → 척 방향으로 맞춘다
  let moves = raw;
  if (raw[0].a.z < raw[raw.length - 1].b.z)
    moves = [...raw].reverse().map((m) => (m.kind === 'arc' ? { ...m, a: m.b, b: m.a, ccw: !m.ccw } : { kind: 'line', a: m.b, b: m.a }));

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

  // 정삭 형상 (P~Q). 같은 G 와 같은 좌표는 생략 (모달)
  const body: string[] = [];
  let g = '';
  // r -1: 첫 블록(N10)에는 X 를 반드시 쓴다
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

  // 첫 이동: 직선이면 그 직선을 Z2 까지 늘여서 들어간다 (모따기를 끊김 없이)
  const first = out[0];
  let rest = out;
  let nStart: Vec;
  if (first.kind === 'line' && first.b.z < first.a.z - EPS) {
    const slope = (first.b.r - first.a.r) / (first.b.z - first.a.z);
    const r = first.a.r + (CLEAR_Z + faceZ - first.a.z) * slope;
    nStart = r >= 0 ? { z: CLEAR_Z + faceZ, r } : first.a;
    rest = r >= 0 ? out.slice(1) : out;
    body.push(`N10 ${emit('G00', { ...at, r: nStart.r })} ;`);
    if (r >= 0) body.push(`${emit('G01', first.b, 'F0.1')} ;`);
    else body.push(`${emit('G01', first.a, 'F0.1')} ;`);
  } else {
    nStart = first.a;
    body.push(`N10 ${emit('G00', { ...at, r: nStart.r })} ;`);
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
  body.push(`N20 ${emit('G01', { ...at, r: D / 2 + 1 })} ;`);

  const startX = fmt(D + 2);
  const faceStart = fmt(D + 4);
  const faceEnd = fmt(-2 * rough.noseR);
  const zc = fmt(faceZ + CLEAR_Z);
  const code: string[] = [
    'O0001 ;',
    '(모범 답안 : 도면 형상에서 자동으로 만든 외경 단면 · G71 황삭 · G70 정삭)',
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
    'M30 ;',
  );
  return { code: code.join('\n') + '\n', grooves };
}
