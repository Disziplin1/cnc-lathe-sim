import './style.css';
import { compile, type MachineConfig } from './nc/interpreter';
import type { DecimalMode } from './nc/lexer';
import type { Alarm, Program, Vec } from './nc/types';
import {
  MAX_OFFSETS,
  MAX_TOOLS,
  TOOL_COLOR,
  TOOL_LABEL,
  USES_NOSE,
  USES_WIDTH,
  defaultOffsets,
  defaultTools,
  normalizeTools,
  type ToolDef,
  type ToolOffset,
  type ToolType,
} from './machine/tools';
import { compareStock, parseTarget, threadRanges, type CompareResult, type Target } from './sim/compare';
import { dxfToTarget } from './sim/dxf';
import { Player, STATE_LABEL } from './sim/player';
import { normalizeStock, protrusionOf, type StockConfig } from './sim/simulator';
import { SAMPLES } from './samples';
import { NcEditor } from './ui/editor';
import { codeHover } from './ui/codeinfo';
import { CodebookPanel } from './ui/codebookPanel';
import { View2D } from './ui/view2d';
import { View3D } from './ui/view3d';

// ------------------------------------------------------------ 설정 / 저장

interface Settings {
  stock: StockConfig;
  homeX: number;
  homeZ: number;
  rapidRate: number;
  maxRpm: number;
  decimalMode: DecimalMode;
  tools: ToolDef[];
  offsets: ToolOffset[];
}

const STORE_KEY = 'cnc-lathe-sim.v1';

const defaultSettings = (): Settings => ({
  stock: { ...SAMPLES[0].stock },
  homeX: 200,
  homeZ: 150,
  rapidRate: 15000,
  maxRpm: 4000,
  decimalMode: 'mm',
  tools: defaultTools(),
  offsets: defaultOffsets(),
});

function load(): { settings: Settings; program: string; drawing: string } {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      const st: Settings = { ...defaultSettings(), ...d.settings };
      // 1단계 때 저장한 설정에는 보링바·드릴·노즈 R 이 없으므로 새 기본 공구대로 바꾼다
      st.tools = d.settings?.offsets ? normalizeTools(st.tools) : defaultTools();
      st.stock = normalizeStock(st.stock);
      if (!Array.isArray(st.offsets) || st.offsets.length !== MAX_OFFSETS) st.offsets = defaultOffsets();
      return { settings: st, program: d.program ?? SAMPLES[0].code, drawing: d.drawing ?? SAMPLES[0].target ?? '' };
    }
  } catch {
    /* 저장소를 못 쓰면 기본값 */
  }
  return { settings: defaultSettings(), program: SAMPLES[0].code, drawing: SAMPLES[0].target ?? '' };
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ settings, program: editor.text, drawing: dwgEditor.text }));
    } catch {
      /* 무시 */
    }
  }, 500);
}

const machineConfig = (s: Settings, blockSkip: boolean): MachineConfig => ({
  home: { z: s.homeZ, r: s.homeX / 2 },
  rapidRate: s.rapidRate,
  maxRpm: s.maxRpm,
  decimalMode: s.decimalMode,
  blockSkip,
  tools: s.tools,
  offsets: s.offsets,
});

