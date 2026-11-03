import type { Alarm, Program, Segment, Vec } from '../nc/types';
import { toolShape, type ToolDef } from '../machine/tools';
import { bounds, boxOverlap, difference, fromPath, hull, intersectArea, toPath, translate, type Box, type Paths } from './geometry';

export interface StockConfig {
  /** 소재 지름 Ø */
  diameter: number;
  /** 소재 전체 길이 */
  length: number;
  /** 척에 물린 길이 */
  grip: number;
  /** 끝면 가공 여유 (Z0 보다 +쪽으로 남은 소재) */
  faceAllowance: number;
}

/** 척 끝면에서 Z0 까지 거리 (= 전체 길이 - 물림 - 끝면 여유) */
export const protrusionOf = (s: StockConfig) => s.length - s.grip - s.faceAllowance;

/** 예전 저장 형식(protrusion)도 읽는다 */
export function normalizeStock(s: Partial<StockConfig> & { protrusion?: number }): StockConfig {
  const diameter = s.diameter ?? 50;
  const faceAllowance = s.faceAllowance ?? 1;
  const grip = s.grip ?? 20;
  const length = s.length ?? (s.protrusion ?? 70) + grip + faceAllowance;
  return { diameter, length, grip, faceAllowance };
}

/** 척 조(jaw)가 차지하는 영역 */
export function chuckBox(s: StockConfig): Box {
  const p = protrusionOf(s);
  return { minZ: -p - Math.max(s.grip, 10), maxZ: -p, minR: -1, maxR: s.diameter / 2 + 25 };
}

// 공구 형상 때문에 생기는 0.1mm 미만의 스침은 무시하고, 실제 충돌만 알람
const RAPID_HIT_AREA = 0.5; // mm²

const lerp = (a: Vec, b: Vec, t: number): Vec => ({ z: a.z + (b.z - a.z) * t, r: a.r + (b.r - a.r) * t });
const dist = (a: Vec, b: Vec) => Math.hypot(b.z - a.z, b.r - a.r);

/** 시간 t 에서의 세그먼트 인덱스 (start <= t 인 마지막) */
export function segmentAt(prog: Program, t: number): number {
  const s = prog.segments;
  let lo = 0;
  let hi = s.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 세그먼트 내부 시간(local)에서 공구 위치 */
export function posInSegment(s: Segment, local: number): Vec {
  const { pts, times } = s;
  if (pts.length === 1 || local <= 0) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (local <= times[i]) {
      const span = times[i] - times[i - 1];
      return lerp(pts[i - 1], pts[i], span > 0 ? (local - times[i - 1]) / span : 1);
    }
  }
  return pts[pts.length - 1];
}

/**
 * 소재 절삭 시뮬레이션.
 * 소재를 Z–반경 평면의 2D 단면 다각형으로 보고, 공구 인서트가 지나간 영역(볼록 껍질)을 빼낸다.
 */
export class CutSim {
  stock: Paths = [];
  version = 0;
  time = 0;
  private stockBox!: Box;
  private shapes = new Map<number, Vec[]>();
  private segIdx = 0;
  private edgeIdx = 1;
  private lastPt: Vec | null = null;
  private travel = 0;
  private nextStamp = 0;

  constructor(
    private prog: Program,
    private stockCfg: StockConfig,
    tools: ToolDef[],
  ) {
    for (const t of tools) this.shapes.set(t.no, toolShape(t));
    this.reset();
  }

  reset() {
    const { diameter, length, faceAllowance } = this.stockCfg;
    const R = diameter / 2;
    const back = faceAllowance - length;
    this.stock = [
      toPath([
        { z: back, r: 0 },
        { z: faceAllowance, r: 0 },
        { z: faceAllowance, r: R },
        { z: back, r: R },
      ]),
    ];
    this.updateBox();
    this.segIdx = 0;
    this.edgeIdx = 1;
    this.lastPt = null;
    this.time = 0;
    this.version++;
  }

