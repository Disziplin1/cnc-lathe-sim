/**
 * DXF 도면 → 도면(목표 형상) 텍스트.
 * 선반 부품은 중심선(축) 기준으로 위아래가 같으므로, 축 위쪽 바깥 외곽선만 따라간다.
 * 외곽선은 LINE / ARC / LWPOLYLINE / POLYLINE 만 읽는다. 치수·문자·해치는 나사(M6)·널링(KNURLING) 글자를 찾을 때만 쓴다.
 */

import { coarsePitch, knurlLine, threadLine } from './features';

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
  /** 글자(M6, KNURLING 등)로 찾아서 도면 끝에 적어 준 나사 · 널링 줄 수 */
  threads: number;
  knurls: number;
  /** 척 쪽 끝이 뾰족해서(축까지 내려와서) 끝면 방향을 반대로 바꿨음 */
  flipped: boolean;
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
/** 숨은선(파선): 단면이 아닌 도면에서는 구멍(내경)이 숨은선으로 그려지므로 외곽선처럼 읽는다 */
const isHidden = (style: string) => /hidden|숨은|dash/i.test(style) && !CENTER.test(style) && !/dim|치수|hatch|해치|text|문자/i.test(style);

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
    if (Number.isNaN(code)) {
      const text = lines[i].trim().slice(0, 30);
      throw new Error(`DXF ${i + 1}번째 줄을 읽을 수 없습니다 ('${text}'). ASCII DXF 로 다시 저장해 주세요`);
    }
    const val = lines[i + 1].trim();
    // AutoCAD 처럼 EOF 에서 멈춘다 (뒤에 남은 찌꺼기는 무시)
    if (code === 0 && val === 'EOF') break;
    pairs.push([code, val]);
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
  /** 나사 골지름 선을 찾기 위한 모든 직선 (숨은선 · 가는선 포함) */
  allLines: { a: P; b: P }[];
  /** 문자 · 치수 문자 */
  texts: { text: string; p: P }[];
  /** 해치 가운데 · 지시선 화살표 끝 */
  marks: P[];
  /** 지시선: 화살표 끝(tip) 과 글자 쪽 끝(tail) */
  leaders: { tip: P; tail: P }[];
}

/** MTEXT 서식 코드 지우기 (글꼴·크기 지정, 중괄호, 줄바꿈), %%c → Ø */
function plainText(t: string): string {
  return t
    .replace(/\\P/gi, ' ')
    .replace(/\\[A-Za-z][^;\\]*;/g, '')
    .replace(/[{}]/g, '')
    .replace(/%%c/gi, 'Ø')
    .replace(/%%d/gi, '°')
    .trim();
}