// ------------------------------------------------------------ DOM

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  sample: $<HTMLSelectElement>('sample'),
  messages: $('messages'),
  msgCount: $('msg-count'),
  progInfo: $('prog-info'),
  views: $('views'),
  hover: $('hover'),
  start: $<HTMLButtonElement>('btn-start'),
  hold: $<HTMLButtonElement>('btn-hold'),
  reset: $<HTMLButtonElement>('btn-reset'),
  finish: $<HTMLButtonElement>('btn-finish'),
  single: $<HTMLInputElement>('chk-single'),
  optStop: $<HTMLInputElement>('chk-optstop'),
  skip: $<HTMLInputElement>('chk-skip'),
  speed: $<HTMLInputElement>('speed'),
  timeline: $<HTMLInputElement>('timeline'),
  tlNow: $('tl-now'),
  tlEnd: $('tl-end'),
  qDia: $<HTMLInputElement>('q-dia'),
  qLen: $<HTMLInputElement>('q-len'),
  qGrip: $<HTMLInputElement>('q-grip'),
  qFace: $<HTMLInputElement>('q-face'),
  qInfo: $('q-info'),
  posX: $('pos-x'),
  posZ: $('pos-z'),
  state: $('st-state'),
  tool: $('st-tool'),
  feed: $('st-feed'),
  spindle: $('st-spindle'),
  coolant: $('st-coolant'),
  time: $('st-time'),
  modal: $('st-modal'),
  block: $('st-block'),
  note: $('st-note'),
  rapidOvr: $<HTMLSelectElement>('rapid-ovr'),
  fileInput: $<HTMLInputElement>('file-input'),
  cmp: $<HTMLInputElement>('chk-compare'),
  cmpBadge: $('compare'),
};

let { settings, program: initialProgram, drawing: initialDrawing } = load();

let prog: Program;
let player: Player;
let viewMode: '2d' | '3d' | 'both' = '2d';

const editor = new NcEditor(
  $('editor'),
  initialProgram,
  () => {
    save();
    scheduleCompile();
  },
  [codeHover((code) => openCodebook(code))],
);

// 도면(목표 형상) 편집기
let target: Target | null = null;
let targetError: Alarm | null = null;
let cmpResult: CompareResult | null = null;
let lastCmpVersion = -1;
let lastCmpTime = 0;
let dwgTimer = 0;
const dwgEditor = new NcEditor(
  $('editor-dwg'),
  initialDrawing,
  () => {
    save();
    clearTimeout(dwgTimer);
    dwgTimer = window.setTimeout(parseDrawing, 300);
  },
  [codeHover((code) => openCodebook(code))],
);

function parseDrawing() {
  const r = parseTarget(dwgEditor.text);
  target = r.target;
  targetError = r.error;
  dwgEditor.setDiagnostics(r.error ? [r.error.line] : [], []);
  lastCmpVersion = -1;
  cmpResult = null;
}

// DXF 도면 불러오기
const dxfFile = $<HTMLInputElement>('file-dxf');
const dxfInfo = $('dxf-info');
$('btn-dxf').onclick = () => dxfFile.click();
dxfFile.onchange = () => {
  const f = dxfFile.files?.[0];
  dxfFile.value = '';
  if (f) importDxf(f);
};

// 화면 어디에든 DXF 파일을 끌어다 놓으면 불러온다
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  document.body.classList.add('dropping');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dropping');
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  document.body.classList.remove('dropping');
  const files = [...(e.dataTransfer?.files ?? [])];
  const f = files.find((x) => /\.dxf$/i.test(x.name));
  showPane('dwg');
  if (f) importDxf(f);
  else {
    dxfInfo.classList.add('err');
    dxfInfo.textContent = `DXF 파일만 넣을 수 있습니다 (${files[0]?.name ?? ''})`;
  }
});

async function importDxf(f: File) {
  try {
    const r = dxfToTarget(await f.text(), { faceLeft: $<HTMLInputElement>('chk-dxf-left').checked, name: f.name });
    dwgEditor.text = r.text;
    parseDrawing();
    el.cmp.checked = true;
    dxfInfo.classList.remove('err');
    dxfInfo.textContent = `최대 Ø${r.maxDia.toFixed(1)} × 길이 ${r.length.toFixed(1)} · 직선 ${r.lines} · 원호 ${r.arcs}`;
  } catch (e) {
    dxfInfo.classList.add('err');
    dxfInfo.textContent = (e as Error).message;
  }
};

