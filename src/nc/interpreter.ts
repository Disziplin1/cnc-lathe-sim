import { lex, type Block, type DecimalMode, type Word } from './lexer';
import type { Alarm, Program, Segment, SegKind, Snapshot, Vec } from './types';
import { tipVector, type ToolDef, type ToolOffset } from '../machine/tools';

export interface MachineConfig {
  /** 기계 원점(G28 복귀 위치), 물리 좌표 */
  home: Vec;
  /** 급속 이송 속도 mm/min */
  rapidRate: number;
  /** 기계 최고 회전수 rpm */
  maxRpm: number;
  decimalMode: DecimalMode;
  blockSkip: boolean;
  tools: ToolDef[];
  /** 공구 보정 화면 (보정번호 1 = 0번) */
  offsets: ToolOffset[];
}

class NcAlarm extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const G_GROUP: Record<string, string> = {
  G00: '01', G01: '01', G02: '01', G03: '01', G32: '01', G90: '01', G92: '01', G94: '01',
  G04: '00', G28: '00', G50: '00',
  G70: '00', G71: '00', G72: '00', G73: '00', G74: '00', G75: '00', G76: '00',
  G96: '02', G97: '02',
  G98: '05', G99: '05',
  G20: '06', G21: '06',
  G40: '07', G41: '07', G42: '07',
  G18: '16', G54: '14', G80: '10', G84: '10',
};
const CYCLES = ['G90', 'G92', 'G94'];
const MULTI = ['G70', 'G71', 'G72', 'G73', 'G74', 'G75', 'G76'];
const TOOL_CHANGE_SEC = 1.0;

function gName(v: number): string {
  const i = Math.trunc(v);
  const frac = Math.round((v - i) * 10);
  return 'G' + String(i).padStart(2, '0') + (frac ? '.' + frac : '');
}
const mName = (v: number) => 'M' + String(Math.trunc(v)).padStart(2, '0');
const pad2 = (n: number) => String(n).padStart(2, '0');
const dist = (a: Vec, b: Vec) => Math.hypot(b.z - a.z, b.r - a.r);
const lerp = (a: Vec, b: Vec, t: number): Vec => ({ z: a.z + (b.z - a.z) * t, r: a.r + (b.r - a.r) * t });
const add = (a: Vec, b: Vec): Vec => ({ z: a.z + b.z, r: a.r + b.r });
const same = (a: Vec, b: Vec) => dist(a, b) < 1e-7;

export function compile(src: string, cfg: MachineConfig): Program {
  return new Interpreter(cfg).run(src);
}

/** 보정 중 나중에 한꺼번에 계산하기 위해 모아두는 이동 */
interface CompMove {
  kind: 'rapid' | 'feed';
  /** 프로그램 경로 (보정 전), pts[0] = 시작점 */
  pts: Vec[];
  arc?: { radius: number; ccw: boolean };
  state: MotionState;
}

/** 이동을 만들 때 필요한 상태 (보정 버퍼에서 나중에 되살린다) */
interface MotionState {
  line: number;
  g01: string;
  css: boolean;
  perRev: boolean;
  F: number;
  S: number;
  maxRpm: number;
  tool: number;
  offNo: number;
  spindle: 'M03' | 'M04' | 'M05';
  coolant: boolean;
  offset: Vec;
  toolOff: Vec;
  note: string;
  top: number;
}

class Interpreter {
  private segs: Segment[] = [];
  private warnings: Alarm[] = [];
  private t = 0;
  private line = 0;
  private blocks: Block[] = [];
  private nIndex = new Map<number, number>();
  private jump: number | null = null;
  private inMulti = false;

  private pos: Vec;
  /** G50 X Z 좌표계 이동 */
  private offset: Vec = { z: 0, r: 0 };
  /** 공구 보정 (X, Z) */
  private toolOff: Vec = { z: 0, r: 0 };
  private g01 = 'G00';
  private css = false;
  private perRev = true;
  private F = 0;
  private S = 0;
  private maxRpm: number;
  private tool = 0;
  private offNo = 0;
  private spindle: 'M03' | 'M04' | 'M05' = 'M05';
  private coolant = false;
  private cycle: { code: string; z: number; r: number } | null = null;
  private warned = new Set<string>();
  /** 지금 만드는 동작의 설명 (사이클 내부 동작 표시용) */
  private note = '';
  /** 메인 흐름에서 실행 중인 블록 줄 */
  private top = 0;

  // 인선R보정
  private comp: 'G40' | 'G41' | 'G42' = 'G40';
  private chain: { start: Vec; end: Vec; moves: CompMove[]; side: number } | null = null;

  // 복합 사이클 첫 블록 값
  private p71 = { d: 1, e: 0.5 };
  private p72 = { d: 1, e: 0.5 };
  private p73 = { i: 0, k: 0, n: 1 };
  private e74 = 0.5;
  private e75 = 0.5;
  private p76 = { m: 1, a: 60, dmin: 0.05, d: 0.05 };

  constructor(private cfg: MachineConfig) {
    this.pos = { ...cfg.home };
    this.maxRpm = cfg.maxRpm;
  }

