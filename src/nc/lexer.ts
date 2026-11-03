import type { Alarm } from './types';

/**
 * 소수점 없는 좌표값 처리 방식
 * - mm: mm 로 해석하고 경고 (연습용 기본값)
 * - fanuc: 실제 Fanuc 처럼 0.001mm 단위로 해석 (X50 = 0.05mm) 하고 경고
 * - strict: 알람 (STEP 학습 프로그램과 같은 방식)
 */
export type DecimalMode = 'mm' | 'fanuc' | 'strict';

export interface Word {
  letter: string;
  value: number;
  raw: string;
  hasDot: boolean;
}

export interface Block {
  line: number;
  text: string;
  words: Word[];
  /** '/' 로 시작하는 블록 (옵셔널 블록 스킵 대상) */
  skip: boolean;
  eob: boolean;
  error?: Alarm;
}

const DIMENSION = 'XZUWIKR';
const INTEGER_ONLY = 'GMSTPQON';
const SUPPORTED = 'GMXZUWIKRFSTPQON';

export function lex(src: string, mode: DecimalMode, warnings: Alarm[]): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r/g, '').split('\n');

  for (let ln = 0; ln < lines.length; ln++) {
    // 전각 문자(한글 입력기의 ０-９ Ｘ ． 등)는 반각으로, 괄호 주석은 제거
    const s = lines[ln].normalize('NFKC').replace(/。/g, '.').toUpperCase().replace(/\([^)]*\)?/g, ' ');
    if (s.trim() === '%') continue;
    const pieces = s.split(';');
    let dotWarned = false;
    let commaWarned = false;

    for (let p = 0; p < pieces.length; p++) {
      const eob = p < pieces.length - 1;
      const text = pieces[p].trim();
      if (!text) continue;

      const block: Block = { line: ln, text, words: [], skip: false, eob };
      const fail = (message: string, code = 'PS0010') => {
        if (!block.error) block.error = { code, message, line: ln, level: 'alarm' };
      };

      if (!eob && mode === 'strict') fail('EOB(;)가 없습니다', 'PS1016');
      // G73 첫 블록의 R 은 분할 횟수(정수)
      const g73 = /G0*73(?![0-9.])/.test(text);

      let i = 0;
      while (i < text.length && !block.error) {
        const c = text[i];
        if (c === ' ' || c === '\t') {
          i++;
          continue;
        }
        if (c === '/') {
          if (block.words.length > 0) fail("'/'(블록 스킵)는 블록 맨 앞에만 쓸 수 있습니다");
          block.skip = true;
          i++;
          continue;
        }
        if (c < 'A' || c > 'Z') {
          fail(`'${c}' : 어드레스(알파벳) 없이 값이 시작됩니다`);
          break;
        }
        // 쉼표를 소수점으로 잘못 친 경우(X20,5)도 받아 준다
        const m = /^\s*([+-]?(?:\d+[.,]?\d*|[.,]\d+))/.exec(text.slice(i + 1));
        if (!m) {
          fail(`'${c}' 뒤에 값이 없습니다`);
          break;
        }
        const raw = m[1].replace(',', '.');
        i += 1 + m[0].length;
        if (m[1].includes(',') && !commaWarned) {
          commaWarned = true;
          warnings.push({ code: 'W002', line: ln, level: 'warning', message: `'${c}${m[1]}' 쉼표(,) → 소수점(.)으로 읽었습니다. 실제 기계에서는 알람이 납니다` });
        }

        if (!SUPPORTED.includes(c)) {
          fail(`'${c}' 어드레스는 지원하지 않습니다`);
          break;
        }
        if (c !== 'G' && c !== 'M' && block.words.some((w) => w.letter === c)) {
          fail(`'${c}' 어드레스가 한 블록에 두 번 있습니다`);
          break;
        }

        const hasDot = raw.includes('.');
        let value = parseFloat(raw);
        if (INTEGER_ONLY.includes(c) && hasDot && c !== 'G') {
          fail(`'${c}${raw}' : ${c} 는 정수만 쓸 수 있습니다`);
          break;
        }
        if (DIMENSION.includes(c) && !hasDot && !(c === 'R' && g73)) {
          if (mode === 'strict') {
            fail(`'${c}${raw}' : 소수점('.')을 포함해서 값을 써야 합니다`);
            break;
          }
          if (mode === 'fanuc') value = value / 1000;
          if (!dotWarned) {
            dotWarned = true;
            warnings.push({
              code: 'W001',
              line: ln,
              level: 'warning',
              message:
                mode === 'fanuc'
                  ? `'${c}${raw}' 소수점 없음 → ${value}mm 로 해석됨 (실제 Fanuc 방식)`
                  : `'${c}${raw}' 소수점 없음 → 실제 Fanuc 에서는 ${value / 1000}mm 로 해석됩니다`,
            });
          }
        }
        block.words.push({ letter: c, value, raw, hasDot });
      }
      blocks.push(block);
    }
  }
  return blocks;
}
