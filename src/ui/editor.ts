import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet } from '@codemirror/view';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

const gcode = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^\([^)]*\)?/)) return 'comment';
    if (stream.match(';')) return 'punctuation';
    if (stream.match('/')) return 'operator';
    if (stream.match(/^G\s*[0-9.]+/i)) return 'keyword';
    if (stream.match(/^M\s*[0-9]+/i)) return 'atom';
    if (stream.match(/^T\s*[0-9]+/i)) return 'typeName';
    if (stream.match(/^[ON]\s*[0-9]+/i)) return 'meta';
    if (stream.match(/^[XZUW]\s*[-+0-9.,]*/i)) return 'variableName';
    if (stream.match(/^[IKR]\s*[-+0-9.,]*/i)) return 'string';
    if (stream.match(/^[FSPQ]\s*[-+0-9.,]*/i)) return 'number';
    stream.next();
    return 'invalid';
  },
});

const style = HighlightStyle.define([
  { tag: tags.keyword, color: '#ff9f43', fontWeight: '600' },
  { tag: tags.atom, color: '#ff6b9a' },
  { tag: tags.typeName, color: '#c387ff' },
  { tag: tags.meta, color: '#7f8ea3' },
  { tag: tags.variableName, color: '#e6edf3' },
  { tag: tags.string, color: '#7ee0ff' },
  { tag: tags.number, color: '#3ddc97' },
  { tag: tags.comment, color: '#6a7a8c', fontStyle: 'italic' },
  { tag: tags.punctuation, color: '#7f8ea3' },
  { tag: tags.invalid, color: '#ff5d5d', textDecoration: 'underline wavy' },
]);

const theme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '15px', backgroundColor: 'var(--panel)', color: 'var(--text)' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
    '.cm-gutters': { backgroundColor: 'var(--panel-2)', color: 'var(--muted)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--panel-3)' },
    '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: '#2f4a6b !important' },
    '.cm-exec-line': { backgroundColor: 'rgba(255, 181, 71, 0.22)', boxShadow: 'inset 3px 0 0 #ffb547' },
    '.cm-error-line': { backgroundColor: 'rgba(255, 93, 93, 0.2)', boxShadow: 'inset 3px 0 0 #ff5d5d' },
    '.cm-warn-line': { boxShadow: 'inset 3px 0 0 #e8c547' },
    '&.cm-readonly .cm-line': { cursor: 'pointer' },
    '&.cm-readonly .cm-line:hover': { backgroundColor: 'rgba(122, 162, 255, 0.12)' },
  },
  { dark: true },
);

interface Marks {
  exec: number | null;
  errors: number[];
  warns: number[];
}
const setMarks = StateEffect.define<Marks>();

const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      const doc = tr.state.doc;
      const cls = new Map<number, string[]>();
      const add = (ln: number, c: string) => {
        if (ln < 0 || ln >= doc.lines) return;
        cls.set(ln, [...(cls.get(ln) ?? []), c]);
      };
      e.value.warns.forEach((l) => add(l, 'cm-warn-line'));
      e.value.errors.forEach((l) => add(l, 'cm-error-line'));
      if (e.value.exec !== null) add(e.value.exec, 'cm-exec-line');
      const b = new RangeSetBuilder<Decoration>();
      [...cls.keys()]
        .sort((a, c) => a - c)
        .forEach((ln) => b.add(doc.line(ln + 1).from, doc.line(ln + 1).from, Decoration.line({ class: cls.get(ln)!.join(' ') })));
      deco = b.finish();
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export class NcEditor {
  view: EditorView;
  private editable = new Compartment();
  private lastExec: number | null = null;
  private marks: Marks = { exec: null, errors: [], warns: [] };
  private readOnly = false;
  /** 실행 중(읽기 전용)일 때 코드 줄을 클릭하면 불린다 */
  onLineClick: ((line: number) => void) | null = null;
  /** 커서가 다른 줄로 옮겨가거나 내용이 바뀌면 불린다 (0부터 시작하는 줄) */
  onCursorLine: ((line: number) => void) | null = null;

  constructor(parent: HTMLElement, doc: string, onChange: (text: string) => void, extra: Extension[] = []) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
          gcode,
          extra,
          syntaxHighlighting(style),
          theme,
          marksField,
          this.editable.of(EditorView.editable.of(true)),
          EditorView.domEventHandlers({
            mousedown: (e, view) => {
              if (!this.readOnly || !this.onLineClick || e.button !== 0) return false;
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos === null) return false;
              this.onLineClick(view.state.doc.lineAt(pos).number - 1);
              return true;
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChange(u.state.doc.toString());
            if (u.docChanged || u.selectionSet) this.onCursorLine?.(this.cursorLine);
          }),
        ],
      }),
    });
  }

  get cursorLine(): number {
    return this.view.state.doc.lineAt(this.view.state.selection.main.head).number - 1;
  }

  get text() {
    return this.view.state.doc.toString();
  }

  set text(t: string) {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: t } });
  }

  setReadOnly(ro: boolean) {
    this.readOnly = ro;
    this.view.dom.classList.toggle('cm-readonly', ro);
    this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(!ro)) });
  }

  setDiagnostics(errors: number[], warns: number[]) {
    this.marks = { ...this.marks, errors, warns };
    this.view.dispatch({ effects: setMarks.of(this.marks) });
  }

  setExecLine(line: number | null) {
    if (line === this.lastExec) return;
    this.lastExec = line;
    this.marks = { ...this.marks, exec: line };
    const effects: StateEffect<unknown>[] = [setMarks.of(this.marks)];
    if (line !== null && line < this.view.state.doc.lines)
      effects.push(EditorView.scrollIntoView(this.view.state.doc.line(line + 1).from, { y: 'nearest' }));
    this.view.dispatch({ effects });
  }

  /** 커서가 있는 줄 다음에 여러 줄을 넣는다 (읽기 전용이면 false) */
  insertLines(text: string): boolean {
    if (this.readOnly) return false;
    const line = this.view.state.doc.lineAt(this.view.state.selection.main.head);
    // 빈 줄이면 그 자리에, 아니면 다음 줄에 넣는다
    const blank = !line.text.trim();
    const insert = (blank ? '' : '\n') + text;
    const from = blank ? line.from : line.to;
    this.view.dispatch({
      changes: { from, to: line.to, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
    });
    this.view.focus();
    return true;
  }

  gotoLine(line: number) {
    if (line < 0 || line >= this.view.state.doc.lines) return;
    const l = this.view.state.doc.line(line + 1);
    this.view.dispatch({ selection: { anchor: l.from, head: l.to }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
    this.view.focus();
  }
}