  run(src: string): Program {
    this.blocks = lex(src, this.cfg.decimalMode, this.warnings);
    this.blocks.forEach((b, i) => {
      const n = b.words.find((w) => w.letter === 'N');
      if (n && !this.nIndex.has(n.value)) this.nIndex.set(n.value, i);
    });
    let alarm: Alarm | null = null;
    let ended = false;
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      this.line = b.line;
      this.top = b.line;
      try {
        if (this.exec(b)) {
          ended = true;
          break;
        }
        if (this.jump !== null) {
          i = this.jump;
          this.jump = null;
        }
      } catch (e) {
        if (!(e instanceof NcAlarm)) throw e;
        alarm = { code: e.code, message: e.message, line: this.line, level: 'alarm' };
        break;
      }
    }
    if (!alarm) {
      try {
        this.flushComp();
      } catch (e) {
        if (!(e instanceof NcAlarm)) throw e;
        alarm = { code: e.code, message: e.message, line: this.line, level: 'alarm' };
      }
    }
    if (!alarm && !ended && this.blocks.length > 0) {
      this.warn('W010', 'M30(프로그램 끝)이 없습니다', this.blocks[this.blocks.length - 1].line);
    }
    return { segments: this.segs, alarm, warnings: this.warnings, duration: this.t };
  }

  private exec(b: Block): boolean {
    this.line = b.line;
    if (b.error) throw new NcAlarm(b.error.code, b.error.message);
    if (b.skip && this.cfg.blockSkip) return false;
    return this.block(b);
  }

  private warn(code: string, message: string, line = this.line, once = false) {
    if (once) {
      if (this.warned.has(code)) return;
      this.warned.add(code);
    }
    this.warnings.push({ code, message, line, level: 'warning' });
  }

  /** 블록 하나 실행. 프로그램 끝(M30/M02)이면 true */
  private block(b: Block): boolean {
    const w = new Map<string, Word>();
    const gs: string[] = [];
    const ms: string[] = [];
    for (const word of b.words) {
      if (word.letter === 'G') gs.push(gName(word.value));
      else if (word.letter === 'M') ms.push(mName(word.value));
      else if (word.letter !== 'N' && word.letter !== 'O') w.set(word.letter, word);
    }
    const has = (l: string) => w.has(l);
    const val = (l: string) => w.get(l)!.value;

    // ---- G 코드 분류 ----
    let motion: string | null = null;
    let oneShot: string | null = null;
    let compCode: 'G40' | 'G41' | 'G42' | null = null;
    const groups = new Set<string>();
    for (const g of gs) {
      const grp = G_GROUP[g];
      if (!grp) throw new NcAlarm('PS0010', `지원하지 않는 G코드: ${g}`);
      if (groups.has(grp)) throw new NcAlarm('PS0010', `같은 그룹의 G코드가 한 블록에 두 개 있습니다 (${g})`);
      groups.add(grp);
      switch (g) {
        case 'G96': this.css = true; break;
        case 'G97': this.css = false; break;
        case 'G98': this.perRev = false; break;
        case 'G99': this.perRev = true; break;
        case 'G20': throw new NcAlarm('PS0010', 'G20(인치)은 지원하지 않습니다. G21(mm)을 사용하세요');
        case 'G40': case 'G41': case 'G42':
          compCode = g;
          break;
        case 'G21': case 'G18': case 'G54': case 'G80':
          break;
        default:
          if (grp === '01') motion = g;
          else oneShot = g;
      }
    }

    // ---- M 코드 분류 ----
    const before: string[] = [];
    const after: string[] = [];
    for (const m of ms) {
      if (m === 'M29') continue; // 리지드 탭 (G84 앞에 쓰는 것) — 연습기에서는 표시만
      if (['M03', 'M04', 'M08'].includes(m)) before.push(m);
      else if (['M05', 'M09', 'M00', 'M01', 'M02', 'M30'].includes(m)) after.push(m);
      else throw new NcAlarm('PS0010', `지원하지 않는 M코드: ${m}`);
    }

    // 보정 버퍼를 끊어야 하는 지령
    if (this.chain && (has('T') || (oneShot && oneShot !== 'G04' && oneShot !== 'G70') || (motion && (CYCLES.includes(motion) || motion === 'G32')))) {
      this.warn('W061', '인선R보정 중 사이클·원점복귀·공구교환을 만나 보정을 끝냈습니다 (G40 을 먼저 지령하세요)', this.line, true);
      this.flushComp();
    }

    // ---- F, S, T ----
    if (has('F')) this.F = val('F');
    if (has('S')) {
      if (oneShot === 'G50') this.maxRpm = Math.min(val('S'), this.cfg.maxRpm);
      else this.S = val('S');
    }
    if (has('T')) this.doTool(val('T'));

    for (const m of before) {
      if (m === 'M08') this.coolant = true;
      else {
        this.spindle = m as 'M03' | 'M04';
        if (this.css && this.maxRpm >= this.cfg.maxRpm)
          this.warn('W030', 'G96(주속 일정) 사용 시 G50 S____ 로 최고 회전수를 제한하는 것이 안전합니다', this.line, true);
      }
    }

    // ---- 인선R보정 모드 ----
    let cancelHere = false;
    if (compCode) {
      if (compCode === 'G40') cancelHere = this.comp !== 'G40';
      else if (this.comp !== 'G40' && this.comp !== compCode) this.flushComp();
      if (compCode !== 'G40') {
        const o = this.offNo > 0 ? this.cfg.offsets[this.offNo - 1] : undefined;
        if (!o || o.R <= 0)
          this.warn('W062', `${compCode}: 보정번호 ${pad2(this.offNo)} 의 R(노즈 반경)이 0 이라 보정 효과가 없습니다`, this.line, true);
      }
      this.comp = compCode;
    }

    // ---- 1회성 G 코드 ----
    let axisUsed = false;
    if (oneShot === 'G04') {
      axisUsed = true;
      let sec: number;
      if (has('P')) sec = val('P') / 1000;
      else if (has('X')) sec = val('X');
      else if (has('U')) sec = val('U');
      else throw new NcAlarm('PS0010', 'G04 에는 정지 시간 P(ms) 또는 X/U(초)가 필요합니다');
      this.flushComp();
      this.timed('dwell', sec);
    } else if (oneShot === 'G28') {
      axisUsed = true;
      this.doG28(w);
    } else if (oneShot === 'G50') {
      axisUsed = true;
      if (has('X') || has('Z')) {
        if (has('X')) this.offset.r = this.pos.r - this.toolOff.r - val('X') / 2;
        if (has('Z')) this.offset.z = this.pos.z - this.toolOff.z - val('Z');
        this.warn('W040', 'G50 X_ Z_ 좌표계 설정: 현재 공구 위치를 지령한 좌표로 정의했습니다');
      }
    } else if (oneShot && MULTI.includes(oneShot)) {
      axisUsed = true;
      this.doMulti(oneShot, w);
    } else if (oneShot === 'G84') {
      axisUsed = true;
      this.flushComp();
      this.doTap(w);
    }

    // ---- 이동 ----
    if (motion) {
      if (CYCLES.includes(motion) && motion !== this.cycle?.code) this.cycle = null;
      this.g01 = motion;
    }
    const hasAxis = has('X') || has('Z') || has('U') || has('W');
    if (!axisUsed && hasAxis) this.doMotion(w, cancelHere);
    else if (!axisUsed && motion && CYCLES.includes(motion))
      throw new NcAlarm('PS0010', `${motion} 사이클에 X(U) 또는 Z(W) 지령이 없습니다`);
    else if (cancelHere) this.flushComp();

    // ---- 후처리 M ----
    for (const m of after) {
      switch (m) {
        case 'M05': this.spindle = 'M05'; break;
        case 'M09': this.coolant = false; break;
        case 'M00':
          this.flushComp();
          this.timed('stop', 0);
          break;
        case 'M01':
          this.flushComp();
          this.timed('stop', 0, true);
          break;
        case 'M02':
        case 'M30':
          this.flushComp();
          this.spindle = 'M05';
          this.coolant = false;
          return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- 상태

  /** 회전수: G97 은 S 그대로, G96 은 S(m/min)÷(π×직경). G50 S 제한은 G96 에만 걸린다 */
  private rpmAt(r: number): number {
    if (!this.css) return Math.min(this.S, this.cfg.maxRpm);
    const rpm = (1000 * this.S) / (Math.PI * Math.max(Math.abs(2 * r), 0.001));
    return Math.min(rpm, this.maxRpm, this.cfg.maxRpm);
  }

  private get shift(): Vec {
    return add(this.offset, this.toolOff);
  }

  /** 지금 프로그램이 생각하는 공구 위치 (보정 버퍼가 있으면 그 끝) */
  private get cur(): Vec {
    return this.chain ? this.chain.end : this.pos;
  }

  private snap(): Snapshot {
    return {
      modal: [this.g01, this.css ? 'G96' : 'G97', this.perRev ? 'G99' : 'G98', 'G21', this.comp, 'G18', 'G54'],
      F: this.F,
      S: this.S,
      T: 'T' + pad2(this.tool) + pad2(this.offNo),
      spindle: this.spindle,
      coolant: this.coolant,
      offset: this.shift,
    };
  }

  private saveState(): MotionState {
    return {
      line: this.line, g01: this.g01, css: this.css, perRev: this.perRev, F: this.F, S: this.S,
      maxRpm: this.maxRpm, tool: this.tool, offNo: this.offNo, spindle: this.spindle, coolant: this.coolant,
      offset: { ...this.offset }, toolOff: { ...this.toolOff }, note: this.note, top: this.top,
    };
  }

  private loadState(s: MotionState) {
    this.line = s.line; this.g01 = s.g01; this.css = s.css; this.perRev = s.perRev; this.F = s.F; this.S = s.S;
    this.maxRpm = s.maxRpm; this.tool = s.tool; this.offNo = s.offNo; this.spindle = s.spindle; this.coolant = s.coolant;
    this.offset = { ...s.offset }; this.toolOff = { ...s.toolOff }; this.note = s.note; this.top = s.top;
  }

  private push(kind: SegKind, pts: Vec[], times: number[], extra: Partial<Segment> = {}) {
    const duration = extra.duration ?? times[times.length - 1];
    this.segs.push({
      kind,
      line: this.line,
      tool: this.tool,
      pts,
      times,
      start: this.t,
      duration,
      feed: 0,
      rpm: this.spindle === 'M05' ? 0 : this.rpmAt(this.pos.r),
      pitch: 0,
      snap: this.snap(),
      note: this.note || undefined,
      top: this.top,
      ...extra,
    });
    this.t += duration;
    this.pos = { ...pts[pts.length - 1] };
  }

  private timed(kind: SegKind, sec: number, optional = false) {
    this.push(kind, [{ ...this.pos }], [0], { duration: sec, optional });
  }

  private doTool(v: number) {
    const tv = Math.round(v);
    const no = Math.floor(tv / 100);
    const off = tv % 100;
    if (tv > 9999) throw new NcAlarm('PS0010', `T${tv} : T코드는 4자리(공구번호 2자리 + 보정번호 2자리)입니다`);
    if (no !== 0 && !this.cfg.tools.some((t) => t.no === no))
      throw new NcAlarm('PS0010', `T${pad2(no)} 공구가 공구대에 없습니다 (설정 → 공구에서 등록하세요)`);
    if (off > this.cfg.offsets.length)
      throw new NcAlarm('PS0010', `보정번호 ${pad2(off)} 은 없습니다 (1~${this.cfg.offsets.length})`);
    this.offNo = off;
    const o = off > 0 ? this.cfg.offsets[off - 1] : undefined;
    this.toolOff = o ? { z: o.Z, r: o.X / 2 } : { z: 0, r: 0 };
    if (no !== 0 && no !== this.tool) {
      this.tool = no;
      this.timed('tool', TOOL_CHANGE_SEC);
    }
  }

  private target(w: Map<string, Word>, from: Vec = this.cur): Vec {
    if (w.has('X') && w.has('U')) throw new NcAlarm('PS0010', 'X 와 U 를 한 블록에 같이 쓸 수 없습니다');
    if (w.has('Z') && w.has('W')) throw new NcAlarm('PS0010', 'Z 와 W 를 한 블록에 같이 쓸 수 없습니다');
    const s = this.shift;
    let { z, r } = from;
    if (w.has('X')) r = w.get('X')!.value / 2 + s.r;
    else if (w.has('U')) r += w.get('U')!.value / 2;
    if (w.has('Z')) z = w.get('Z')!.value + s.z;
    else if (w.has('W')) z += w.get('W')!.value;
    return { z, r };
  }

  /** 절삭 이송속도 mm/min (반경 r 위치 기준) */
  private feedRate(r: number): number {
    if (this.perRev && this.spindle === 'M05')
      throw new NcAlarm('SIM01', '주축이 정지된 상태에서 절삭 이송을 지령했습니다 (M03/M04 누락)');
    if (this.F <= 0) throw new NcAlarm('PS0011', '이송속도 F 가 지령되지 않았습니다');
    if (!this.perRev) return this.F;
    const rpm = this.rpmAt(r);
    if (rpm <= 0) throw new NcAlarm('PS0011', '주축 회전수 S 가 0 입니다');
    return this.F * rpm;
  }

  // ---------------------------------------------------------------- 이동 생성

  private rapid(to: Vec) {
    const a = { ...this.pos };
    const dz = to.z - a.z;
    const dr = to.r - a.r;
    if (Math.abs(dz) < 1e-9 && Math.abs(dr) < 1e-9) return;
    const v = this.cfg.rapidRate / 60;
    // 급속 이송은 축마다 독립적으로 움직이므로 경로가 꺾인다 (비직선 보간)
    const m = Math.min(Math.abs(dz), Math.abs(dr));
    const pts: Vec[] = [a];
    const times = [0];
    if (m > 1e-9 && Math.abs(Math.abs(dz) - Math.abs(dr)) > 1e-9) {
      pts.push({ z: a.z + Math.sign(dz) * m, r: a.r + Math.sign(dr) * m });
      times.push(m / v);
    }
    pts.push({ ...to });
    times.push(Math.max(Math.abs(dz), Math.abs(dr)) / v);
    this.push('rapid', pts, times, { feed: this.cfg.rapidRate });
  }

  /** 절삭 이송 (직선/원호 폴리라인). thread 이면 pitch(리드) 동기 이송 */
  private feedPath(path: Vec[], kind: 'feed' | 'thread' = 'feed', pitch = 0) {
    if (kind === 'thread') {
      if (this.spindle === 'M05') throw new NcAlarm('SIM01', '주축이 정지된 상태에서 나사 절삭을 지령했습니다');
      if (pitch <= 0) throw new NcAlarm('PS0011', '나사 리드 F 가 지령되지 않았습니다');
      if (this.css) this.warn('W050', '나사 절삭은 G97(회전수 일정)로 하는 것이 원칙입니다', this.line, true);
    }
    const out: Vec[] = [{ ...path[0] }];
    const times = [0];
    let t = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const n = this.css ? Math.max(1, Math.ceil(dist(a, b))) : 1;
      for (let k = 1; k <= n; k++) {
        const p = k === n ? { ...b } : lerp(a, b, k / n);
        const prev = out[out.length - 1];
        const rMid = (prev.r + p.r) / 2;
        const rate = kind === 'thread' ? pitch * this.rpmAt(rMid) : this.feedRate(rMid);
        t += dist(prev, p) / (rate / 60);
        out.push(p);
        times.push(t);
      }
    }
    if (t <= 0) return;
    const feed = kind === 'thread' ? pitch * this.rpmAt(path[0].r) : this.feedRate(path[0].r);
    this.push(kind, out, times, { feed, pitch });
  }

  private feedTo(to: Vec) {
    if (!same(this.pos, to)) this.feedPath([{ ...this.pos }, to]);
  }

  private moveTo(rapid: boolean, to: Vec) {
    if (rapid) this.rapid(to);
    else this.feedTo(to);
  }

  private doG28(w: Map<string, Word>) {
    const xAxis = w.has('X') || w.has('U');
    const zAxis = w.has('Z') || w.has('W');
    if (!xAxis && !zAxis) throw new NcAlarm('PS0010', 'G28 에 복귀할 축(예: U0. W0.)을 지정하세요');
    this.note = 'G28 중간점으로 급속';
    this.rapid(this.target(w));
    const home = { ...this.pos };
    if (xAxis) home.r = this.cfg.home.r;
    if (zAxis) home.z = this.cfg.home.z;
    this.note = 'G28 기계 원점으로 급속 복귀';
    this.rapid(home);
    this.note = '';
  }

  private doMotion(w: Map<string, Word>, cancelHere = false) {
    const code = this.g01;
    if (CYCLES.includes(code)) return this.doCycle(code, w);
    const s = { ...this.cur };
    const e = this.target(w);
    switch (code) {
      case 'G00':
        return this.linear(true, s, e, cancelHere);
      case 'G01':
        return this.linear(false, s, e, cancelHere);
      case 'G32':
        return this.feedPath([s, e], 'thread', this.F);
      case 'G02':
      case 'G03': {
        const ccw = code === 'G03';
        const { pts, radius } = this.arc(ccw, s, e, w);
        if (this.comp !== 'G40' || this.chain) {
          this.addComp({ kind: 'feed', pts, arc: { radius, ccw }, state: this.saveState() });
          if (cancelHere) this.flushComp();
          return;
        }
        return this.feedPath(pts);
      }
    }
  }

  private linear(rapid: boolean, s: Vec, e: Vec, cancelHere: boolean) {
    if (this.comp !== 'G40' || this.chain) {
      this.addComp({ kind: rapid ? 'rapid' : 'feed', pts: [s, e], state: this.saveState() });
      if (cancelHere) this.flushComp();
      return;
    }
    if (rapid) this.rapid(e);
    else if (!same(s, e)) this.feedPath([s, e]);
  }

  private arc(ccw: boolean, s: Vec, e: Vec, w: Map<string, Word>): { pts: Vec[]; radius: number } {
    let c: Vec;
    if (w.has('R')) {
      const R = w.get('R')!.value;
      const d = dist(s, e);
      if (d < 1e-9) throw new NcAlarm('PS0020', 'R 지령 원호는 시작점과 끝점이 같을 수 없습니다');
      const half = d / 2;
      if (half > Math.abs(R) + 0.005)
        throw new NcAlarm('PS0020', `원호 반지름 R${Math.abs(R)} 이 너무 작습니다 (시작점~끝점 거리의 절반 ${half.toFixed(3)} 이상이어야 함)`);
      const h = Math.sqrt(Math.max(0, R * R - half * half));
      const mid = lerp(s, e, 0.5);
      const left = { z: -(e.r - s.r) / d, r: (e.z - s.z) / d };
      const sign = (ccw ? 1 : -1) * (R > 0 ? 1 : -1);
      c = { z: mid.z + sign * h * left.z, r: mid.r + sign * h * left.r };
    } else if (w.has('I') || w.has('K')) {
      c = { z: s.z + (w.get('K')?.value ?? 0), r: s.r + (w.get('I')?.value ?? 0) };
      const r0 = dist(s, c);
      const r1 = dist(e, c);
      if (Math.abs(r0 - r1) > 0.02)
        throw new NcAlarm('PS0020', `시작점과 끝점의 원호 반지름이 다릅니다 (${r0.toFixed(3)} / ${r1.toFixed(3)})`);
    } else {
      throw new NcAlarm('PS0010', 'G02/G03 에는 R 또는 I/K 가 필요합니다');
    }
    return { pts: arcPoints(s, e, c, ccw), radius: dist(s, c) };
  }

  private doCycle(code: string, w: Map<string, Word>) {
    const S = { ...this.pos };
    const sh = this.shift;
    let tr: number;
    let tz: number;
    if (w.has('X')) tr = w.get('X')!.value / 2 + sh.r;
    else if (w.has('U')) tr = S.r + w.get('U')!.value / 2;
    else if (this.cycle) tr = this.cycle.r;
    else throw new NcAlarm('PS0010', `${code} 사이클의 X(U) 값이 없습니다`);
    if (w.has('Z')) tz = w.get('Z')!.value + sh.z;
    else if (w.has('W')) tz = S.z + w.get('W')!.value;
    else if (this.cycle) tz = this.cycle.z;
    else throw new NcAlarm('PS0010', `${code} 사이클의 Z(W) 값이 없습니다`);
    this.cycle = { code, z: tz, r: tr };
    const R = w.get('R')?.value ?? 0;

    if (code === 'G94') {
      // 단면 절삭: Z 급속 → X 절삭 → Z 절삭 복귀 → X 급속 복귀
      this.note = 'G94 ① Z 급속 진입';
      this.rapid({ z: tz + R, r: S.r });
      this.note = 'G94 ② X 절삭';
      this.feedTo({ z: tz, r: tr });
      this.note = 'G94 ③ Z 절삭 이송으로 빠짐';
      this.feedTo({ z: S.z, r: tr });
      this.note = 'G94 ④ 시작점으로 급속 복귀';
      this.rapid(S);
      this.note = '';
      return;
    }
    // G90 외경 / G92 나사: X 급속 → Z 절삭 → X 복귀 → Z 급속 복귀
    // R: 테이퍼량 (반경값, 절삭 시작점 - 끝점)
    this.note = `${code} ① X 급속 진입`;
    this.rapid({ z: S.z, r: tr + R });
    if (code === 'G92') {
      this.note = 'G92 ② 나사 절삭';
      this.feedPath([{ ...this.pos }, { z: tz, r: tr }], 'thread', this.F);
      this.note = 'G92 ③ X 급속 후퇴';
      this.rapid({ z: tz, r: S.r });
    } else {
      this.note = 'G90 ② Z 절삭';
      this.feedTo({ z: tz, r: tr });
      this.note = 'G90 ③ X 절삭 이송으로 빠짐';
      this.feedTo({ z: tz, r: S.r });
    }
    this.note = `${code} ④ 시작점으로 급속 복귀`;
    this.rapid(S);
    this.note = '';
  }

  /**
   * G84 정면 탭 사이클 (중심 X0 에서): R 점까지 급속 → 피치(F) 만큼 회전당 이송으로 Z 까지 →
   * P 만큼 멈춤 → 주축을 거꾸로 돌려 같은 이송으로 R 점까지 → 시작점으로 급속.
   * R: 시작점에서 R 점까지 Z 거리 (없으면 시작점이 R 점).
   */
  private doTap(w: Map<string, Word>) {
    if (!w.has('Z') && !w.has('W')) throw new NcAlarm('PS0010', 'G84 에 탭 깊이 Z(W) 가 필요합니다');
    if (!w.has('F') && this.F <= 0) throw new NcAlarm('PS0011', 'G84 에 탭 피치 F 가 필요합니다 (M6 이면 F1.)');
    const S = { ...this.pos };
    if (Math.abs(S.r - this.shift.r) > 0.01)
      throw new NcAlarm('PS0010', 'G84 탭은 중심(X0.)에서 해야 합니다. G00 X0. 으로 먼저 옮기세요');
    const E = { z: w.has('Z') ? w.get('Z')!.value + this.shift.z : S.z + w.get('W')!.value, r: S.r };
    const Rp = { z: S.z + (w.get('R')?.value ?? 0), r: S.r };
    if (E.z >= Rp.z) throw new NcAlarm('PS0010', 'G84 탭 깊이 Z 가 R 점보다 안쪽(-Z)이어야 합니다');
    const pitch = this.F;
    const spindle = this.spindle;
    this.note = 'G84 ① R 점으로 급속';
    this.rapid(Rp);
    this.note = `G84 ② 탭 들어감 (회전당 ${pitch}mm = 피치)`;
    this.feedPath([{ ...this.pos }, E], 'thread', pitch);
    if (w.has('P')) {
      this.note = 'G84 ③ 바닥에서 멈춤';
      this.timed('dwell', w.get('P')!.value / 1000);
    }
    this.note = 'G84 ④ 주축 역회전 → 같은 피치로 빠져나옴';
    this.spindle = spindle === 'M03' ? 'M04' : 'M03';
    this.feedPath([{ ...this.pos }, Rp], 'thread', pitch);
    this.spindle = spindle;
    this.note = 'G84 ⑤ 시작점으로 급속';
    this.rapid(S);
    this.note = '';
  }

  // ---------------------------------------------------------------- 복합 사이클

  private blockRange(w: Map<string, Word>, code: string): [number, number] {
    if (!w.has('P') || !w.has('Q')) throw new NcAlarm('PS0010', `${code} 에 P(시작 N번호)와 Q(끝 N번호)가 필요합니다`);
    const p = this.nIndex.get(w.get('P')!.value);
    const q = this.nIndex.get(w.get('Q')!.value);
    if (p === undefined) throw new NcAlarm('PS0063', `P 로 지정한 N${w.get('P')!.value} 블록이 없습니다`);
    if (q === undefined) throw new NcAlarm('PS0063', `Q 로 지정한 N${w.get('Q')!.value} 블록이 없습니다`);
    if (q < p) throw new NcAlarm('PS0063', 'Q 블록이 P 블록보다 앞에 있습니다');
    return [p, q];
  }

  private doMulti(code: string, w: Map<string, Word>) {
    if (this.inMulti) throw new NcAlarm('PS0010', `복합 사이클 형상(P~Q) 안에서는 ${code} 를 쓸 수 없습니다`);
    const num = (l: string, def = 0) => w.get(l)?.value ?? def;
    const hasAxis = w.has('X') || w.has('U') || w.has('Z') || w.has('W');
    switch (code) {
      case 'G70': {
        const [p, q] = this.blockRange(w, code);
        const A = { ...this.cur };
        const g70Line = this.line;
        this.inMulti = true;
        try {
          for (let i = p; i <= q; i++) this.exec(this.blocks[i]);
        } finally {
          this.inMulti = false;
        }
        this.line = g70Line;
        this.note = 'G70 끝: 사이클 시작점으로 급속 복귀';
        this.linear(true, { ...this.cur }, A, false);
        this.note = '';
        return;
      }
      case 'G71':
      case 'G72': {
        const prm = code === 'G71' ? this.p71 : this.p72;
        if (!w.has('P')) {
          // 첫 블록: G71 U(절입) R(도피) / G72 W(절입) R(도피)
          prm.d = num(code === 'G71' ? 'U' : 'W', prm.d);
          prm.e = num('R', prm.e);
          return;
        }
        const [p, q] = this.blockRange(w, code);
        this.roughCycle(code, p, q, num('U'), num('W'), prm.d, prm.e);
        this.jump = q;
        return;
      }
      case 'G73': {
        if (!w.has('P')) {
          this.p73 = { i: num('U', this.p73.i), k: num('W', this.p73.k), n: Math.max(1, Math.round(num('R', this.p73.n))) };
          return;
        }
        const [p, q] = this.blockRange(w, code);
        this.patternCycle(p, q, num('U'), num('W'));
        this.jump = q;
        return;
      }
      case 'G74':
      case 'G75': {
        if (!hasAxis) {
          if (code === 'G74') this.e74 = num('R', this.e74);
          else this.e75 = num('R', this.e75);
          return;
        }
        this.peckCycle(code, w);
        return;
      }
      case 'G76': {
        if (!hasAxis) {
          const P = Math.round(num('P', 10060));
          this.p76 = {
            m: Math.max(1, Math.floor(P / 10000)),
            a: P % 100,
            dmin: num('Q', this.p76.dmin * 1000) / 1000,
            d: num('R', this.p76.d),
          };
          return;
        }
        this.threadCycle(w);
        return;
      }
    }
  }

  /** P~Q 블록의 형상을 폴리라인으로 (시작점 포함) */
  private contour(p: number, q: number, start: Vec): { pts: Vec[]; firstRapid: boolean } {
    let g = '';
    let cur = { ...start };
    const pts: Vec[] = [cur];
    let firstRapid = true;
    const sh = this.shift;
    const keep = this.line;
    for (let i = p; i <= q; i++) {
      const b = this.blocks[i];
      this.line = b.line;
      if (b.error) throw new NcAlarm(b.error.code, b.error.message);
      const w = new Map<string, Word>();
      for (const word of b.words) {
        if (word.letter === 'G') {
          const name = gName(word.value);
          if (['G00', 'G01', 'G02', 'G03'].includes(name)) g = name;
          else if (G_GROUP[name] === '01' || MULTI.includes(name))
            throw new NcAlarm('PS0065', `복합 사이클 형상 안에 ${name} 은 쓸 수 없습니다`);
        } else w.set(word.letter, word);
      }
      if (i === p) {
        if (g !== 'G00' && g !== 'G01') throw new NcAlarm('PS0065', `P 블록(N 시작)에는 G00 또는 G01 이 있어야 합니다`);
        firstRapid = g === 'G00';
      }
      if (!(w.has('X') || w.has('U') || w.has('Z') || w.has('W'))) continue;
      let e = { ...cur };
      if (w.has('X')) e.r = w.get('X')!.value / 2 + sh.r;
      else if (w.has('U')) e.r += w.get('U')!.value / 2;
      if (w.has('Z')) e.z = w.get('Z')!.value + sh.z;
      else if (w.has('W')) e.z += w.get('W')!.value;
      if (g === 'G02' || g === 'G03') pts.push(...this.arc(g === 'G03', cur, e, w).pts.slice(1));
      else if (!same(cur, e)) pts.push(e);
      cur = e;
    }
    this.line = keep;
    if (pts.length < 2) throw new NcAlarm('PS0065', 'P~Q 사이에 이동 지령이 없습니다');
    return { pts, firstRapid };
  }

  /**
   * G71(외경/내경 황삭) · G72(단면 황삭).
   * G72 는 Z 와 X 를 바꿔 같은 계산을 한다: u = 깎아 나가는 축, v = 절입하는 축.
   */
  private roughCycle(code: string, p: number, q: number, U: number, W: number, depth: number, e: number) {
    if (depth <= 0) throw new NcAlarm('PS0062', `${code} 절입량이 0 입니다`);
    const swap = code === 'G72';
    const toUV = (pt: Vec) => (swap ? { u: pt.r, v: pt.z } : { u: pt.z, v: pt.r });
    const fromUV = (u: number, v: number): Vec => (swap ? { z: v, r: u } : { z: u, r: v });

    const A = { ...this.pos };
    const { pts, firstRapid } = this.contour(p, q, A);
    const allow = { z: W, r: U / 2 };
    const C = pts.slice(1).map((pt) => toUV(add(pt, allow)));
    const a = toUV(A);
    const sgnV = Math.sign(C[0].v - a.v);
    const sgnU = Math.sign(C[C.length - 1].u - C[0].u);
    if (!sgnV) throw new NcAlarm('PS0062', `${code}: 시작점과 형상 시작점(P 블록)이 같은 위치입니다`);
    if (!sgnU) throw new NcAlarm('PS0064', `${code}: 형상이 한 방향으로 진행하지 않습니다`);
    for (let i = 1; i < C.length; i++) {
      if ((C[i].v - C[i - 1].v) * sgnV > 0.001 || (C[i].u - C[i - 1].u) * sgnU < -0.001)
        throw new NcAlarm('PS0064', `${code}: 형상이 단조 증가/감소가 아닙니다 (오목한 형상 Type II 는 지원하지 않음)`);
    }

    // 절입 레벨마다: 진입 → 형상에 닿을 때까지 절삭 → 45° 도피 → 급속 복귀
    let level = a.v + sgnV * depth;
    let pass = 0;
    while ((C[0].v - level) * sgnV > 1e-6) {
      pass++;
      let uEnd = C[C.length - 1].u;
      for (let i = 0; i < C.length; i++) {
        if ((C[i].v - level) * sgnV <= 0) {
          const pr = C[Math.max(0, i - 1)];
          const t = i === 0 || Math.abs(C[i].v - pr.v) < 1e-9 ? 1 : (level - pr.v) / (C[i].v - pr.v);
          uEnd = pr.u + (C[i].u - pr.u) * t;
          break;
        }
      }
      this.note = `${code} ${pass}회째 절입 (${depth}mm)`;
      this.moveTo(firstRapid, fromUV(a.u, level));
      this.note = `${code} ${pass}회째 절삭`;
      this.feedTo(fromUV(uEnd, level));
      this.note = `${code} 45° 도피 (R${e})`;
      this.feedTo(fromUV(uEnd - sgnU * e, level - sgnV * e));
      this.note = `${code} 급속 복귀 → 다음 절입`;
      this.rapid(fromUV(a.u, level - sgnV * e));
      level += sgnV * depth;
    }
    // 마지막: 정삭 여유를 남긴 형상을 따라 한 번
    this.note = `${code} 마무리: 정삭 여유를 남기고 형상을 따라감`;
    this.moveTo(firstRapid, fromUV(a.u, C[0].v));
    this.feedPath([{ ...this.pos }, ...C.map((c) => fromUV(c.u, c.v))]);
    this.note = `${code} 끝: 사이클 시작점으로 급속 복귀`;
    this.rapid(fromUV(this.uv(swap).u, a.v));
    this.rapid(A);
    this.note = '';
  }

  private uv(swap: boolean) {
    return swap ? { u: this.pos.r, v: this.pos.z } : { u: this.pos.z, v: this.pos.r };
  }

  /** G73 형상 반복: 도피량을 줄여가며 같은 형상을 n 번 */
  private patternCycle(p: number, q: number, U: number, W: number) {
    const A = { ...this.pos };
    const { pts, firstRapid } = this.contour(p, q, A);
    const { i, k, n } = this.p73;
    for (let pass = 1; pass <= n; pass++) {
      const f = n === 1 ? 0 : (n - pass) / (n - 1);
      const shift = { z: W + k * f, r: U / 2 + i * f };
      const C = pts.slice(1).map((pt) => add(pt, shift));
      this.note = `G73 ${pass}/${n}회째 형상 따라 절삭`;
      this.moveTo(firstRapid, C[0]);
      this.feedPath([{ ...this.pos }, ...C.slice(1)]);
      this.note = `G73 ${pass}/${n}회째 끝: 시작점으로 급속 복귀`;
      this.rapid({ z: this.pos.z, r: Math.max(this.pos.r, A.r) });
      this.rapid(A);
    }
    this.note = '';
  }

  /** G74(단면 홈·드릴 펙) / G75(외경 홈 펙). u = 쪼아 들어가는 축, v = 옆으로 이동하는 축 */
  private peckCycle(code: string, w: Map<string, Word>) {
    const swap = code === 'G75';
    const toUV = (pt: Vec) => (swap ? { u: pt.r, v: pt.z } : { u: pt.z, v: pt.r });
    const fromUV = (u: number, v: number): Vec => (swap ? { z: v, r: u } : { z: u, r: v });
    const A = { ...this.pos };
    const E = this.target(w, A);
    const a = toUV(A);
    const end = toUV(E);
    // G74: P = X 이동량, Q = Z 절입량 / G75: P = X 절입량, Q = Z 이동량 (µm)
    const peck = (code === 'G74' ? w.get('Q')?.value ?? 0 : w.get('P')?.value ?? 0) / 1000;
    const step = (code === 'G74' ? w.get('P')?.value ?? 0 : w.get('Q')?.value ?? 0) / 1000;
    const e = code === 'G74' ? this.e74 : this.e75;
    const sgnU = Math.sign(end.u - a.u);
    const sgnV = Math.sign(end.v - a.v);
    if (!sgnU) throw new NcAlarm('PS0062', `${code}: 절입 방향의 끝점이 시작점과 같습니다`);

    const columns: number[] = [a.v];
    if (sgnV) {
      if (step <= 0) throw new NcAlarm('PS0062', `${code}: 이동량 ${code === 'G74' ? 'P' : 'Q'} 가 필요합니다`);
      for (let v = a.v + sgnV * step; (end.v - v) * sgnV > 1e-6; v += sgnV * step) columns.push(v);
      columns.push(end.v);
    }
    columns.forEach((v, j) => {
      this.note = `${code} 다음 위치로 이동`;
      if (j > 0) this.rapid(fromUV(a.u, v));
      let u = a.u;
      while ((end.u - u) * sgnU > 1e-6) {
        const next = peck > 0 ? u + sgnU * peck : end.u;
        const reached = (end.u - next) * sgnU <= 1e-6;
        u = reached ? end.u : next;
        this.note = `${code} 쪼아 들어감 (${peck || '한 번에'}mm)`;
        this.feedTo(fromUV(u, v));
        this.note = `${code} 칩 끊기 후퇴 (R${e})`;
        if (!reached) this.rapid(fromUV(u - sgnU * e, v));
      }
      this.note = `${code} 바닥 도달 → 급속 후퇴`;
      this.rapid(fromUV(a.u, v));
    });
    this.note = `${code} 끝: 시작점으로 급속 복귀`;
    this.rapid(A);
    this.note = '';
  }

  /** G76 복합 나사: 절입 깊이를 √n 비율로 줄여가며 여러 번 */
  private threadCycle(w: Map<string, Word>) {
    const A = { ...this.pos };
    const E = this.target(w, A);
    const k = (w.get('P')?.value ?? 0) / 1000;
    const d1 = (w.get('Q')?.value ?? 0) / 1000;
    const taper = w.get('R')?.value ?? 0;
    const lead = this.F;
    const { m, dmin, d } = this.p76;
    if (k <= 0 || d1 <= 0) throw new NcAlarm('PS0062', 'G76 에 나사산 높이 P 와 첫 절입량 Q 가 필요합니다 (µm 단위)');
    const outer = A.r > E.r;
    const sgn = outer ? -1 : 1;
    const major = E.r - sgn * k;

    const depths: number[] = [];
    let prev = 0;
    for (let n = 1; n < 1000; n++) {
      let dn = d1 * Math.sqrt(n);
      if (dn - prev < dmin) dn = prev + dmin;
      if (dn >= k - d) break;
      depths.push(dn);
      prev = dn;
    }
    depths.push(k - d);
    for (let i = 0; i < m; i++) depths.push(k);

    depths.forEach((dep, i) => {
      const r = major + sgn * dep;
      const tag = `G76 ${i + 1}/${depths.length}회째 (깊이 ${dep.toFixed(3)})`;
      this.note = `${tag} 진입`;
      this.rapid({ z: A.z, r: r + taper });
      this.note = `${tag} 나사 절삭`;
      this.feedPath([{ ...this.pos }, { z: E.z, r }], 'thread', lead);
      this.note = `${tag} X 급속 후퇴`;
      this.rapid({ z: E.z, r: A.r });
      this.note = `${tag} 시작점 복귀`;
      this.rapid(A);
    });
    this.note = '';
  }

  // ---------------------------------------------------------------- 인선R보정

  private addComp(m: CompMove) {
    if (!this.chain) this.chain = { start: { ...this.pos }, end: { ...m.pts[0] }, moves: [], side: this.comp === 'G41' ? -1 : 1 };
    this.chain.moves.push(m);
    this.chain.end = { ...m.pts[m.pts.length - 1] };
  }

  /** 모아둔 이동을 보정해서 실제 세그먼트로 만든다. 마지막 이동은 보정 취소 이동으로 본다. */
  private flushComp() {
    const ch = this.chain;
    if (!ch) return;
    this.chain = null;
    const keep = this.saveState();
    const compMode = ch.moves.length ? ch.moves[0].state : keep;
    const o = compMode.offNo > 0 ? this.cfg.offsets[compMode.offNo - 1] : undefined;
    const R = o?.R ?? 0;
    const tip = tipVector(o?.T ?? 0, R);
    const moves = ch.moves;

    const emit = (m: CompMove, path: Vec[]) => {
      this.loadState(m.state);
      if (m.kind === 'rapid') for (const p of path.slice(1)) this.rapid(p);
      else if (path.length >= 2) {
        const clean = path.filter((p, i) => i === 0 || !same(p, path[i - 1]));
        if (clean.length >= 2) this.feedPath(clean);
      }
    };

    if (moves.length < 3 || R <= 0) {
      // 시작·취소 이동뿐이거나 R=0: 보정 없이 그대로
      for (const m of moves) emit(m, [{ ...this.pos }, ...m.pts.slice(1)]);
      this.loadState(keep);
      return;
    }

    const startup = moves[0];
    const cancel = moves[moves.length - 1];
    const body = moves.slice(1, -1);
    // G42 = 진행 방향 오른쪽, G41 = 왼쪽
    const sideOf = ch.side;

    for (const m of body) {
      if (!m.arc) continue;
      const inside = (m.arc.ccw && sideOf < 0) || (!m.arc.ccw && sideOf > 0);
      if (inside && m.arc.radius <= R + 1e-6) {
        this.line = m.state.line;
        throw new NcAlarm('PS0041', `인선R보정 간섭: 오목 원호 반지름(${m.arc.radius.toFixed(2)})이 노즈 반경(${R})보다 작습니다`);
      }
    }

    // 작은 선분 목록
    const segsList: { a: Vec; b: Vec; m: number }[] = [];
    body.forEach((m, mi) => {
      for (let i = 1; i < m.pts.length; i++) if (!same(m.pts[i - 1], m.pts[i])) segsList.push({ a: m.pts[i - 1], b: m.pts[i], m: mi });
    });
    if (segsList.length === 0) {
      for (const m of moves) emit(m, [{ ...this.pos }, ...m.pts.slice(1)]);
      this.loadState(keep);
      return;
    }
    const nrm = (a: Vec, b: Vec): Vec => {
      const l = dist(a, b);
      return { z: (sideOf * (b.r - a.r)) / l, r: (sideOf * -(b.z - a.z)) / l };
    };
    const paths: Vec[][] = body.map(() => []);
    const first = segsList[0];
    const n0 = nrm(first.a, first.b);
    let curPt = add(first.a, { z: R * n0.z, r: R * n0.r });
    paths[first.m].push(curPt);
    for (let k = 0; k < segsList.length; k++) {
      const s = segsList[k];
      const nk = nrm(s.a, s.b);
      const Bk = add(s.b, { z: R * nk.z, r: R * nk.r });
      const nx = segsList[k + 1];
      if (!nx) {
        paths[s.m].push(Bk);
        break;
      }
      const nn = nrm(nx.a, nx.b);
      const An = add(nx.a, { z: R * nn.z, r: R * nn.r });
      const d1 = { z: s.b.z - s.a.z, r: s.b.r - s.a.r };
      const d2 = { z: nx.b.z - nx.a.z, r: nx.b.r - nx.a.r };
      const cross = d1.z * d2.r - d1.r * d2.z;
      const dot = d1.z * d2.z + d1.r * d2.r;
      const l1 = Math.hypot(d1.z, d1.r);
      const l2 = Math.hypot(d2.z, d2.r);
      const sinT = cross / (l1 * l2);
      if (Math.abs(sinT) < 1e-6 && dot > 0) {
        paths[s.m].push(Bk);
      } else if (sideOf * sinT > 0 || (Math.abs(sinT) < 1e-6 && dot < 0)) {
        // 볼록 모서리: 꼭짓점을 중심으로 노즈가 돌아간다
        paths[s.m].push(Bk);
        const a0 = Math.atan2(nk.r, nk.z);
        let a1 = Math.atan2(nn.r, nn.z);
        const turn = Math.sign(cross) || 1;
        while ((a1 - a0) * turn < 0) a1 += turn * Math.PI * 2;
        const steps = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (5 * (Math.PI / 180))));
        for (let j = 1; j < steps; j++) {
          const a = a0 + ((a1 - a0) * j) / steps;
          paths[s.m].push({ z: s.b.z + R * Math.cos(a), r: s.b.r + R * Math.sin(a) });
        }
        paths[nx.m].push(An);
      } else {
        // 오목 모서리: 일단 두 보정선 끝을 그대로 잇는다. 꼬인 부분(교점)은 아래에서 한꺼번에 잘라낸다
        paths[s.m].push(Bk);
        paths[nx.m].push(An);
      }
    }

    // 오목 모서리에서 보정선끼리 엇갈려 생긴 고리를 교점에서 잘라낸다.
    // 원호를 잘게 나눈 조각 여러 개를 넘어가는 경우(직선 → 원호, 원호 → 벽)도 같이 처리된다.
    // (급속 이동끼리는 원래 엇갈릴 수 있으니 둘 중 하나는 절삭 이동일 때만)
    const flat = paths.flatMap((pth, mi) => pth.map((p) => ({ p, m: mi })));
    const feedSeg = (k: number) => body[flat[k + 1].m].kind !== 'rapid';
    // 마지막 절삭 뒤의 급속(G70 이 시작점으로 돌아가는 이동 등)은 형상을 가로지르므로 잘라낼 고리로 보지 않는다
    let lastFeed = -1;
    body.forEach((m, mi) => {
      if (m.kind !== 'rapid') lastFeed = mi;
    });
    const trailing = (k: number) => flat[k + 1].m > lastFeed;
    for (let i = 0; i + 1 < flat.length; i++) {
      if (trailing(i)) break;
      for (let j = Math.min(flat.length - 2, i + 400); j >= i + 2; j--) {
        if (trailing(j)) continue;
        if (!feedSeg(i) && !feedSeg(j)) continue;
        const X = segCross(flat[i].p, flat[i + 1].p, flat[j].p, flat[j + 1].p);
        if (X) {
          flat.splice(i + 1, j - i, { p: X, m: flat[i + 1].m });
          break;
        }
      }
    }
    paths.forEach((pth) => (pth.length = 0));
    for (const f of flat) paths[f.m].push(f.p);

    // 노즈 중심 경로 → 가상 인선점 경로
    // 마지막 절삭 뒤의 급속은 보정하지 않고 지령한 점으로 (보정해서 옮기면 바닥·벽 쪽으로 파고들 수 있다)
    const tipPaths = paths.map((pth, mi) => (mi > lastFeed && lastFeed >= 0 ? body[mi].pts.slice(1).map((p) => ({ ...p })) : pth.map((p) => add(p, tip))));
    emit(startup, [{ ...this.pos }, tipPaths.find((p) => p.length)![0]]);
    body.forEach((m, mi) => {
      if (tipPaths[mi].length) emit(m, [{ ...this.pos }, ...tipPaths[mi]]);
    });
    emit(cancel, [{ ...this.pos }, cancel.pts[cancel.pts.length - 1]]);
    this.loadState(keep);
  }
}

