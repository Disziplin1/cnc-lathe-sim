/**
 * 도면 탭의 나사 · 널링 표시 줄.
 * 외곽선만으로는 나사·널링인지 알 수 없으므로 주석 한 줄로 적는다.
 *   (나사 M20x1.5 Z0. ~ Z-18.)   피치를 안 쓰면 보통나사 피치 (M6 → 1.0)
 *   (나사 M20x1.5 Z0. ~ Z-15. 내경)   구멍 안쪽 나사 (암나사)
 *   (널링 Z-32. ~ Z-92.)
 */
export interface ThreadFeature {
  /** 호칭 지름 (바깥지름) */
  dia: number;
  pitch: number;
  /** 끝면 쪽 Z (큰 값) */
  z0: number;
  /** 척 쪽 Z (작은 값) */
  z1: number;
  /** 구멍 안쪽 나사 (암나사) */
  inner: boolean;
  line: number;
}

export interface KnurlFeature {
  z0: number;
  z1: number;
  line: number;
}

/** 미터 보통나사 피치 (KS B 0201 / ISO 261) */
const COARSE: Record<number, number> = {
  1: 0.25, 1.2: 0.25, 1.6: 0.35, 2: 0.4, 2.5: 0.45, 3: 0.5, 4: 0.7, 5: 0.8, 6: 1, 8: 1.25, 10: 1.5, 12: 1.75,
  14: 2, 16: 2, 18: 2.5, 20: 2.5, 22: 2.5, 24: 3, 27: 3, 30: 3.5, 33: 3.5, 36: 4, 39: 4, 42: 4.5, 45: 4.5, 48: 5,
};

export function coarsePitch(dia: number): number | null {
  return COARSE[dia] ?? null;
}

const NUM = '(-?\\d+(?:\\.\\d*)?|-?\\.\\d+)';
/** Z 구간: "Z0. ~ Z-13." / "Z0~Z-13" / "Z0 ~ -13" (뒤쪽 Z 는 없어도 됨) */
const RANGE_RE = new RegExp(`Z\\s*${NUM}\\s*[~∼〜]\\s*Z?\\s*${NUM}`, 'i');
/** 나사 호칭: M6, M20x1.5, M20×1.5 (앞이 글자·숫자면 다른 말의 일부라서 제외) */
const SPEC_RE = /(?:^|[^A-Za-z0-9])M\s*(\d+(?:\.\d+)?)(?:\s*[xX×*]\s*(\d+(?:\.\d+)?))?/;
/** 구멍 안쪽 나사라는 말 */
const INNER_RE = /내경|암나사|탭/;

/**
 * 도면 텍스트에서 나사 · 널링 줄 읽기. 괄호 안 말의 순서는 상관없다.
 *   (나사 M6 Z0. ~ Z-13. 내경) = (내경 나사 M6 Z0~Z-13) = (암나사 Z0.~Z-13. M6)
 * 나사 · 널링이라는 말만 있고 호칭 · 구간이 둘 다 없으면 이름 주석으로 보고 넘어간다.
 */
export function parseFeatures(text: string): { threads: ThreadFeature[]; knurls: KnurlFeature[]; errors: { line: number; message: string }[] } {
  const threads: ThreadFeature[] = [];
  const knurls: KnurlFeature[] = [];
  const errors: { line: number; message: string }[] = [];
  text.split(/\r?\n/).forEach((raw, line) => {
    for (const c of raw.normalize('NFKC').match(/\([^)]*\)?/g) ?? []) {
      const range = RANGE_RE.exec(c);
      const z = range ? [parseFloat(range[1]), parseFloat(range[2])] : null;
      if (/나사|탭/.test(c)) {
        const m = SPEC_RE.exec(c);
        if (!m && !z) continue;
        if (!m || !z) {
          errors.push({ line, message: `나사 줄에 ${!m ? '호칭(M6, M20x1.5)' : 'Z 구간(Z0. ~ Z-13.)'} 이 없습니다. 예: (나사 M6 Z0. ~ Z-13. 내경)` });
          continue;
        }
        const dia = parseFloat(m[1]);
        const pitch = m[2] ? parseFloat(m[2]) : coarsePitch(dia);
        if (!pitch) {
          errors.push({ line, message: `M${dia} 의 보통나사 피치를 모릅니다. M${dia}x1.5 처럼 피치를 써 주세요` });
          continue;
        }
        threads.push({ dia, pitch, z0: Math.max(z[0], z[1]), z1: Math.min(z[0], z[1]), inner: INNER_RE.test(c), line });
      } else if (/널링/.test(c)) {
        if (!z) {
          if (/^\(\s*널링/.test(c)) errors.push({ line, message: '널링 줄에 Z 구간이 없습니다. 예: (널링 Z-32. ~ Z-92.)' });
          continue;
        }
        knurls.push({ z0: Math.max(z[0], z[1]), z1: Math.min(z[0], z[1]), line });
      }
    }
  });
  return { threads, knurls, errors };
}

const fmt = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  const s = (Object.is(r, -0) ? 0 : r).toString();
  return s.includes('.') ? s : s + '.';
};

export function threadLine(t: Omit<ThreadFeature, 'line'>): string {
  const spec = coarsePitch(t.dia) === t.pitch ? `M${t.dia}` : `M${t.dia}x${t.pitch}`;
  return `(나사 ${spec} Z${fmt(t.z0)} ~ Z${fmt(t.z1)}${t.inner ? ' 내경' : ''})`;
}

export function knurlLine(k: Omit<KnurlFeature, 'line'>): string {
  return `(널링 Z${fmt(k.z0)} ~ Z${fmt(k.z1)})`;
}
