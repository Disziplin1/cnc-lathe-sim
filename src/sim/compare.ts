import { lex, type Word } from '../nc/lexer';
import { arcPoints } from '../nc/interpreter';
import type { Alarm, Program, Vec } from '../nc/types';
import { areaOf, difference, fromPath, intersection, rect, toPath, type Path, type Paths } from './geometry';

/** 도면(목표 형상): 끝면 쪽에서 척 쪽으로 가는 외곽선 */
export interface Target {
  profile: Vec[];
  region: Path;
  zMin: number;
  zMax: number;
  /** 오목한 날카로운 모서리 (노즈 반경 때문에 반드시 살이 남는 곳) */
  concave: Vec[];
}

export interface CompareResult {
  excess: Paths;
  over: Paths;
  maxExcess: number;
  maxOver: number;
  excessAt: Vec | null;
  overAt: Vec | null;
  /** 비교에서 뺀 나사 구간 */
  excluded: [number, number][];
}

const dist = (a: Vec, b: Vec) => Math.hypot(b.z - a.z, b.r - a.r);

/** 도면 한 줄의 이동 (직선, 또는 중심 c 를 도는 원호) */
export type DrawingMove =
  | { kind: 'line'; a: Vec; b: Vec }
  | { kind: 'arc'; a: Vec; b: Vec; c: Vec; ccw: boolean };

/**
 * 도면 텍스트 → 이동 목록 (적힌 순서 그대로).
 * 형식은 G코드와 같다 (X 직경, Z, G01 / G02 / G03 R 또는 I K). 첫 줄은 시작점 (보통 X0. Z0.).
 */
export function drawingMoves(text: string): { moves: DrawingMove[]; error: Alarm | null } {
  const blocks = lex(text, 'mm', []);
  const moves: DrawingMove[] = [];
  let cur: Vec | null = null;
  let g = 'G01';
  for (const b of blocks) {
    const fail = (message: string) => ({ moves: [], error: { code: 'DWG', message, line: b.line, level: 'alarm' as const } });
    if (b.error) return fail(b.error.message);
    const w = new Map<string, Word>();
    for (const word of b.words) {
      if (word.letter === 'G') {
        const v = Math.round(word.value);
        if (v > 3) return fail(`도면에는 G00~G03 만 쓸 수 있습니다 (G${v})`);
        g = 'G0' + v;
      } else w.set(word.letter, word);
    }
    if (!(w.has('X') || w.has('Z') || w.has('U') || w.has('W'))) continue;
    if (!cur) {
      if (!w.has('X') || !w.has('Z')) return fail('첫 점은 X 와 Z 를 모두 써야 합니다 (예: X0. Z0.)');
      cur = { z: w.get('Z')!.value, r: w.get('X')!.value / 2 };
      continue;
    }
    const e: Vec = { ...cur };
    if (w.has('X')) e.r = w.get('X')!.value / 2;
    else if (w.has('U')) e.r += w.get('U')!.value / 2;
    if (w.has('Z')) e.z = w.get('Z')!.value;
    else if (w.has('W')) e.z += w.get('W')!.value;
    if (g === 'G02' || g === 'G03') {
      const ccw = g === 'G03';
      let c: Vec;
      if (w.has('R')) {
        const R = w.get('R')!.value;
        const d = dist(cur, e);
        if (d < 1e-9 || d / 2 > Math.abs(R) + 0.005) return fail('원호 R 값이 맞지 않습니다');
        const h = Math.sqrt(Math.max(0, R * R - (d * d) / 4));
        const left = { z: -(e.r - cur.r) / d, r: (e.z - cur.z) / d };
        const sign = (ccw ? 1 : -1) * (R > 0 ? 1 : -1);
        c = { z: (cur.z + e.z) / 2 + sign * h * left.z, r: (cur.r + e.r) / 2 + sign * h * left.r };
      } else if (w.has('I') || w.has('K')) {
        c = { z: cur.z + (w.get('K')?.value ?? 0), r: cur.r + (w.get('I')?.value ?? 0) };
      } else return fail('G02/G03 에는 R 또는 I/K 가 필요합니다');
      moves.push({ kind: 'arc', a: cur, b: e, c, ccw });
    } else if (dist(cur, e) > 1e-9) moves.push({ kind: 'line', a: cur, b: e });
    cur = e;
  }
  return { moves, error: null };
}

