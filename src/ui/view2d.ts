import type { Program, Vec } from '../nc/types';
import type { Paths } from '../sim/geometry';
import { SCALE } from '../sim/geometry';
import { chuckBox, protrusionOf, type StockConfig } from '../sim/simulator';
import { TOOL_COLOR, type ToolDef } from '../machine/tools';
import type { CompareResult, Target } from '../sim/compare';

export interface Frame2D {
  prog: Program;
  stock: Paths;
  stockCfg: StockConfig;
  tools: ToolDef[];
  time: number;
  toolPos: Vec | null;
  toolShape: Vec[] | null;
  toolNo: number;
  offset: Vec;
  compare: { target: Target; result: CompareResult | null } | null;
}

/** Z–X 평면 2D 화면 (가로 Z, 세로 반경). 공작물은 위/아래 대칭으로 그린다. */
export class View2D {
  private ctx: CanvasRenderingContext2D;
  private scale = 4; // px per mm
  private ox = 0;
  private oy = 0;
  private frame: Frame2D | null = null;
  private fitted = false;
  /** 사용자가 확대/이동했으면 크기가 바뀌어도 자동 맞춤하지 않는다 */
  private userMoved = false;
  private drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private onHover: (p: Vec | null) => void,
    private onPick: (line: number) => void,
  ) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = this.toWorld(e);
      this.onHover(p);
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
      this.userMoved = true;
      this.ox = this.drag.ox + dx;
      this.oy = this.drag.oy + dy;
      this.draw();
    });
    canvas.addEventListener('pointerup', (e) => {
      if (this.drag && !this.drag.moved) this.pick(this.toWorld(e));
      this.drag = null;
    });
    canvas.addEventListener('pointerleave', () => this.onHover(null));
  }

  private toWorld(e: MouseEvent): Vec {
    const rect = this.canvas.getBoundingClientRect();
    return { z: (e.clientX - rect.left - this.ox) / this.scale, r: -(e.clientY - rect.top - this.oy) / this.scale };
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    if (!this.fitted || !this.userMoved) this.fit();
    this.draw();
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    this.userMoved = true;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const k = Math.exp(-e.deltaY * 0.0015);
    const ns = Math.min(200, Math.max(0.3, this.scale * k));
    this.ox = mx - ((mx - this.ox) * ns) / this.scale;
    this.oy = my - ((my - this.oy) * ns) / this.scale;
    this.scale = ns;
    this.draw();
  }

  /** 소재 전체가 보이도록 맞춤 */
  fit() {
    const f = this.frame;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!f || !w || !h) return;
    const R = f.stockCfg.diameter / 2;
    const minZ = -protrusionOf(f.stockCfg) - 25;
    const maxZ = Math.max(f.stockCfg.faceAllowance, 0) + 20;
    const halfH = R + 18;
    this.scale = Math.min(w / (maxZ - minZ), h / (2 * halfH));
    this.ox = (w - (maxZ - minZ) * this.scale) / 2 - minZ * this.scale;
    this.oy = h / 2;
    this.fitted = true;
    this.userMoved = false;
    this.draw();
  }

  setFrame(f: Frame2D) {
    const first = !this.frame;
    this.frame = f;
    if (first) this.fit();
    this.draw();
  }

  private pick(p: Vec) {
    const f = this.frame;
    if (!f) return;
    let best = Infinity;
    let line = -1;
    const tol = 6 / this.scale;
    for (const s of f.prog.segments) {
      for (let i = 1; i < s.pts.length; i++) {
        const d = distToSeg(p, s.pts[i - 1], s.pts[i]);
        if (d < best) {
          best = d;
          line = s.line;
        }
      }
    }
    if (best <= tol && line >= 0) this.onPick(line);
  }

  draw() {
    const f = this.frame;
    const c = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#0f141b';
    c.fillRect(0, 0, W, H);
    if (!f) return;

    const X = (z: number) => z * this.scale + this.ox;
    const Y = (r: number) => -r * this.scale + this.oy;

    this.drawGrid(W, H);

    // 척
    const cb = chuckBox(f.stockCfg);
    const R = f.stockCfg.diameter / 2;
    const jawW = (cb.maxZ - cb.minZ) * this.scale;
    const jawH = (cb.maxR - R) * this.scale;
    c.fillStyle = '#3a4250';
    c.fillRect(X(cb.minZ), Y(cb.maxR), jawW, jawH);
    c.fillRect(X(cb.minZ), Y(-R), jawW, jawH);

    // 공작물 (위 + 아래 대칭)
    for (const sgn of [1, -1]) {
      c.beginPath();
      for (const path of f.stock) {
        path.forEach((q, i) => {
          const x = X(q.X / SCALE);
          const y = Y((sgn * q.Y) / SCALE);
          if (i === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        });
        c.closePath();
      }
      c.fillStyle = sgn > 0 ? '#8b97a6' : '#6d7887';
      c.fill('evenodd');
      c.strokeStyle = '#c9d3df';
      c.lineWidth = 1;
      c.stroke();
    }

    // 도면 비교: 남은 살(주황) / 과삭(빨강) / 도면 외곽선(노랑 점선)
    if (f.compare) {
      const { target, result } = f.compare;
      const fillPaths = (ps: Paths, color: string) => {
        for (const sgn of [1, -1]) {
          c.beginPath();
          for (const path of ps) {
            path.forEach((q, i) => {
              const x = X(q.X / SCALE);
              const y = Y((sgn * q.Y) / SCALE);
              if (i === 0) c.moveTo(x, y);
              else c.lineTo(x, y);
            });
            c.closePath();
          }
          c.fillStyle = color;
          c.fill();
          c.strokeStyle = color;
          c.lineWidth = 1.5;
          c.stroke();
        }
      };
      if (result) {
        fillPaths(result.excess, '#ff9f1a');
        fillPaths(result.over, '#ff3b3b');
        // 나사 구간(비교 제외): 소재 높이만 연하게, 작은 글씨로
        const R = f.stockCfg.diameter / 2 + 1;
        for (const [a, b] of result.excluded) {
          const x0 = X(Math.max(a, -1e4));
          const w = (b - a) * this.scale;
          c.fillStyle = 'rgba(195, 135, 255, 0.08)';
          c.fillRect(x0, Y(R), w, Y(-R) - Y(R));
          c.strokeStyle = 'rgba(195, 135, 255, 0.45)';
          c.lineWidth = 1;
          c.setLineDash([3, 3]);
          c.strokeRect(x0 + 0.5, Y(R) + 0.5, w - 1, Y(-R) - Y(R) - 1);
          c.setLineDash([]);
          c.fillStyle = 'rgba(195, 135, 255, 0.85)';
          c.font = '11px Pretendard, "Malgun Gothic", sans-serif';
          c.fillText('나사 · 비교 제외', x0 + 3, Y(R) - 4);
        }
      }
      c.strokeStyle = '#ffe14d';
      c.lineWidth = 1.5;
      c.setLineDash([6, 4]);
      for (const sgn of [1, -1]) {
        c.beginPath();
        target.profile.forEach((p, i) => (i === 0 ? c.moveTo(X(p.z), Y(sgn * p.r)) : c.lineTo(X(p.z), Y(sgn * p.r))));
        c.stroke();
      }
      c.setLineDash([]);
      if (result?.excessAt && result.maxExcess > 0.02) this.marker(X(result.excessAt.z), Y(result.excessAt.r), '#ff9f1a');
      if (result?.overAt && result.maxOver > 0.02) this.marker(X(result.overAt.z), Y(result.overAt.r), '#ff3b3b');
    }

    // 중심선
    c.strokeStyle = '#ff6b6b88';
    c.setLineDash([14, 4, 3, 4]);
    c.beginPath();
    c.moveTo(0, Y(0));
    c.lineTo(W, Y(0));
    c.stroke();
    c.setLineDash([]);

    // 공작물 원점
    const o = f.offset;
    c.strokeStyle = '#ffd166';
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(X(o.z), Y(o.r), 5, 0, Math.PI * 2);
    c.moveTo(X(o.z) - 9, Y(o.r));
    c.lineTo(X(o.z) + 9, Y(o.r));
    c.moveTo(X(o.z), Y(o.r) - 9);
    c.lineTo(X(o.z), Y(o.r) + 9);
    c.stroke();

    // 공구 경로
    const toolType = new Map(f.tools.map((t) => [t.no, t.type]));
    for (const s of f.prog.segments) {
      if (s.pts.length < 2) continue;
      const done = s.start + s.duration <= f.time;
      const active = !done && s.start <= f.time;
      const color =
        s.kind === 'rapid' ? '#ff5d5d' : s.kind === 'thread' ? TOOL_COLOR.thread : TOOL_COLOR[toolType.get(s.tool) ?? 'rough'];
      c.strokeStyle = color;
      c.globalAlpha = done || active ? 1 : 0.28;
      c.lineWidth = s.kind === 'rapid' ? 1 : 1.6;
      c.setLineDash(s.kind === 'rapid' ? [5, 4] : []);
      c.beginPath();
      s.pts.forEach((p, i) => (i === 0 ? c.moveTo(X(p.z), Y(p.r)) : c.lineTo(X(p.z), Y(p.r))));
      c.stroke();
    }
    c.globalAlpha = 1;
    c.setLineDash([]);

    // 공구
    if (f.toolPos) {
      const p = f.toolPos;
      if (f.toolShape) {
        const t = toolType.get(f.toolNo);
        c.beginPath();
        f.toolShape.forEach((q, i) => {
          const x = X(p.z + q.z);
          const y = Y(p.r + q.r);
          if (i === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        });
        c.closePath();
        c.fillStyle = (t ? TOOL_COLOR[t] : '#ccc') + 'cc';
        c.fill();
        c.strokeStyle = '#fff';
        c.lineWidth = 1;
        c.stroke();
      }
      c.fillStyle = '#fff';
      c.beginPath();
      c.arc(X(p.z), Y(p.r), 2.5, 0, Math.PI * 2);
      c.fill();
    }
  }

  /** 가장 많이 벗어난 위치 표시 */
  private marker(x: number, y: number, color: string) {
    const c = this.ctx;
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x, y, 9, 0, Math.PI * 2);
    c.stroke();
  }

  private drawGrid(W: number, H: number) {
    const c = this.ctx;
    const steps = [1, 2, 5, 10, 20, 50, 100];
    const step = steps.find((s) => s * this.scale >= 28) ?? 100;
    c.lineWidth = 1;
    c.font = '11px var(--mono, monospace)';
    c.fillStyle = '#4c5a6b';
    const z0 = Math.ceil(-this.ox / this.scale / step) * step;
    for (let z = z0; z * this.scale + this.ox < W; z += step) {
      const x = Math.round(z * this.scale + this.ox) + 0.5;
      c.strokeStyle = z === 0 ? '#3b4a5c' : '#1b2430';
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, H);
      c.stroke();
      c.fillText(String(z), x + 3, H - 6);
    }
    const r0 = Math.ceil((this.oy - H) / this.scale / step) * step;
    for (let r = r0; -r * this.scale + this.oy > 0; r += step) {
      const y = Math.round(-r * this.scale + this.oy) + 0.5;
      c.strokeStyle = '#1b2430';
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(W, y);
      c.stroke();
      if (r !== 0) c.fillText('X' + 2 * r, 4, y - 3);
    }
  }
}

function distToSeg(p: Vec, a: Vec, b: Vec): number {
  const dz = b.z - a.z;
  const dr = b.r - a.r;
  const l2 = dz * dz + dr * dr;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.z - a.z) * dz + (p.r - a.r) * dr) / l2)) : 0;
  return Math.hypot(p.z - (a.z + t * dz), p.r - (a.r + t * dr));
}
