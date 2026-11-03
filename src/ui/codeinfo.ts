import { hoverTooltip } from '@codemirror/view';
import { SUPPORT_LABEL, explainWord, type CodeInfo, type WordExplain } from '../nc/codebook';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** 코드 번호 · 이름 · 모달 · 지원 표시 한 줄 */
export function codeHead(info: CodeInfo): HTMLElement {
  const head = h('div', 'cc-head');
  head.append(h('span', 'cc-code', info.code), h('span', 'cc-name', info.name));
  if (info.modal) head.append(h('span', 'cc-tag', '모달'));
  head.append(h('span', `cc-tag support-${info.support}`, SUPPORT_LABEL[info.support]));
  return head;
}

/** 코드 하나의 설명 카드 (사전 목록과 마우스 설명이 같이 씀) */
export function codeCard(info: CodeInfo, opts: { compact?: boolean; noHead?: boolean; onInsert?: (example: string) => void } = {}): HTMLElement {
  const card = h('div', 'code-card' + (opts.compact ? ' compact' : ''));
  if (!opts.noHead) card.append(codeHead(info));
  card.append(h('p', 'cc-desc', info.desc));
  if (info.format?.length) {
    const f = h('div', 'cc-format');
    info.format.forEach((line) => f.append(h('code', '', line)));
    card.append(f);
  }
  const table = (title: string, rows?: Record<string, string>) => {
    if (!rows || opts.compact) return;
    const t = h('div', 'cc-params');
    t.append(h('div', 'cc-sub', title));
    for (const [k, v] of Object.entries(rows)) {
      const row = h('div', 'cc-row');
      row.append(h('b', 'mono', k), h('span', '', v));
      t.append(row);
    }
    card.append(t);
  };
  table(info.params1 ? '첫 블록' : '어드레스', info.params1 ?? info.params);
  if (info.params1) table('둘째 블록', info.params);
  if (info.note) card.append(h('p', 'cc-note', '※ ' + info.note));
  if (info.example && !opts.compact) {
    const ex = h('div', 'cc-example');
    ex.append(h('span', 'cc-sub', '예시'), h('pre', 'mono', info.example));
    if (opts.onInsert) {
      const b = h('button', '', '편집기에 넣기');
      b.onclick = () => opts.onInsert!(info.example!);
      ex.append(b);
    }
    card.append(ex);
  }
  return card;
}

function wordTip(x: WordExplain, onOpen: (code: string) => void): HTMLElement {
  const box = h('div', 'code-tip');
  if (x.info) {
    box.append(codeCard(x.info, { compact: true }));
  } else {
    box.append(h('div', 'cc-head', x.title), h('p', 'cc-desc', '알 수 없는 코드입니다. 이 시뮬레이터와 Fanuc 선반 기본 코드에 없습니다.'));
  }
  if (x.value) box.append(h('p', 'tip-value', '= ' + x.value));
  if (x.context) box.append(h('p', 'tip-context', x.context));
  if (x.info) {
    const more = h('button', 'tip-more', '코드 사전에서 자세히 →');
    more.onmousedown = (e) => {
      e.preventDefault();
      onOpen(x.info!.kind === 'addr' ? x.info!.code : x.info!.code);
    };
    box.append(more);
  }
  return box;
}

/** 편집기에서 G·M코드·어드레스에 마우스를 올리면 설명을 띄운다 */
export function codeHover(onOpen: (code: string) => void) {
  return hoverTooltip(
    (view, pos) => {
      const line = view.state.doc.lineAt(pos);
      // 주석 안은 설명하지 않는다
      const masked = line.text.replace(/\([^)]*\)?/g, (m) => ' '.repeat(m.length));
      // 같은 줄에 블록이 여러 개(;)면 마우스가 있는 블록만
      const col = pos - line.from;
      const blockStart = masked.lastIndexOf(';', col - 1) + 1;
      const blockEndRaw = masked.indexOf(';', col);
      const block = masked.slice(blockStart, blockEndRaw < 0 ? undefined : blockEndRaw);
      for (const m of masked.matchAll(/([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))?/g)) {
        const start = m.index!;
        const end = start + m[0].length;
        if (col < start || col > end) continue;
        if (!m[2] && !'GMXZUWRIKFSTPQON'.includes(m[1].toUpperCase())) return null;
        const x = explainWord(m[1], m[2] ?? '', block);
        return {
          pos: line.from + start,
          end: line.from + end,
          above: true,
          create: () => ({ dom: wordTip(x, onOpen) }),
        };
      }
      return null;
    },
    { hoverTime: 250 },
  );
}