function toPrims(src: string): Parsed {
  const { entities, layerType, inch } = readEntities(src);
  const k = inch ? 25.4 : 1;
  const prims: Prim[] = [];
  let axis: { y: number; len: number } | null = null;
  const allLines: Parsed['allLines'] = [];
  const texts: Parsed['texts'] = [];
  const marks: P[] = [];
  const leaders: Parsed['leaders'] = [];

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
      allLines.push({ a, b });
      if (SKIP.test(style) && !isHidden(style)) {
        const len = Math.abs(b.x - a.x);
        if (CENTER.test(style) && Math.abs(b.y - a.y) < EPS && (!axis || len > axis.len)) axis = { y: a.y, len };
        continue;
      }
      if (Math.hypot(b.x - a.x, b.y - a.y) > EPS) prims.push({ kind: 'line', a, b });
    } else if (e.type === 'ARC') {
      if (SKIP.test(style) && !isHidden(style)) continue;
      const c = { x: fx * num(e, 10) * k, y: num(e, 20) * k };
      const r = num(e, 40) * k;
      let a0 = (num(e, 50) * Math.PI) / 180;
      let a1 = (num(e, 51) * Math.PI) / 180;
      // 거울상이면 각도도 뒤집히고 방향이 바뀐다
      if (fx < 0) [a0, a1] = [Math.PI - a1, Math.PI - a0];
      while (a1 <= a0 + 1e-12) a1 += TAU;
      prims.push({ kind: 'arc', c, r, a0, a1 });
    } else if (e.type === 'LWPOLYLINE') {
      if (SKIP.test(style) && !isHidden(style)) continue;
      const closed = (num(e, 70) & 1) === 1;
      const vs: { p: P; bulge: number }[] = [];
      for (const [c, v] of e.codes) {
        if (c === 10) vs.push({ p: { x: fx * parseFloat(v) * k, y: 0 }, bulge: 0 });
        else if (c === 20 && vs.length) vs[vs.length - 1].p.y = parseFloat(v) * k;
        else if (c === 42 && vs.length) vs[vs.length - 1].bulge = fx * parseFloat(v);
      }
      pushPoly(prims, vs, closed);
    } else if (e.type === 'POLYLINE') {
      if (SKIP.test(style) && !isHidden(style)) continue;
      const closed = (num(e, 70) & 1) === 1;
      const vs: { p: P; bulge: number }[] = [];
      for (let j = i + 1; j < entities.length && entities[j].type === 'VERTEX'; j++) {
        const v = entities[j];
        vs.push({ p: { x: fx * num(v, 10) * k, y: num(v, 20) * k }, bulge: fx * num(v, 42) });
      }
      pushPoly(prims, vs, closed);
    } else if (e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'DIMENSION') {
      // MTEXT 는 긴 글이 3 번 코드로 나뉘어 온다 (치수의 3 번은 치수 스타일 이름)
      const codes = e.type === 'MTEXT' ? [3, 1] : [1];
      const raw = e.codes.filter(([c]) => codes.includes(c)).map(([, v]) => v).join('');
      const text = plainText(raw);
      if (!text) continue;
      // 치수는 문자 위치(11/21), 문자는 삽입점(10/20)
      const [cx, cy] = e.type === 'DIMENSION' ? [11, 21] : [10, 20];
      texts.push({ text, p: { x: fx * num(e, cx) * k, y: num(e, cy) * k } });
    } else if (e.type === 'MULTILEADER') {
      // 다중 지시선: 첫 304 = 글자, 첫 10/20 = 글자 위치.
      // "LEADER{" 다음 점 = 글자 쪽 끝, "LEADER_LINE{" 다음 점 = 화살표 끝
      const pt = (from: number): P | null => {
        const i = e.codes.findIndex(([c], j) => j > from && c === 10);
        const j = e.codes.findIndex(([c], jj) => jj > i && c === 20);
        return i < 0 || j < 0 ? null : { x: fx * parseFloat(e.codes[i][1]) * k, y: parseFloat(e.codes[j][1]) * k };
      };
      const first304 = e.codes.find(([c]) => c === 304)?.[1] ?? '';
      const text = /\{$/.test(first304) ? '' : plainText(first304);
      const p = pt(-1);
      if (p && text) texts.push({ text, p });
      const tail = pt(e.codes.findIndex(([c, v]) => c === 302 && v === 'LEADER{'));
      const tip = pt(e.codes.findIndex(([c, v]) => c === 304 && v === 'LEADER_LINE{'));
      if (tip) marks.push(tip);
      if (tip && tail) leaders.push({ tip, tail });
    } else if (e.type === 'LEADER') {
      // 첫 꼭짓점 = 화살표 끝, 마지막 꼭짓점 = 글자 쪽
      const vs: P[] = [];
      for (const [c, v] of e.codes) {
        if (c === 10) vs.push({ x: fx * parseFloat(v) * k, y: 0 });
        else if (c === 20 && vs.length) vs[vs.length - 1].y = parseFloat(v) * k;
      }
      if (vs.length) {
        marks.push(vs[0]);
        leaders.push({ tip: vs[0], tail: vs[vs.length - 1] });
      }
    } else if (e.type === 'HATCH') {
      // 첫 10/20 은 높이 기준점이라 빼고, 경계 점들의 가운데
      const xs: number[] = [];
      const ys: number[] = [];
      let first = true;
      for (const [c, v] of e.codes) {
        if (c === 10) {
          if (first) {
            first = false;
            continue;
          }
          xs.push(fx * parseFloat(v) * k);
        } else if (c === 20 && xs.length > ys.length) ys.push(parseFloat(v) * k);
      }
      if (xs.length && ys.length)
        marks.push({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 });
    }
  }
  return { prims, axis: axis ? axis.y : null, allLines, texts, marks, leaders };
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

/**
 * DXF → 도면 텍스트. 고른 방향으로 읽었는데 척 쪽 끝이 축까지 내려와 뾰족하면(물 수 없음)
 * 반대 방향이 물 수 있는 모양일 때 끝면 방향을 바꿔서 돌려준다.
 */
export function dxfToTarget(src: string, opt: DxfOptions = {}): DxfImport {
  const r = convert(src, opt);
  if (r.chuckR < 0.5) {
    try {
      const other = convert(src, { ...opt, faceLeft: !opt.faceLeft });
      if (other.chuckR >= 0.5) return { ...other.result, flipped: true };
    } catch {
      // 반대 방향으로 못 읽으면 고른 방향 그대로
    }
  }
  return { ...r.result, flipped: false };
}

