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
const RANGE = `Z\\s*${NUM}\\s*~\\s*Z\\s*${NUM}`;
const THREAD_RE = new RegExp(`\\(\\s*나사\\s+M\\s*(\\d+(?:\\.\\d+)?)(?:\\s*[xX×*]\\s*(\\d+(?:\\.\\d+)?))?\\s+${RANGE}(\\s*내경)?`);
const KNURL_RE = new RegExp(`\\(\\s*널링\\s+${RANGE}`);

export function parseFeatures(text: string): { threads: ThreadFeature[]; knurls: KnurlFeature[]; errors: { line: number; message: string }[] } {
  const threads: ThreadFeature[] = [];
  const knurls: KnurlFeature[] = [];
  const errors: { line: number; message: string }[] = [];
  text.split(/\r?\n/).forEach((raw, line) => {
    const s = raw.normalize('NFKC');
    if (/\(\s*나사/.test(s)) {
      const m = THREAD_RE.exec(s);
      if (!m) return void errors.push({ line, message: '나사 줄 형식: (나사 M20x1.5 Z0. ~ Z-18.)' });
      const dia = parseFloat(m[1]);
      const pitch = m[2] ? parseFloat(m[2]) : coarsePitch(dia);
      if (!pitch) return void errors.push({ line, message: `M${dia} 의 보통나사 피치를 모릅니다. M${dia}x1.5 처럼 피치를 써 주세요` });
      const [a, b] = [parseFloat(m[3]), parseFloat(m[4])];
      threads.push({ dia, pitch, z0: Math.max(a, b), z1: Math.min(a, b), inner: !!m[5], line });
    } else if (/\(\s*널링/.test(s)) {
      const m = KNURL_RE.exec(s);
      if (!m) return void errors.push({ line, message: '널링 줄 형식: (널링 Z-32. ~ Z-92.)' });
      const [a, b] = [parseFloat(m[1]), parseFloat(m[2])];
      knurls.push({ z0: Math.max(a, b), z1: Math.min(a, b), line });
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