// 왼쪽 탭: 프로그램 / 도면 / 코드 사전
type Pane = 'prog' | 'dwg' | 'book';
function showPane(pane: Pane) {
  document.querySelectorAll<HTMLButtonElement>('.pane-tabs button[data-pane]').forEach((x) => x.classList.toggle('active', x.dataset.pane === pane));
  $('editor').hidden = pane !== 'prog';
  $('editor-dwg').hidden = pane !== 'dwg';
  $('dwg-bar').hidden = pane !== 'dwg';
  $('codebook').hidden = pane !== 'book';
  if (pane === 'dwg' && !el.cmp.checked) el.cmp.checked = true;
  lastCmpVersion = -1;
}
document.querySelectorAll<HTMLButtonElement>('.pane-tabs button[data-pane]').forEach((b) => {
  b.onclick = () => {
    showPane(b.dataset.pane as Pane);
    if (b.dataset.pane === 'book') codebook.focus();
  };
});

const codebook = new CodebookPanel($('codebook'), (example) => {
  showPane('prog');
  if (!editor.insertLines(example)) alert('실행 중에는 코드를 넣을 수 없습니다. ⟲ 리셋 후 다시 눌러 주세요.');
});
function openCodebook(code: string) {
  showPane('book');
  codebook.show(code);
}

const view2d = new View2D(
  $<HTMLCanvasElement>('view2d'),
  (p) => {
    if (!p) return void (el.hover.textContent = '');
    const off = currentOffset();
    el.hover.textContent = `X${(2 * (p.r - off.r)).toFixed(2)}  Z${(p.z - off.z).toFixed(2)}`;
  },
  (line) => editor.gotoLine(line),
);
const view3d = new View3D($('view3d'));

// ------------------------------------------------------------ 컴파일

let compileTimer = 0;
function scheduleCompile() {
  clearTimeout(compileTimer);
  compileTimer = window.setTimeout(rebuild, 300);
}

function rebuild() {
  prog = compile(editor.text, machineConfig(settings, el.skip.checked));
  const speed = player?.speed ?? 1;
  player = new Player(prog, settings.stock, settings.tools);
  player.speed = speed;
  player.rapidOverride = parseFloat(el.rapidOvr.value) || 1;
  player.singleBlock = el.single.checked;
  player.optionalStop = el.optStop.checked;
  editor.setReadOnly(false);
  editor.setExecLine(null);
  renderMessages();
  last3dVersion = -1;
  lastCmpVersion = -1;
  cmpResult = null;
  previewDirty = true;
}

function updateCompare(now: number, running: boolean) {
  const badge = el.cmpBadge;
  if (!el.cmp.checked) {
    badge.textContent = '';
    cmpResult = null;
    return;
  }
  if (targetError) {
    badge.textContent = `도면 오류 ${targetError.line + 1}행: ${targetError.message}`;
    badge.className = 'compare bad';
    return;
  }
  if (!target) {
    badge.textContent = '도면 탭에 목표 형상을 입력하세요';
    badge.className = 'compare';
    return;
  }
  if (player.sim.version !== lastCmpVersion && (!running || now - lastCmpTime > 400)) {
    lastCmpVersion = player.sim.version;
    lastCmpTime = now;
    const noseMax = Math.max(0, ...settings.tools.map((t) => t.noseR));
    cmpResult = compareStock(player.sim.stock, target, threadRanges(prog), noseMax * 1.6 + 0.05);
  }
  if (!cmpResult) return;
  const tol = 0.02;
  const ok = cmpResult.maxExcess <= tol && cmpResult.maxOver <= tol;
  const done = player.state === 'done';
  badge.className = 'compare ' + (done ? (ok ? 'good' : 'bad') : '');
  badge.textContent =
    `남은 살 ${cmpResult.maxExcess.toFixed(3)} · 과삭 ${cmpResult.maxOver.toFixed(3)} mm` +
    (done ? (ok ? '  ✓ 도면 일치 (±0.02)' : '  ✗ 도면과 다름') : '') +
    (cmpResult.excluded.length ? '  (나사 구간 제외)' : '');
}