  shapeFor(tool: number): Vec[] | undefined {
    return this.shapes.get(tool);
  }

  get done() {
    return this.segIdx >= this.prog.segments.length;
  }

  /** 절대 시간 t 까지 절삭을 진행. 충돌하면 알람을 돌려주고 그 자리에서 멈춘다. */
  advanceTo(t: number): Alarm | null {
    const segs = this.prog.segments;
    while (this.segIdx < segs.length) {
      const s = segs[this.segIdx];
      if (s.start > t) break;
      const local = t - s.start;
      const shape = this.shapes.get(s.tool);
      const moving = s.kind === 'rapid' || s.kind === 'feed' || s.kind === 'thread';
      if (moving && shape) {
        if (!this.lastPt) {
          this.lastPt = s.pts[0];
          this.travel = 0;
          this.nextStamp = 0;
        }
        while (this.edgeIdx < s.pts.length) {
          const t0 = s.times[this.edgeIdx - 1];
          const t1 = s.times[this.edgeIdx];
          const full = local >= t1;
          const a = s.pts[this.edgeIdx - 1];
          const b = s.pts[this.edgeIdx];
          const p = full ? b : lerp(a, b, t1 > t0 ? (local - t0) / (t1 - t0) : 1);
          const alarm = this.move(s, shape, this.lastPt, p);
          this.lastPt = p;
          if (alarm) {
            this.time = s.start + (full ? t1 : local);
            this.segIdx = segs.length;
            return alarm;
          }
          if (!full) {
            this.time = t;
            return null;
          }
          this.edgeIdx++;
        }
      } else if (local < s.duration) {
        this.time = t;
        return null;
      }
      this.segIdx++;
      this.edgeIdx = 1;
      this.lastPt = null;
    }
    this.time = t;
    return null;
  }

  private move(s: Segment, shape: Vec[], a: Vec, b: Vec): Alarm | null {
    if (s.kind === 'thread') {
      // 나사: 리드 간격마다 공구 형상을 찍어 단면의 톱니 모양을 만든다
      const len = dist(a, b);
      const t0 = this.travel;
      this.travel += len;
      while (this.nextStamp <= this.travel + 1e-9) {
        const f = len > 0 ? (this.nextStamp - t0) / len : 0;
        this.cut(translate(shape, lerp(a, b, Math.min(Math.max(f, 0), 1))));
        this.nextStamp += s.pitch;
      }
      return null;
    }
    if (dist(a, b) < 1e-6) return null;
    const sweep = hull([...translate(shape, a), ...translate(shape, b)]);
    const box = bounds([sweep]);
    const chuck = chuckBox(this.stockCfg);
    if (boxOverlap(box, chuck)) {
      const c = toPath([
        { z: chuck.minZ, r: chuck.minR },
        { z: chuck.maxZ, r: chuck.minR },
        { z: chuck.maxZ, r: chuck.maxR },
        { z: chuck.minZ, r: chuck.maxR },
      ]);
      if (intersectArea([toPath(sweep)], [c]) > 0.01)
        return alarmAt(s, 'SIM03', '공구가 척(Chuck)과 충돌했습니다');
    }
    if (s.kind === 'rapid') {
      if (boxOverlap(box, this.stockBox) && intersectArea(this.stock, [toPath(sweep)]) > RAPID_HIT_AREA) {
        this.cut(sweep);
        return alarmAt(s, 'SIM02', '급속이송(G00) 중에 공작물과 충돌했습니다');
      }
      return null;
    }
    this.cut(sweep, box);
    return null;
  }

  private cut(poly: Vec[], box = bounds([poly])) {
    if (!boxOverlap(box, this.stockBox)) return;
    this.stock = difference(this.stock, [toPath(poly)]);
    this.updateBox();
    this.version++;
  }

  private updateBox() {
    this.stockBox = bounds(this.stock.map(fromPath));
  }
}

function alarmAt(s: Segment, code: string, message: string): Alarm {
  return { code, message, line: s.line, level: 'alarm' };
}
