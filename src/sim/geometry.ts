import ClipperLib, { type Path, type Paths } from 'clipper-lib';
import type { Vec } from '../nc/types';

/** 1mm = 1000 정수 단위 (1µm 분해능) */
export const SCALE = 1000;

export type { Path, Paths };

export const toPath = (pts: Vec[]): Path => pts.map((p) => ({ X: Math.round(p.z * SCALE), Y: Math.round(p.r * SCALE) }));
export const fromPath = (p: Path): Vec[] => p.map((q) => ({ z: q.X / SCALE, r: q.Y / SCALE }));

export const translate = (poly: Vec[], d: Vec): Vec[] => poly.map((p) => ({ z: p.z + d.z, r: p.r + d.r }));

/** 볼록 껍질 (Andrew monotone chain), 반시계 방향 */
export function hull(points: Vec[]): Vec[] {
  const pts = [...points].sort((a, b) => a.z - b.z || a.r - b.r);
  if (pts.length < 3) return pts;
  const cross = (o: Vec, a: Vec, b: Vec) => (a.z - o.z) * (b.r - o.r) - (a.r - o.r) * (b.z - o.z);
  const lower: Vec[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function clip(type: number, subj: Paths, cl: Paths): Paths {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(cl, ClipperLib.PolyType.ptClip, true);
  const out: Paths = [];
  c.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}

export function difference(subj: Paths, cl: Paths): Paths {
  const out = clip(ClipperLib.ClipType.ctDifference, subj, cl);
  return ClipperLib.Clipper.CleanPolygons(out, 1.5).filter((p) => p.length >= 3);
}

/** 겹치는 면적 (mm²) */
export function intersectArea(subj: Paths, cl: Paths): number {
  const out = clip(ClipperLib.ClipType.ctIntersection, subj, cl);
  let a = 0;
  for (const p of out) a += ClipperLib.Clipper.Area(p);
  return Math.abs(a) / (SCALE * SCALE);
}

export interface Box {
  minZ: number;
  maxZ: number;
  minR: number;
  maxR: number;
}

export function bounds(polys: Vec[][]): Box {
  const b: Box = { minZ: Infinity, maxZ: -Infinity, minR: Infinity, maxR: -Infinity };
  for (const poly of polys)
    for (const p of poly) {
      b.minZ = Math.min(b.minZ, p.z);
      b.maxZ = Math.max(b.maxZ, p.z);
      b.minR = Math.min(b.minR, p.r);
      b.maxR = Math.max(b.maxR, p.r);
    }
  return b;
}

export const boxOverlap = (a: Box, b: Box) => a.minZ < b.maxZ && b.minZ < a.maxZ && a.minR < b.maxR && b.minR < a.maxR;

export function intersection(subj: Paths, cl: Paths): Paths {
  return clip(ClipperLib.ClipType.ctIntersection, subj, cl).filter((p) => p.length >= 3);
}

export const areaOf = (p: Path) => Math.abs(ClipperLib.Clipper.Area(p)) / (SCALE * SCALE);

export const rect = (minZ: number, maxZ: number, minR: number, maxR: number): Path =>
  toPath([
    { z: minZ, r: minR },
    { z: maxZ, r: minR },
    { z: maxZ, r: maxR },
    { z: minZ, r: maxR },
  ]);