function renderMessages() {
  const list: Alarm[] = [];
  const runtime = player.alarm && player.alarm !== prog.alarm ? player.alarm : null;
  if (runtime) list.push(runtime);
  if (prog.alarm) list.push(prog.alarm);
  list.push(...prog.warnings);
  el.messages.replaceChildren();
  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'ok';
    li.textContent = '✓ 문법 오류 없음';
    el.messages.append(li);
  }
  for (const a of list) {
    const li = document.createElement('li');
    li.className = a.level;
    li.innerHTML = `<span class="code"></span><span class="ln"></span><span class="msg"></span>`;
    li.querySelector('.code')!.textContent = a.code;
    li.querySelector('.ln')!.textContent = `${a.line + 1}행`;
    li.querySelector('.msg')!.textContent = a.message;
    li.onclick = () => editor.gotoLine(a.line);
    el.messages.append(li);
  }
  const alarms = list.filter((a) => a.level === 'alarm').length;
  const warns = list.length - alarms;
  el.msgCount.textContent = list.length ? `알람 ${alarms} · 경고 ${warns}` : '';
  const busy = player.state === 'run' || player.state === 'hold' || player.state === 'stop';
  el.progInfo.textContent = busy ? '· 줄을 클릭하면 그 블록부터 재생' : `· 예상 가공 시간 ${fmtTime(prog.duration)}`;
  editor.setDiagnostics(
    list.filter((a) => a.level === 'alarm').map((a) => a.line),
    list.filter((a) => a.level === 'warning').map((a) => a.line),
  );
}

// ------------------------------------------------------------ 표시

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const fmt3 = (v: number) => (Math.abs(v) < 0.0005 ? 0 : v).toFixed(3);

function currentOffset(): Vec {
  const { segIndex } = player.current();
  return segIndex >= 0 ? prog.segments[segIndex].snap.offset : { z: 0, r: 0 };
}

let last3dVersion = -1;
let last3dTime = 0;
let lastState = '';

// ---- 편집 중 커서 미리보기: 커서가 있는 블록까지 실행한 모습 ----
let previewDirty = true;

/** 줄 L 블록을 실행한 직후의 시간 */
function cursorTime(L: number): number {
  let own = -1;
  let upTo = 0;
  for (const s of prog.segments) {
    const end = s.start + s.duration;
    // 그 줄이 직접 만든 동작 (G70 이 실행한 형상 줄도 포함)
    if (s.line === L) own = Math.max(own, end);
    // 이동이 없는 줄이면 그 줄까지 메인 흐름이 실행된 시간
    if (s.top <= L) upTo = Math.max(upTo, end);
  }
  return own >= 0 ? own : upTo;
}

function updatePreview() {
  if (!previewDirty) return;
  previewDirty = false;
  // 끝났거나 알람인 상태에서 편집기를 건드리면 편집 모드(대기)로 돌아간다
  if (player.state === 'done' || player.state === 'alarm') {
    player.reset();
    renderMessages();
  }
  if (player.state !== 'ready') return;
  const before = player.alarm;
  player.setPreview(cursorTime(editor.cursorLine));
  if (player.alarm !== before) renderMessages();
  lastCmpVersion = -1;
}
editor.onCursorLine = () => (previewDirty = true);