function convert(src: string, opt: DxfOptions): { result: Omit<DxfImport, 'flipped'>; chuckR: number } {
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
  // T자로 나뉜 직선(나사 끝 선 등이 닿은 곳)은 한 줄로 다시 잇는다
  const mergeLines = (edges: Edge[]) => {
    const merged: Edge[] = [];
    for (const e of edges) {
      const last = merged[merged.length - 1];
      if (last && last.prim.kind === 'line' && e.prim.kind === 'line') {
        const [p, q, r] = [nodes[last.from], nodes[last.to], nodes[e.to]];
        const cross = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
        const dot = (q.x - p.x) * (r.x - q.x) + (q.y - p.y) * (r.y - q.y);
        if (Math.abs(cross) < EPS * EPS && dot > 0) {
          merged[merged.length - 1] = { prim: { kind: 'line', a: p, b: r }, rev: false, from: last.from, to: e.to };
          continue;
        }
      }
      merged.push(e);
    }
    return merged;
  };
  const outline = mergeLines(path.slice(0, cut + 1));

  // 내경: 끝면에서 왼쪽(척 쪽)으로 들어가는 선이 있는 가장 낮은 점에서 출발해
  // 재료를 오른쪽(위)에 두고 가장 왼쪽 길을 따라간다 → 구멍 바닥(축) 또는 척 쪽 끝까지
  const outlinePrims = new Set(path.slice(0, cut + 1).map((e) => e.prim));
  const faceNodeX = nodes[start].x;
  const intoHole = (e: Edge) => !outlinePrims.has(e.prim) && startDir(e).x < -0.3;
  const innerStarts = nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n, i }) => Math.abs(n.x - faceNodeX) < EPS && n.y > axis + EPS && (adj.get(i) ?? []).some(intoHole))
    .sort((a, b) => a.n.y - b.n.y);
  let innerPath: Edge[] = [];
  if (innerStarts.length) {
    const s = innerStarts[0].i;
    const iused = new Set<Prim>(outlinePrims);
    let at = s;
    let dir: P = { x: 0, y: -1 };
    const walk: Edge[] = [];
    for (let guard = 0; guard < prims.length + 1; guard++) {
      let outs = (adj.get(at) ?? []).filter((e) => !iused.has(e.prim));
      if (!outs.length) break;
      // 숨은선 도면에서는 구멍 단차·모따기 모서리가 축을 가로지르는 세로선으로 보인다.
      // 축으로 내려가는 선은 다른 길이 없을 때(막힌 구멍 바닥)만 탄다
      const offAxis = outs.filter((e) => Math.abs(nodes[e.to].y - axis) >= EPS);
      if (offAxis.length) outs = offAxis;
      // 왼쪽으로 가장 많이 꺾는 길 (되돌아가는 길은 가장 나중)
      const left = (e: Edge) => {
        const t = rightTurn(dir, startDir(e));
        return t === -Math.PI ? -Math.PI : -t;
      };
      const next = outs.reduce((best, e) => (left(e) > left(best) ? e : best));
      iused.add(next.prim);
      walk.push(next);
      dir = endDir(next);
      at = next.to;
      if (Math.abs(nodes[at].y - axis) < EPS || Math.abs(nodes[at].x - minX) < EPS || at === s) break;
    }
    // 축(구멍 바닥 가운데)이나 척 쪽 끝에 닿아야 구멍으로 본다
    const end = walk.length ? nodes[walk[walk.length - 1].to] : null;
    if (end && (Math.abs(end.y - axis) < EPS || Math.abs(end.x - minX) < EPS)) innerPath = mergeLines(walk);
  }

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
  const emit = (edges: Edge[]) => {
    for (const e of edges) {
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
  };
  out.push(word(s0));
  emit(outline);
  if (innerPath.length) {
    out.push('(내경)', word(nodes[innerPath[0].from]));
    emit(innerPath);
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

  // 글자로 나사 · 널링 찾기 → 도면 끝에 줄로 적는다 (틀리면 그 줄만 고치면 됨)
  const sx = opt.faceLeft ? -1 : 1;
  const toZ = (q: P) => sx * q.x - faceX;
  const toR = (q: P) => Math.abs(q.y - axis);
  // 외곽선 중 Z 방향 직선 (지름이 일정한 구간)
  const zLines = outline
    .filter((e) => e.prim.kind === 'line' && Math.abs(nodes[e.from].y - nodes[e.to].y) < EPS)
    .map((e) => {
      const [a, b] = [nodes[e.from].x - faceX, nodes[e.to].x - faceX];
      return { z0: Math.max(a, b), z1: Math.min(a, b), r: nodes[e.from].y - axis };
    });
  const innerZLines = innerPath
    .filter((e) => e.prim.kind === 'line' && Math.abs(nodes[e.from].y - nodes[e.to].y) < EPS && nodes[e.from].y > axis + EPS)
    .map((e) => {
      const [a, b] = [nodes[e.from].x - faceX, nodes[e.to].x - faceX];
      return { z0: Math.max(a, b), z1: Math.min(a, b), r: nodes[e.from].y - axis };
    });
  const gapTo = (z: number, l: { z0: number; z1: number }) => (z > l.z0 ? z - l.z0 : z < l.z1 ? l.z1 - z : 0);
  const notes: string[] = [];
  const seen = new Set<string>();
  let threads = 0;
  for (const t of parsed.texts) {
    const m = /(?:^|[^A-Z0-9])M(\d+(?:\.\d+)?)(?:\s*[xX×*]\s*(\d+(?:\.\d+)?))?/.exec(t.text);
    if (!m) continue;
    const dia = parseFloat(m[1]);
    const pitch = m[2] ? parseFloat(m[2]) : coarsePitch(dia);
    if (!pitch) continue;
    // 수나사: 외경이 호칭 지름 / 암나사: 구멍(내경)이 안지름(호칭 - 1.0825P)
    let inner = false;
    let cands = zLines.filter((l) => Math.abs(2 * l.r - dia) <= Math.max(0.6, dia * 0.06));
    if (!cands.length) {
      const minorDia = dia - 1.0825 * pitch;
      cands = innerZLines.filter((l) => Math.abs(2 * l.r - minorDia) <= Math.max(0.6, dia * 0.08));
      inner = true;
    }
    if (!cands.length) continue;
    const z = toZ(t.p);
    const seg = cands.reduce((best, l) => (gapTo(z, l) < gapTo(z, best) ? l : best));
    // 나사 길이: 구간 안의 가는 선(수나사는 골지름, 암나사는 바깥지름)이 있으면 그 길이, 없으면 구간 전체
    const rThin = inner ? dia / 2 : dia / 2 - 0.6134 * pitch;
    let z0 = seg.z0;
    let z1 = seg.z1;
    const thin = parsed.allLines
      .filter(
        (l) =>
          Math.abs(l.a.y - l.b.y) < EPS &&
          Math.abs(toR(l.a) - rThin) <= Math.max(0.5 * pitch, 0.08 * dia) &&
          (inner ? toR(l.a) > seg.r + 0.05 : toR(l.a) < seg.r - 0.05),
      )
      .map((l) => ({ hi: Math.min(seg.z0, Math.max(toZ(l.a), toZ(l.b))), lo: Math.max(seg.z1, Math.min(toZ(l.a), toZ(l.b))) }))
      .filter((l) => l.hi - l.lo > EPS);
    if (thin.length) {
      const best = thin.reduce((x, y) => (y.hi - y.lo > x.hi - x.lo ? y : x));
      // 나사 끝 모따기 때문에 가는 선이 구간 끝보다 조금 짧으면 구간 끝까지
      z0 = seg.z0 - best.hi < 2 * pitch ? seg.z0 : best.hi;
      z1 = best.lo;
    }
    // 끝면 모따기 안쪽에서 시작하면 끝면(Z0)부터
    if (z0 < 0 && z0 > -2 * pitch) z0 = 0;
    const line = threadLine({ dia, pitch, z0, z1, inner });
    if (!seen.has(line)) {
      seen.add(line);
      notes.push(line);
      threads++;
    }
  }
  let knurls = 0;
  const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
  // 지시선은 글자 쪽 끝이 가장 가까운 글자의 것으로 본다
  const owner = (l: { tail: P }) => parsed.texts.reduce((best, t) => (dist(l.tail, t.p) < dist(l.tail, best.p) ? t : best));
  for (const t of parsed.texts) {
    if (!/KNURL|널링|ローレット/i.test(t.text)) continue;
    if (!zLines.length) continue;
    // 이 글자의 지시선 화살표가 가리키는 곳마다 (화살표가 여러 개면 여러 곳).
    // 지시선이 없으면 가장 가까운 해치 · 화살표, 그것도 없으면 글자 위치
    let points = parsed.leaders.filter((l) => owner(l) === t && dist(l.tail, t.p) < 30).map((l) => l.tip);
    if (!points.length)
      points = [parsed.marks.length ? parsed.marks.reduce((best, q) => (dist(q, t.p) < dist(best, t.p) ? q : best)) : t.p];
    for (const q of points) {
      const z = toZ(q);
      const r = toR(q);
      // 해치·화살표는 일부만 표시하는 기호이므로 그 지름 구간 전체를 널링한다 (Z 가 걸치고 지름이 가까운 구간)
      const seg = zLines.reduce((best, l) => (gapTo(z, l) * 10 + Math.abs(l.r - r) < gapTo(z, best) * 10 + Math.abs(best.r - r) ? l : best));
      const line = knurlLine({ z0: seg.z0, z1: seg.z1 });
      if (!seen.has(line)) {
        seen.add(line);
        notes.push(line);
        knurls++;
      }
    }
  }
  const chuckR = outline.length ? nodes[outline[outline.length - 1].to].y - axis : 0;
  return { result: { text: [head, ...out, ...notes].join('\n') + '\n', maxDia, length, lines, arcs, threads, knurls }, chuckR };
}
