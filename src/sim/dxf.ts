/**
 * DXF 도면 → 도면(목표 형상) 텍스트.
 * 선반 부품은 중심선(축) 기준으로 위아래가 같으므로, 축 위쪽 바깥 외곽선만 따라간다.
 * LINE / ARC / LWPOLYLINE / POLYLINE 만 읽고, 치수·문자·해치·중심선·숨은선은 무시한다.
 */

interface P {
  x: number;
  y: number;
}

/** 선분, 또는 시작각 a0 → 끝각 a1 반시계 원호 (라디안, a1 > a0) */
type Prim = { kind: 'line'; a: P; b: P } | { kind: 'arc'; c: P; r: number; a0: number; a1: number };

export interface DxfImport {
  text: string;
  /** 최대 직경 */
  maxDia: number;
  /** 끝면 ~ 척 쪽 끝 길이 */
  length: number;
  lines: number;
  arcs: number;
}

export interface DxfOptions {
  /** 끝면(Z0)이 도면의 왼쪽에 있으면 true (기본은 오른쪽 = 척이 왼쪽) */
  faceLeft?: boolean;
  name?: string;
}

const EPS = 1e-3;
const TAU = Math.PI * 2;
/** 외곽선이 아닌 선 (레이어 이름 또는 선 종류) */
const SKIP = /center|hidden|phantom|dash|dot|중심|숨은|가상|dim|치수|hatch|해치|text|문자/i;
const CENTER = /center|dashdot|dash.?dot|중심|1점/i;

interface RawEntity {
  type: string;
  codes: [number, string][];
}

/** 코드/값 쌍을 엔티티 단위로 묶는다 */
function readEntities(src: string): { entities: RawEntity[]; layerType: Map<string, string>; inch: boolean } {
  if (src.startsWith('AutoCAD Binary DXF')) throw new Error('바이너리 DXF 는 읽을 수 없습니다. ASCII DXF 로 저장해 주세요');
  if (!/^\s*0\s*\r?\n\s*SECTION/m.test(src)) throw new Error('DXF 형식이 아닙니다');
  const lines = src.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) throw new Error('DXF 형식이 아닙니다 (ASCII DXF 만 읽을 수 있습니다)');
    pairs.push([code, lines[i + 1].trim()]);
  }

  const entities: RawEntity[] = [];
  const layerType = new Map<string, string>();
  let inch = false;
  let section = '';
  let cur: RawEntity | null = null;
  for (let i = 0; i < pairs.length; i++) {
    const [code, val] = pairs[i];
    if (code === 0) {
      if (cur) entities.push(cur);
      cur = null;
      if (val === 'SECTION') {
        section = pairs[i + 1]?.[1] ?? '';
        continue;
      }
      if (val === 'ENDSEC') {
        section = '';
        continue;
      }
      if (section === 'ENTITIES' || (section === 'TABLES' && val === 'LAYER')) cur = { type: val, codes: [] };
      continue;
    }
    if (section === 'HEADER' && code === 9 && val === '$INSUNITS') inch = pairs[i + 1]?.[1] === '1';
    cur?.codes.push([code, val]);
  }
  if (cur) entities.push(cur);

  for (const e of entities.filter((x) => x.type === 'LAYER')) {
    const name = e.codes.find(([c]) => c === 2)?.[1];
    const lt = e.codes.find(([c]) => c === 6)?.[1];
    if (name) layerType.set(name, lt ?? '');
  }
  return { entities: entities.filter((x) => x.type !== 'LAYER'), layerType, inch };
}

const num = (e: RawEntity, code: number, def = 0) => {
  const v = e.codes.find(([c]) => c === code);
  return v ? parseFloat(v[1]) : def;
};