function updateUi(now: number, dt: number) {
  const { pos, segIndex } = player.current();
  const seg = segIndex >= 0 ? prog.segments[segIndex] : null;
  const home = { z: settings.homeZ, r: settings.homeX / 2 };
  const p = pos ?? home;
  const snap = seg?.snap;
  const off = snap?.offset ?? { z: 0, r: 0 };
  const st = player.state;
  const running = st === 'run' || st === 'hold' || st === 'stop';
  const previewing = st === 'ready' && player.preview !== null;

  el.posX.textContent = fmt3(2 * (p.r - off.r));
  el.posZ.textContent = fmt3(p.z - off.z);
  el.state.textContent = previewing ? '편집 · 커서 줄 미리보기' : STATE_LABEL[st];
  el.state.style.color = st === 'alarm' ? 'var(--err)' : st === 'run' ? 'var(--accent)' : '';
  el.tool.textContent = snap?.T ?? 'T0000';
  const moving = running && seg && seg.start + seg.duration > player.time;
  el.feed.textContent = !seg
    ? '0'
    : seg.kind === 'rapid'
      ? `급속 ${seg.feed}`
      : seg.kind === 'feed' || seg.kind === 'thread'
        ? `${seg.kind === 'thread' ? seg.pitch : snap!.F}${snap!.modal.includes('G99') ? ' mm/rev' : ' mm/min'} (${Math.round(seg.feed)} mm/min)`
        : String(snap!.F);
  const ended = st === 'done';
  const rpm = snap && snap.spindle !== 'M05' && !ended ? Math.round(seg!.rpm) : 0;
  el.spindle.textContent = `${ended ? 'M05' : (snap?.spindle ?? 'M05')}  ${rpm} rpm`;
  el.coolant.textContent = snap?.coolant && !ended ? 'ON' : 'OFF';
  el.time.textContent = `${fmtTime(player.viewTime)} / ${fmtTime(prog.duration)}`;
  el.modal.textContent = snap ? snap.modal.join(' ') : 'G00 G97 G99 G21 G40 G18 G54';
  el.block.textContent = seg && (running || previewing || st === 'alarm' || st === 'done') ? editor.view.state.doc.line(seg.line + 1).text : '';
  // 사이클 안의 동작(코드에 안 보이는 후퇴·복귀)은 설명을 같이 보여 준다
  el.note.textContent = seg?.note && (running || previewing || st === 'alarm') ? '↳ ' + seg.note : '';

  // 버튼
  if (st !== lastState) {
    lastState = st;
    el.start.disabled = st === 'run';
    el.hold.disabled = st !== 'run';
    el.finish.disabled = st === 'run';
    editor.setReadOnly(running);
    el.progInfo.textContent = running
      ? '· 줄을 클릭하면 그 블록부터 재생'
      : `· 예상 가공 시간 ${fmtTime(prog.duration)}`;
    if (st === 'alarm' || st === 'done') renderMessages();
  }
  if (running) editor.setExecLine(seg?.line ?? null);
  else if (st === 'alarm' && player.alarm) editor.setExecLine(player.alarm.line);
  else editor.setExecLine(null);

  // 2D
  const shape = seg ? player.sim.shapeFor(seg.tool) ?? null : null;
  view2d.setFrame({
    prog,
    stock: player.sim.stock,
    stockCfg: settings.stock,
    tools: settings.tools,
    time: player.viewTime,
    toolPos: p,
    toolShape: shape,
    toolNo: seg?.tool ?? 0,
    offset: off,
    compare: el.cmp.checked && target ? { target, result: cmpResult } : null,
  });
  updateCompare(now, running);

  // 3D (소재 메시는 너무 자주 만들지 않는다)
  if (view3d.visible) {
    if (player.sim.version !== last3dVersion && (now - last3dTime > 120 || !running)) {
      last3dVersion = player.sim.version;
      last3dTime = now;
      view3d.setStock(player.sim.stock);
    }
    const def = settings.tools.find((t) => t.no === seg?.tool);
    view3d.setTool(def ?? null, shape, p, def ? TOOL_COLOR[def.type] : '#cccccc');
    view3d.render(moving || st === 'run' ? rpm : 0, dt);
  }
}

