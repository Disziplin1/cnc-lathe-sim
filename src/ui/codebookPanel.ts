import { searchCodes, type CodeKind } from '../nc/codebook';
import { codeCard, codeHead } from './codeinfo';

/** "코드 사전" 탭: 검색 + 종류 필터 + 설명 카드 목록 */
export class CodebookPanel {
  private input: HTMLInputElement;
  private list: HTMLElement;
  private count: HTMLElement;
  private kind: CodeKind | 'all' = 'all';

  constructor(
    host: HTMLElement,
    private onInsert: (example: string) => void,
  ) {
    host.innerHTML = `
      <div class="cb-top">
        <input type="search" class="cb-search" placeholder="검색: G71, M3, 나사, 원호, 회전수 …" />
        <div class="cb-chips">
          <button data-kind="all" class="active">전체</button>
          <button data-kind="G">G코드</button>
          <button data-kind="M">M코드</button>
          <button data-kind="addr">어드레스</button>
          <span class="cb-count muted"></span>
        </div>
        <p class="muted small cb-hint">Fanuc 0i-TF 선반 G코드 체계 A 기준. 편집기에서 코드에 마우스를 올려도 설명이 나옵니다.</p>
      </div>
      <div class="cb-list"></div>`;
    this.input = host.querySelector('.cb-search')!;
    this.list = host.querySelector('.cb-list')!;
    this.count = host.querySelector('.cb-count')!;
    this.input.addEventListener('input', () => this.render());
    host.querySelectorAll<HTMLButtonElement>('.cb-chips button').forEach((b) => {
      b.onclick = () => {
        this.kind = b.dataset.kind as CodeKind | 'all';
        host.querySelectorAll('.cb-chips button').forEach((x) => x.classList.toggle('active', x === b));
        this.render();
      };
    });
    this.render();
  }

  /** 검색어를 넣고 보여 준다. 정확히 같은 코드가 있으면 펼친다 */
  show(query: string) {
    this.input.value = query;
    this.render(query);
    this.list.scrollTop = 0;
  }

  focus() {
    this.input.focus();
  }

  private render(openCode?: string) {
    const found = searchCodes(this.input.value, this.kind);
    this.count.textContent = `${found.length}개`;
    // 한 줄(번호·이름)만 보이고, 누르면 설명이 펼쳐진다
    this.list.replaceChildren(
      ...found.map((c) => {
        const item = document.createElement('details');
        item.className = 'cb-item';
        const sum = document.createElement('summary');
        sum.append(codeHead(c));
        item.append(sum);
        // 펼칠 때 처음 한 번만 카드를 만든다
        const fill = () => {
          if (item.childElementCount === 1) item.append(codeCard(c, { noHead: true, onInsert: this.onInsert }));
        };
        item.addEventListener('toggle', () => item.open && fill());
        if (openCode && c.code === openCode) {
          fill();
          item.open = true;
        }
        return item;
      }),
    );
    if (!found.length) {
      const p = document.createElement('p');
      p.className = 'muted cb-empty';
      p.textContent = '찾는 코드가 없습니다.';
      this.list.append(p);
    }
  }
}