/** 볼록률(bulge)이 있는 폴리선 한 구간 */
function bulgeSeg(a: P, b: P, bulge: number): Prim {
  if (Math.abs(bulge) < 1e-9) return { kind: 'line', a, b };
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const theta = 4 * Math.atan(bulge);
  const r = d / (2 * Math.sin(Math.abs(theta) / 2));
  // 현의 중점에서 중심까지 (bulge > 0 이면 a→b 반시계)
  const h = r * Math.cos(Math.abs(theta) / 2);
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const n = { x: -(b.y - a.y) / d, y: (b.x - a.x) / d };
  const s = bulge > 0 ? 1 : -1;
  const sweepSmall = Math.abs(theta) <= Math.PI;
  const c = { x: m.x + s * (sweepSmall ? 1 : -1) * h * n.x, y: m.y + s * (sweepSmall ? 1 : -1) * h * n.y };
  const angA = Math.atan2(a.y - c.y, a.x - c.x);
  const angB = Math.atan2(b.y - c.y, b.x - c.x);
  // 반시계로 a0 → a1
  const [from, to] = bulge > 0 ? [angA, angB] : [angB, angA];
  let a1 = to;
  while (a1 <= from + 1e-12) a1 += TAU;
  return { kind: 'arc', c, r, a0: from, a1 };
}

interface Parsed {
  prims: Prim[];
  /** 중심선으로 보이는 수평선의 y */
  axis: number | null;
}

function toPrims(src: string): Parsed {
  const { entities, layerType, inch } = readEntities(src);
  const k = inch ? 25.4 : 1;
  const prims: Prim[] = [];
  let axis: { y: number; len: number } | null = null;

  const styleOf = (e: RawEntity) => {
    const layer = e.codes.find(([c]) => c === 8)?.[1] ?? '';
    let lt = e.codes.find(([c]) => c === 6)?.[1] ?? 'BYLAYER';
    if (/^bylayer$/i.test(lt)) lt = layerType.get(layer) ?? '';
    return `${layer} ${lt}`;
  };

  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    // 뒤집힌 좌표계 (extrusion Z = -1) 는 x 가 반대
    const fx = num(e, 230, 1) < 0 ? -1 : 1;
    const style = styleOf(e);
    if (e.type === 'LINE') {
      const a = { x: fx * num(e, 10) * k, y: num(e, 20) * k };
      const b = { x: fx * num(e, 11) * k, y: num(e, 21) * k };
      if (SKIP.test(style)) {
        const len = Math.abs(b.x - a.x);
        if (CENTER.test(style) && Math.abs(b.y - a.y) < EPS && (!axis || len > axis.len)) axis = { y: a.y, len };
        continue;
      }
      if (Math.hypot(b.x - a.x, b.y - a.y) > EPS) prims.push({ kind: 'line', a, b });
    } else if (e.type === 'ARC') {
      if (SKIP.test(style)) continue;
      const c = { x: fx * num(e, 10) * k, y: num(e, 20) * k };
      const r = num(e, 40) * k;
      let a0 = (num(e, 50) * Math.PI) / 180;
      let a1 = (num(e, 51) * Math.PI) / 180;
      // 거울상이면 각도도 뒤집히고 방향이 바뀐다
      if (fx < 0) [a0, a1] = [Math.PI - a1, Math.PI - a0];
      while (a1 <= a0 + 1e-12) a1 += TAU;
      prims.push({ kind: 'arc', c, r, a0, a1 });
    } else if (e.type === 'LWPOLYLINE') {
      if (SKIP.test(style)) continue;
      const closed = (num(e, 70) & 1) === 1;
      const vs: { p: P; bulge: number }[] = [];
      for (const [c, v] of e.codes) {
        if (c === 10) vs.push({ p: { x: fx * parseFloat(v) * k, y: 0 }, bulge: 0 });
        else if (c === 20 && vs.length) vs[vs.length - 1].p.y = parseFloat(v) * k;
        else if (c === 42 && vs.length) vs[vs.length - 1].bulge = fx * parseFloat(v);
      }
      pushPoly(prims, vs, closed);
    } else if (e.type === 'POLYLINE') {
      if (SKIP.test(style)) continue;
      const closed = (num(e, 70) & 1) === 1;
      const vs: { p: P; bulge: number }[] = [];
      for (let j = i + 1; j < entities.length && entities[j].type === 'VERTEX'; j++) {
        const v = entities[j];
        vs.push({ p: { x: fx * num(v, 10) * k, y: num(v, 20) * k }, bulge: fx * num(v, 42) });
      }
      pushPoly(prims, vs, closed);
    }
  }
  return { prims, axis: axis ? axis.y : null };
}