let lastFrame = performance.now();
function loop(now: number) {
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  player.tick(dt);
  updatePreview();
  updateTimeline();
  updateUi(now, dt);
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------ 이벤트

el.start.onclick = () => {
  player.start();
  // 다음 화면 갱신을 기다리지 않고 바로 '줄 클릭 = 그 블록부터 재생' 상태로
  editor.setReadOnly(true);
};
el.hold.onclick = () => player.hold();
el.reset.onclick = () => {
  player.reset();
  previewDirty = true;
  renderMessages();
  last3dVersion = -1;
};
el.finish.onclick = () => {
  player.finish();
  renderMessages();
};
el.single.onchange = () => (player.singleBlock = el.single.checked);
el.optStop.onchange = () => (player.optionalStop = el.optStop.checked);
el.skip.onchange = rebuild;

/** 재생 배속: 0.1 ~ 200, 0.1 단위 */
function setSpeed(v: number) {
  v = Math.min(200, Math.max(0.1, Math.round(v * 10) / 10));
  player.speed = v;
  el.speed.value = String(v);
  document.querySelectorAll<HTMLButtonElement>('.speed-presets button').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === v));
}
/** 누르고 있으면 계속 바뀌는 버튼 */
function holdRepeat(btn: HTMLElement, fn: () => void) {
  let timer = 0;
  const stop = () => clearTimeout(timer);
  btn.addEventListener('pointerdown', () => {
    fn();
    const again = (delay: number) => (timer = window.setTimeout(() => (fn(), again(60)), delay));
    again(400);
  });
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointerleave', stop);
}
holdRepeat($('spd-up'), () => setSpeed(player.speed + 0.1));
holdRepeat($('spd-down'), () => setSpeed(player.speed - 0.1));
el.speed.addEventListener('change', () => setSpeed(parseFloat(el.speed.value) || 1));
document.querySelectorAll<HTMLButtonElement>('.speed-presets button').forEach((b) => (b.onclick = () => setSpeed(Number(b.dataset.speed))));
el.rapidOvr.onchange = () => (player.rapidOverride = parseFloat(el.rapidOvr.value) || 1);

/** 줄 번호 → 그 블록이 처음 실행되는 시간 (이동이 없는 줄이면 다음 이동 줄) */
function lineStartTime(line: number): number | null {
  // G70·G71 처럼 다른 줄을 실행시키는 블록은 그 블록이 시작한 첫 동작
  const own = prog.segments.find((s) => s.top === line);
  if (own) return own.start;
  let best: { line: number; start: number } | null = null;
  for (const s of prog.segments) {
    if (s.line < line) continue;
    if (!best || s.line < best.line) best = { line: s.line, start: s.start };
    if (s.line === line) break;
  }
  return best?.start ?? null;
}

editor.onLineClick = (line) => {
  const t = lineStartTime(line);
  if (t === null) return;
  player.seek(t);
  last3dVersion = -1;
  lastCmpVersion = -1;
  renderMessages();
};

window.addEventListener('keydown', (e) => {
  if (e.key === 'F5') {
    e.preventDefault();
    player.start();
  } else if (e.key === 'F6') {
    e.preventDefault();
    player.hold();
  }
});

document.querySelectorAll<HTMLButtonElement>('.view-tabs button[data-view]').forEach((b) => {
  b.onclick = () => {
    viewMode = b.dataset.view as typeof viewMode;
    document.querySelectorAll('.view-tabs button[data-view]').forEach((x) => x.classList.toggle('active', x === b));
    el.views.className = `views mode-${viewMode}`;
    view3d.visible = viewMode !== '2d';
    last3dVersion = -1;
  };
});
$('btn-fit').onclick = () => view2d.fit();

// 예제
el.sample.innerHTML = `<option value="">예제 불러오기…</option>` + SAMPLES.map((s) => `<option value="${s.id}">${s.title}</option>`).join('');
el.sample.onchange = () => {
  const s = SAMPLES.find((x) => x.id === el.sample.value);
  el.sample.value = '';
  if (!s) return;
  if (!confirm(`"${s.title}" 예제로 바꿀까요?\n지금 편집 중인 코드는 사라집니다.`)) return;
  settings.stock = { ...s.stock };
  view3d.setStockConfig(settings.stock);
  fillStockBar();
  editor.text = s.code;
  dwgEditor.text = s.target ?? '';
  parseDrawing();
  el.cmp.checked = !!s.target;
  rebuild();
  view2d.fit();
  save();
};