/** 이동 목록 → 점 목록 (원호는 잘게 나눔) */
export function movePoints(moves: DrawingMove[]): Vec[] {
  if (!moves.length) return [];
  const pts: Vec[] = [moves[0].a];
  for (const m of moves) {
    if (m.kind === 'arc') pts.push(...arcPoints(m.a, m.b, m.c, m.ccw).slice(1));
    else pts.push(m.b);
  }
  return pts;
}

/** 도면 형상 해석 → 비교용 목표 형상 */
export function parseTarget(text: string): { target: Target | null; error: Alarm | null } {
  const { moves, error } = drawingMoves(text);
  if (error) return { target: null, error };
  const pts = movePoints(moves);
  if (pts.length < 2) return { target: null, error: null };

  // 끝면(+Z) → 척(-Z) 방향으로 맞춘다
  const profile = pts[0].z >= pts[pts.length - 1].z ? pts : [...pts].reverse();
  const first = profile[0];
  const last = profile[profile.length - 1];
  const poly: Vec[] = [];
  if (first.r > 1e-6) poly.push({ z: first.z, r: 0 });
  poly.push(...profile);
  if (last.r > 1e-6) poly.push({ z: last.z, r: 0 });

  const concave: Vec[] = [];
  for (let i = 1; i < profile.length - 1; i++) {
    const a = profile[i - 1];
    const b = profile[i];
    const c = profile[i + 1];
    const d1 = { z: b.z - a.z, r: b.r - a.r };
    const d2 = { z: c.z - b.z, r: c.r - b.r };
    const s = (d1.z * d2.r - d1.r * d2.z) / (Math.hypot(d1.z, d1.r) * Math.hypot(d2.z, d2.r));
    if (s < -Math.sin((20 * Math.PI) / 180)) concave.push(b);
  }
  // 도면이 끝나는 곳(척 쪽)은 소재가 계속 이어지므로 오목 모서리와 같다
  concave.push(last);
  return {
    target: {
      profile,
      region: toPath(poly),
      zMin: Math.min(...profile.map((p) => p.z)),
      zMax: Math.max(...profile.map((p) => p.z)),
      concave,
    },
    error: null,
  };
}

function distToPolyline(p: Vec, line: Vec[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const dz = b.z - a.z;
    const dr = b.r - a.r;
    const l2 = dz * dz + dr * dr;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.z - a.z) * dz + (p.r - a.r) * dr) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.z - (a.z + t * dz), p.r - (a.r + t * dr)));
  }
  return best;
}

/** 나사를 깎은 Z 구간 (톱니 모양이라 도면과 비교하지 않는다) */
export function threadRanges(prog: Program): [number, number][] {
  const out: [number, number][] = [];
  for (const s of prog.segments) {
    if (s.kind !== 'thread') continue;
    const zs = s.pts.map((p) => p.z);
    const lo = Math.min(...zs) - 2;
    const hi = Math.max(...zs) + 2;
    const hit = out.find(([a, b]) => lo <= b && hi >= a);
    if (hit) {
      hit[0] = Math.min(hit[0], lo);
      hit[1] = Math.max(hit[1], hi);
    } else out.push([lo, hi]);
  }
  return out;
}

/**
 * 깎인 소재와 도면 비교.
 * excess = 도면보다 남은 살, over = 도면 안쪽까지 깎인 과삭.
 * cornerTol: 오목 모서리 근처는 노즈 반경 때문에 남는 살이라 무시하는 거리.
 */
export function compareStock(stock: Paths, t: Target, excluded: [number, number][], cornerTol: number): CompareResult {
  let windowP: Paths = [rect(t.zMin, t.zMax + 100, -1, 1000)];
  for (const [a, b] of excluded) windowP = difference(windowP, [rect(a, b, -2, 1001)]);
  const stockW = intersection(stock, windowP);
  const regionW = intersection([t.region], windowP);
  const keep = (ps: Paths) => ps.filter((p) => areaOf(p) > 1e-4);
  const excess = keep(difference(stockW, [t.region]));
  const over = keep(difference(regionW, stock));

  const measure = (ps: Paths, skipCorners: boolean) => {
    let max = 0;
    let at: Vec | null = null;
    for (const p of ps)
      for (const v of fromPath(p)) {
        if (skipCorners && t.concave.some((c) => dist(c, v) <= cornerTol)) continue;
        const d = distToPolyline(v, t.profile);
        if (d > max) {
          max = d;
          at = v;
        }
      }
    return { max, at };
  };
  const e = measure(excess, true);
  const o = measure(over, false);
  return { excess, over, maxExcess: e.max, maxOver: o.max, excessAt: e.at, overAt: o.at, excluded };
}