/** 원호를 폴리라인으로 (시작점 포함). z 가로(오른쪽 +), r 세로(위 +) 기준 G03 = 반시계 */
export function arcPoints(s: Vec, e: Vec, c: Vec, ccw: boolean): Vec[] {
  const a0 = Math.atan2(s.r - c.r, s.z - c.z);
  const a1 = Math.atan2(e.r - c.r, e.z - c.z);
  const TAU = Math.PI * 2;
  let sweep = ccw ? a1 - a0 : a0 - a1;
  while (sweep <= 1e-9) sweep += TAU;
  if (sweep > TAU) sweep -= TAU;
  const r0 = dist(s, c);
  const r1 = dist(e, c);
  const n = Math.max(2, Math.ceil(sweep / (2 * (Math.PI / 180))), Math.ceil((Math.max(r0, r1) * sweep) / 0.5));
  const pts: Vec[] = [{ ...s }];
  for (let k = 1; k < n; k++) {
    const f = k / n;
    const a = a0 + (ccw ? 1 : -1) * sweep * f;
    const rr = r0 + (r1 - r0) * f;
    pts.push({ z: c.z + rr * Math.cos(a), r: c.r + rr * Math.sin(a) });
  }
  pts.push({ ...e });
  return pts;
}

/** 두 선분이 끝점이 아닌 곳에서 만나면 그 점 */
function segCross(a: Vec, b: Vec, c: Vec, d: Vec): Vec | null {
  const r = { z: b.z - a.z, r: b.r - a.r };
  const s = { z: d.z - c.z, r: d.r - c.r };
  const den = r.z * s.r - r.r * s.z;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.z - a.z) * s.r - (c.r - a.r) * s.z) / den;
  const u = ((c.z - a.z) * r.r - (c.r - a.r) * r.z) / den;
  const e = 1e-9;
  if (t <= e || t >= 1 - e || u <= e || u >= 1 - e) return null;
  return { z: a.z + r.z * t, r: a.r + r.r * t };
}
