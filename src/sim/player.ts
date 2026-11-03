import type { Alarm, Program, Vec } from '../nc/types';
import { CutSim, posInSegment, segmentAt, type StockConfig } from './simulator';
import type { ToolDef } from '../machine/tools';

export type PlayState = 'ready' | 'run' | 'hold' | 'stop' | 'done' | 'alarm';

export const STATE_LABEL: Record<PlayState, string> = {
  ready: '대기',
  run: '운전 중',
  hold: '이송 정지',
  stop: '블록 정지',
  done: '완료',
  alarm: '알람',
};

/** 가상 시간 축으로 프로그램을 재생하고, 그 시간만큼 절삭을 진행한다 */
export class Player {
  state: PlayState = 'ready';
  time = 0;
  speed = 1;
  singleBlock = false;
  optionalStop = false;
  /** 급속 오버라이드 (1 = 100%) */
  rapidOverride = 1;
  /** 대기 상태에서 보여 줄 시간 (편집기 커서 블록까지). 재생 시간(time)은 0 그대로 */
  preview: number | null = null;
  alarm: Alarm | null = null;
  sim: CutSim;

  private stops: { t: number; optional: boolean }[] = [];
  private blockEnds: number[] = [];
  private stopIdx = 0;
  private blockIdx = 0;

  constructor(
    public prog: Program,
    stock: StockConfig,
    tools: ToolDef[],
  ) {
    this.sim = new CutSim(prog, stock, tools);
    const segs = prog.segments;
    segs.forEach((s, i) => {
      if (s.kind === 'stop') this.stops.push({ t: s.start, optional: !!s.optional });
      if (i === segs.length - 1 || segs[i + 1].line !== s.line) this.blockEnds.push(s.start + s.duration);
    });
  }

  reset() {
    this.preview = null;
    this.sim.reset();
    this.time = 0;
    this.state = 'ready';
    this.alarm = null;
    this.stopIdx = 0;
    this.blockIdx = 0;
  }

  /** 사이클 스타트 */
  start() {
    if (this.state === 'done' || this.state === 'alarm') this.reset();
    // 미리보기로 깎아둔 소재는 버리고 처음부터
    if (this.state === 'ready' && this.preview !== null) this.reset();
    this.state = 'run';
  }

  /** 대기 상태 미리보기: 시간 t 까지 깎인 모습을 만든다 (충돌이 나면 거기서 멈춤) */
  setPreview(t: number | null) {
    if (this.state !== 'ready') return;
    this.preview = t;
    const target = Math.min(t ?? 0, this.prog.duration);
    // 뒤로 가거나, 앞에서 충돌로 멈춘 상태면 처음부터 다시 깎는다
    const stoppedByAlarm = this.sim.done && this.sim.time < this.prog.duration;
    if (target < this.sim.time || stoppedByAlarm) this.sim.reset();
    // 편집하면서 바로 충돌을 알 수 있게 (상태는 대기 그대로)
    this.alarm = this.sim.advanceTo(target);
  }

  /** 화면에 보여 줄 시간: 대기 중 미리보기가 있으면 그 시간 */
  get viewTime(): number {
    return this.state === 'ready' && this.preview !== null ? this.preview : this.time;
  }

  hold() {
    if (this.state === 'run') this.state = 'hold';
  }

  /** 결과 바로 보기: 정지 없이 끝까지 */
  finish() {
    if (this.state === 'done' || this.state === 'alarm') this.reset();
    this.advance(Infinity, false);
  }

  tick(dtSec: number) {
    if (this.state !== 'run') return;
    // 급속 오버라이드: 급속 이동 구간에서만 시간이 느리게 간다
    const segs = this.prog.segments;
    let budget = dtSec * this.speed;
    let t = this.time;
    for (let guard = 0; budget > 1e-12 && t < this.prog.duration && guard < 10000; guard++) {
      const i = segmentAt(this.prog, t);
      if (i < 0) break;
      const s = segs[i];
      const f = s.kind === 'rapid' ? this.rapidOverride : 1;
      const room = s.start + s.duration - t;
      if (room <= 1e-12) {
        if (i + 1 >= segs.length) break;
        t = Math.max(t, segs[i + 1].start) + 1e-9;
        continue;
      }
      if (room / f >= budget) {
        t += budget * f;
        budget = 0;
      } else {
        t += room;
        budget -= room / f;
      }
    }
    // 시간이 남았으면 프로그램 끝까지 간 것
    this.advance(budget > 1e-12 ? this.prog.duration : t, true);
  }

  /**
   * 시간 t 부터 다시 재생. 그 전까지의 절삭은 바로 끝낸다.
   * 뒤로 가면 소재를 처음부터 다시 깎는다.
   */
  seek(t: number, run = true) {
    this.preview = null;
    t = Math.max(0, Math.min(t, this.prog.duration));
    if (t < this.sim.time || this.sim.done || this.state === 'alarm') this.sim.reset();
    this.alarm = null;
    this.stopIdx = 0;
    this.blockIdx = 0;
    const alarm = this.sim.advanceTo(t);
    if (alarm) {
      this.time = this.sim.time;
      this.alarm = alarm;
      this.state = 'alarm';
      return;
    }
    this.time = t;
    this.state = run ? 'run' : 'hold';
  }

  private advance(target: number, honorStops: boolean) {
    let next = Math.min(target, this.prog.duration);
    let pause: PlayState | null = null;

    if (honorStops) {
      while (this.stopIdx < this.stops.length && this.stops[this.stopIdx].t < this.time) this.stopIdx++;
      const st = this.stops[this.stopIdx];
      if (st && st.t <= next && (!st.optional || this.optionalStop)) {
        next = st.t;
        pause = 'stop';
        this.stopIdx++;
      }
      if (this.singleBlock) {
        while (this.blockIdx < this.blockEnds.length && this.blockEnds[this.blockIdx] <= this.time) this.blockIdx++;
        const be = this.blockEnds[this.blockIdx];
        if (be !== undefined && be <= next) {
          next = be;
          pause = 'stop';
          this.blockIdx++;
        }
      }
    }

    const alarm = this.sim.advanceTo(next);
    if (alarm) {
      this.time = this.sim.time;
      this.alarm = alarm;
      this.state = 'alarm';
      return;
    }
    this.time = next;
    if (this.time >= this.prog.duration) {
      if (this.prog.alarm) {
        this.alarm = this.prog.alarm;
        this.state = 'alarm';
      } else this.state = 'done';
      return;
    }
    if (pause) this.state = pause;
  }

  /** 현재 공구 위치와 실행 중인 세그먼트 */
  current(): { pos: Vec | null; segIndex: number } {
    const t = this.viewTime;
    // 미리보기 시간은 "그 블록이 끝난 순간" = 다음 블록 시작과 같으므로, 끝난 블록 쪽을 고른다
    const previewing = this.state === 'ready' && this.preview !== null;
    const i = segmentAt(this.prog, previewing ? Math.max(0, t - 1e-7) : t);
    if (i < 0) return { pos: null, segIndex: -1 };
    const s = this.prog.segments[i];
    return { pos: posInSegment(s, t - s.start), segIndex: i };
  }
}