function pushPoly(prims: Prim[], vs: { p: P; bulge: number }[], closed: boolean) {
  const n = vs.length;
  for (let j = 0; j < (closed ? n : n - 1); j++) {
    const a = vs[j];
    const b = vs[(j + 1) % n];
    if (Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) > EPS) prims.push(bulgeSeg(a.p, b.p, a.bulge));
  }
}

const arcPt = (c: P, r: number, a: number): P => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
const ends = (p: Prim): [P, P] => (p.kind === 'line' ? [p.a, p.b] : [arcPt(p.c, p.r, p.a0), arcPt(p.c, p.r, p.a1)]);
const same = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y) < EPS;

/** 축이 어디인지: 중심선 → 위아래 대칭이면 가운데 → 아니면 맨 아래(반쪽만 그린 도면) */
function findAxis(prims: Prim[], centerLine: number | null): number {
  if (centerLine !== null) return centerLine;
  const pts = prims.flatMap(ends);
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const mid = (minY + maxY) / 2;
  const mirrored = pts.filter((p) => pts.some((q) => same(q, { x: p.x, y: 2 * mid - p.y }))).length;
  return mirrored >= pts.length * 0.8 ? mid : minY;
}

/** 다른 선의 끝점이 선 중간에 닿으면(T자) 그 점에서 나눈다. 축을 가로지르는 선도 나눈다 */
function splitPrims(prims: Prim[], axis: number): Prim[] {
  const cuts = prims.flatMap(ends);
  const out: Prim[] = [];
  for (const p of prims) {
    if (p.kind === 'line') {
      const { a, b } = p;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ts = new Set<number>();
      for (const q of cuts) {
        const t = ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / (len * len);
        if (t * len < EPS || (1 - t) * len < EPS) continue;
        const foot = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
        if (same(foot, q)) ts.add(t);
      }
      if ((a.y - axis) * (b.y - axis) < 0) ts.add((axis - a.y) / (b.y - a.y));
      const sorted = [0, ...[...ts].sort((x, y) => x - y), 1];
      for (let i = 1; i < sorted.length; i++) {
        const at = (t: number) => ({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
        out.push({ kind: 'line', a: at(sorted[i - 1]), b: at(sorted[i]) });
      }
    } else {
      // 원호가 축을 지나면 축에서 나눈다 (구 모양 끝 등)
      const cut: number[] = [];
      if (Math.abs(axis - p.c.y) < p.r) {
        const s = Math.asin((axis - p.c.y) / p.r);
        for (const base of [s, Math.PI - s]) {
          // a0 이상 a0+2π 미만으로 맞춰서 원호 안에 있으면 자른다
          const a = p.a0 + ((((base - p.a0) % TAU) + TAU) % TAU);
          if (a > p.a0 + 1e-9 && a < p.a1 - 1e-9) cut.push(a);
        }
      }
      const sorted = [p.a0, ...cut.sort((x, y) => x - y), p.a1];
      for (let i = 1; i < sorted.length; i++) out.push({ ...p, a0: sorted[i - 1], a1: sorted[i] });
    }
  }
  return out;
}

interface Edge {
  prim: Prim;
  /** 원래 방향(a→b, 원호는 반시계)으로 가면 false */
  rev: boolean;
  from: number;
  to: number;
}

/** 출발할 때의 진행 방향 */
function startDir(e: Edge): P {
  const p = e.prim;
  if (p.kind === 'line') {
    const [s, t] = e.rev ? [p.b, p.a] : [p.a, p.b];
    const d = Math.hypot(t.x - s.x, t.y - s.y);
    return { x: (t.x - s.x) / d, y: (t.y - s.y) / d };
  }
  // 원호의 접선 (반시계면 +90°)
  const a = e.rev ? p.a1 : p.a0;
  const s = e.rev ? -1 : 1;
  return { x: -Math.sin(a) * s, y: Math.cos(a) * s };
}

/** 도착할 때의 진행 방향 */
function endDir(e: Edge): P {
  const p = e.prim;
  if (p.kind === 'line') return startDir(e);
  const a = e.rev ? p.a0 : p.a1;
  const s = e.rev ? -1 : 1;
  return { x: -Math.sin(a) * s, y: Math.cos(a) * s };
}

/** 오른쪽(시계 방향)으로 꺾는 각도. 위쪽 바깥 외곽선은 재료가 왼쪽에 있으므로 가장 오른쪽 길을 고른다 */
function rightTurn(inc: P, out: P): number {
  const cross = inc.x * out.y - inc.y * out.x;
  const dot = inc.x * out.x + inc.y * out.y;
  // 되돌아가는 길은 가장 나중에
  if (dot < -1 + 1e-9) return -Math.PI;
  return -Math.atan2(cross, dot);
}

export function dxfToTarget(src: string, opt: DxfOptions = {}): DxfImport {
  const parsed = toPrims(src);
  if (!parsed.prims.length) throw new Error('외곽선(LINE / ARC / POLYLINE)을 찾지 못했습니다. 블록으로 묶인 도면이면 분해(EXPLODE) 후 저장해 주세요.');
  const axis = findAxis(parsed.prims, parsed.axis);
  // 오른쪽이 끝면이 되도록 좌우를 맞춘다 (끝면이 왼쪽이면 거울상)
  let prims = parsed.prims;
  if (opt.faceLeft) {
    prims = prims.map((p) =>
      p.kind === 'line'
        ? { kind: 'line', a: { x: -p.a.x, y: p.a.y }, b: { x: -p.b.x, y: p.b.y } }
        : { kind: 'arc', c: { x: -p.c.x, y: p.c.y }, r: p.r, a0: Math.PI - p.a1, a1: Math.PI - p.a0 },
    );
  }
  // 같은 선을 두 번 그린 경우 하나만
  prims = prims.filter((p, i) => {
    const [a, b] = ends(p);
    return !prims.slice(0, i).some((q) => {
      if (q.kind !== p.kind) return false;
      const [c, d] = ends(q);
      return (same(a, c) && same(b, d)) || (same(a, d) && same(b, c));
    });
  });
  prims = splitPrims(prims, axis).filter((p) => {
    // 축 아래쪽 절반은 버린다
    const [a, b] = ends(p);
    const mid = p.kind === 'line' ? (a.y + b.y) / 2 : arcPt(p.c, p.r, (p.a0 + p.a1) / 2).y;
    return Math.min(a.y, b.y, mid) > axis - EPS;
  });
  if (!prims.length) throw new Error('축 위쪽에 외곽선이 없습니다');

  // 끝점을 묶어 그래프로
  const nodes: P[] = [];
  const nodeOf = (q: P) => {
    const i = nodes.findIndex((n) => same(n, q));
    if (i >= 0) return i;
    nodes.push(q);
    return nodes.length - 1;
  };
  const adj = new Map<number, Edge[]>();
  prims.forEach((prim) => {
    const [a, b] = ends(prim);
    const ia = nodeOf(a);
    const ib = nodeOf(b);
    if (ia === ib) return;
    adj.set(ia, [...(adj.get(ia) ?? []), { prim, rev: false, from: ia, to: ib }]);
    adj.set(ib, [...(adj.get(ib) ?? []), { prim, rev: true, from: ib, to: ia }]);
  });

  // 시작점: 오른쪽 끝면. 축 위의 가장 오른쪽 점 (구멍이 있으면 오른쪽 끝의 가장 낮은 점)
  const maxX = Math.max(...nodes.map((n) => n.x));
  const onAxis = nodes.map((n, i) => ({ n, i })).filter(({ n }) => Math.abs(n.y - axis) < EPS);
  const rightEnd = nodes.map((n, i) => ({ n, i })).filter(({ n }) => Math.abs(n.x - maxX) < EPS);
  const cand = onAxis.length && Math.max(...onAxis.map((c) => c.n.x)) > maxX - 1 ? onAxis : rightEnd;
  const start = cand.reduce((best, c) => (c.n.x > best.n.x + EPS || (Math.abs(c.n.x - best.n.x) < EPS && c.n.y < best.n.y) ? c : best)).i;

  const used = new Set<Prim>();
  const path: Edge[] = [];
  let at = start;
  let dir: P = { x: -1, y: 0 };
  for (let guard = 0; guard < prims.length + 1; guard++) {
    const outs = (adj.get(at) ?? []).filter((e) => !used.has(e.prim));
    if (!outs.length) break;
    const next = outs.reduce((best, e) => (rightTurn(dir, startDir(e)) > rightTurn(dir, startDir(best)) ? e : best));
    used.add(next.prim);
    path.push(next);
    dir = endDir(next);
    at = next.to;
    if (Math.abs(nodes[at].y - axis) < EPS || at === start) break;
  }
  if (!path.length) throw new Error('끝면에서 이어지는 외곽선을 찾지 못했습니다');

  // 척 쪽 끝(가장 왼쪽)에 처음 닿은 곳까지만. 그 뒤(척 쪽 끝면, 구멍 안쪽)는 버린다
  const minX = Math.min(...path.map((e) => nodes[e.to].x));
  const cut = path.findIndex((e) => Math.abs(nodes[e.to].x - minX) < EPS);
  const outline = path.slice(0, cut + 1);

  // 도면 좌표 → 선반 좌표 (Z = 끝면에서의 거리, X = 직경)
  const faceX = nodes[start].x;
  const fmt = (v: number) => {
    const r = Math.round(v * 1000) / 1000;
    const s = (Object.is(r, -0) ? 0 : r).toString();
    return s.includes('.') ? s : s + '.';
  };
  const word = (q: P) => `X${fmt(2 * (q.y - axis))} Z${fmt(q.x - faceX)}`;
  const out: string[] = [];
  const s0 = nodes[start];
  let lines = 0;
  let arcs = 0;
  out.push(word(s0));
  for (const e of outline) {
    const q = nodes[e.to];
    if (e.prim.kind === 'line') {
      out.push(`G01 ${word(q)}`);
      lines++;
    } else {
      // 도면 좌표의 반시계 = 선반(Z 오른쪽, X 위) 의 반시계 = G03
      const ccw = !e.rev;
      const sweep = e.prim.a1 - e.prim.a0;
      out.push(`${ccw ? 'G03' : 'G02'} ${word(q)} R${fmt(sweep > Math.PI ? -e.prim.r : e.prim.r)}`);
      arcs++;
    }
  }

  const pts = [s0, ...outline.map((e) => nodes[e.to])];
  const maxDia = 2 * Math.max(...pts.map((q) => q.y - axis), ...outline.filter((e) => e.prim.kind === 'arc').map((e) => {
    const p = e.prim as Extract<Prim, { kind: 'arc' }>;
    // 원호 꼭대기가 끝점보다 높을 수 있다
    const top = Math.PI / 2;
    const hit = [top, top + TAU, top - TAU].some((a) => a > p.a0 && a < p.a1);
    return hit ? p.c.y + p.r - axis : 0;
  }));
  const length = faceX - minX;
  const name = (opt.name ?? 'DXF').replace(/[()]/g, '');
  const head = `(${name} : 최대 지름 ${fmt(maxDia)} / 길이 ${fmt(length)})`;
  return { text: [head, ...out].join('\n') + '\n', maxDia, length, lines, arcs };
}