// 파일
$('btn-open').onclick = () => el.fileInput.click();
el.fileInput.onchange = async () => {
  const f = el.fileInput.files?.[0];
  if (!f) return;
  editor.text = await f.text();
  el.fileInput.value = '';
  rebuild();
};
$('btn-save').onclick = () => {
  const m = /O\s*(\d+)/i.exec(editor.text);
  const name = m ? `O${m[1].padStart(4, '0')}.nc` : 'program.nc';
  const url = URL.createObjectURL(new Blob([editor.text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

// 도움말
$('btn-help').onclick = () => $<HTMLDialogElement>('dlg-help').showModal();

// 설정
const dlg = $<HTMLDialogElement>('dlg-settings');
const num = (id: string) => $<HTMLInputElement>(id);
$('btn-settings').onclick = () => {
  num('s-homex').value = String(settings.homeX);
  num('s-homez').value = String(settings.homeZ);
  num('s-rapid').value = String(settings.rapidRate);
  num('s-maxrpm').value = String(settings.maxRpm);
  $<HTMLSelectElement>('s-decimal').value = settings.decimalMode;
  const body = $('s-tools');
  body.replaceChildren();
  for (let n = 1; n <= MAX_TOOLS; n++) {
    const t = settings.tools.find((x) => x.no === n);
    const tr = document.createElement('tr');
    const opts = (['', 'rough', 'finish', 'groove', 'thread', 'boring', 'drill'] as const)
      .map((k) => `<option value="${k}" ${(t?.type ?? '') === k ? 'selected' : ''}>${k ? TOOL_LABEL[k] : '— 없음 —'}</option>`)
      .join('');
    tr.innerHTML = `<td class="mono">T${String(n).padStart(2, '0')}</td><td><select data-no="${n}">${opts}</select></td><td><input type="number" min="0.5" max="40" step="0.5" data-w="${n}" value="${t?.width ?? 3}" /></td><td><input type="number" min="0" max="2" step="0.1" data-nr="${n}" value="${t?.noseR ?? 0}" /></td>`;
    body.append(tr);
  }
  dlg.showModal();
};
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'ok') return;
  const v = (id: string, def: number) => {
    const x = parseFloat(num(id).value);
    return Number.isFinite(x) ? x : def;
  };
  const tools: ToolDef[] = [];
  dlg.querySelectorAll<HTMLSelectElement>('select[data-no]').forEach((s) => {
    if (!s.value) return;
    const no = Number(s.dataset.no);
    const type = s.value as ToolType;
    const w = parseFloat(dlg.querySelector<HTMLInputElement>(`input[data-w="${no}"]`)!.value) || 3;
    const nr = parseFloat(dlg.querySelector<HTMLInputElement>(`input[data-nr="${no}"]`)!.value) || 0;
    tools.push({ no, type, width: USES_WIDTH.includes(type) ? w : 3, noseR: USES_NOSE.includes(type) ? Math.max(0, nr) : 0 });
  });
  settings = {
    stock: settings.stock,
    homeX: v('s-homex', 200),
    homeZ: v('s-homez', 150),
    rapidRate: Math.max(1000, v('s-rapid', 15000)),
    maxRpm: Math.max(100, v('s-maxrpm', 4000)),
    decimalMode: $<HTMLSelectElement>('s-decimal').value as DecimalMode,
    tools,
    offsets: settings.offsets,
  };
  view3d.setStockConfig(settings.stock);
  rebuild();
  view2d.fit();
  save();
});

// 공구 보정 화면
const dlgOff = $<HTMLDialogElement>('dlg-offsets');
function openOffsets() {
  const body = $('o-rows');
  body.replaceChildren();
  settings.offsets.forEach((o, i) => {
    const tr = document.createElement('tr');
    const cell = (k: keyof ToolOffset, step: string) =>
      `<td><input type="number" step="${step}" data-o="${i}" data-k="${k}" value="${o[k]}" /></td>`;
    tr.innerHTML = `<td class="mono">${String(i + 1).padStart(2, '0')}</td>${cell('X', '0.01')}${cell('Z', '0.01')}${cell('R', '0.1')}${cell('T', '1')}`;
    body.append(tr);
  });
  if (!dlgOff.open) dlgOff.showModal();
}
$('btn-offsets').onclick = openOffsets;
$('o-reset').onclick = (e) => {
  e.preventDefault();
  if (!confirm('공구 보정을 기본값으로 되돌릴까요?')) return;
  settings.offsets = defaultOffsets();
  openOffsets();
};
dlgOff.addEventListener('close', () => {
  if (dlgOff.returnValue !== 'ok') return;
  const next = settings.offsets.map((o) => ({ ...o }));
  dlgOff.querySelectorAll<HTMLInputElement>('input[data-o]').forEach((inp) => {
    const v = parseFloat(inp.value);
    const o = next[Number(inp.dataset.o)];
    const k = inp.dataset.k as keyof ToolOffset;
    o[k] = Number.isFinite(v) ? (k === 'T' ? Math.max(0, Math.min(9, Math.round(v))) : k === 'R' ? Math.max(0, v) : v) : 0;
  });
  settings.offsets = next;
  rebuild();
  save();
});
el.cmp.onchange = () => {
  lastCmpVersion = -1;
};

// ------------------------------------------------------------ 소재 크기

function fillStockBar() {
  const s = settings.stock;
  el.qDia.value = String(s.diameter);
  el.qLen.value = String(s.length);
  el.qGrip.value = String(s.grip);
  el.qFace.value = String(s.faceAllowance);
  showStockInfo(s);
}

function showStockInfo(s: StockConfig, error = '') {
  el.qInfo.textContent = error || `→ 척 밖 ${+protrusionOf(s).toFixed(2)} mm (Z0 ~ Z-${+protrusionOf(s).toFixed(2)})`;
  el.qInfo.className = error ? 'bad-text' : 'muted';
}

let stockTimer = 0;
function onStockInput() {
  clearTimeout(stockTimer);
  stockTimer = window.setTimeout(() => {
    const num = (i: HTMLInputElement) => parseFloat(i.value);
    const s: StockConfig = { diameter: num(el.qDia), length: num(el.qLen), grip: num(el.qGrip), faceAllowance: num(el.qFace) };
    let err = '';
    if (![s.diameter, s.length, s.grip, s.faceAllowance].every(Number.isFinite)) err = '숫자를 입력하세요';
    else if (s.diameter < 5 || s.diameter > 300) err = '지름은 5 ~ 300 mm';
    else if (s.grip < 5) err = '척 물림은 5 mm 이상';
    else if (s.faceAllowance < 0) err = '끝면 여유는 0 이상';
    else if (protrusionOf(s) < 5) err = '길이가 너무 짧습니다 (길이 > 물림 + 끝면 여유 + 5)';
    if (err) return showStockInfo(s, err);
    settings.stock = s;
    showStockInfo(s);
    view3d.setStockConfig(s);
    rebuild();
    view2d.fit();
    save();
  }, 400);
}
for (const i of [el.qDia, el.qLen, el.qGrip, el.qFace]) i.addEventListener('input', onStockInput);

// ------------------------------------------------------------ 재생 바

let scrubbing = false;
let scrubTarget: number | null = null;
el.timeline.addEventListener('pointerdown', () => (scrubbing = true));
window.addEventListener('pointerup', () => (scrubbing = false));
el.timeline.addEventListener('input', () => {
  scrubTarget = (parseFloat(el.timeline.value) / 1000) * prog.duration;
});

/** 매 프레임: 끌고 있으면 그 시점으로 이동(일시정지), 아니면 현재 시간 표시 */
function updateTimeline() {
  if (scrubTarget !== null) {
    player.seek(scrubTarget, false);
    scrubTarget = null;
    last3dVersion = -1;
    lastCmpVersion = -1;
    renderMessages();
  }
  if (!scrubbing) el.timeline.value = String(prog.duration > 0 ? Math.round((player.time / prog.duration) * 1000) : 0);
  el.tlNow.textContent = fmtTime(player.time);
  el.tlEnd.textContent = fmtTime(prog.duration);
}

// ------------------------------------------------------------ 시작

fillStockBar();
parseDrawing();

view3d.setStockConfig(settings.stock);
rebuild();
setSpeed(1);
requestAnimationFrame(loop);
