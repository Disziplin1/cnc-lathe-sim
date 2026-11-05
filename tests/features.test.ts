import { describe, expect, it } from 'vitest';
import { parseFeatures, threadLine } from '../src/sim/features';

describe('도면 탭 나사 · 널링 줄', () => {
  it('말 순서가 달라도 같은 나사', () => {
    const want = { dia: 6, pitch: 1, z0: 0, z1: -13, inner: true };
    for (const s of [
      '(나사 M6 Z0. ~ Z-13. 내경)',
      '(나사 내경 M6 Z0. ~ Z-13.)',
      '(내경 나사 M6 Z0~Z-13)',
      '(암나사 Z0. ~ Z-13. M6)',
      '(M6 내경 나사 Z-13. ~ Z0.)',
      '(탭 M6 Z0 ~ -13)',
    ]) {
      const r = parseFeatures(s);
      expect(r.errors, s).toEqual([]);
      expect(r.threads, s).toEqual([{ ...want, line: 0 }]);
    }
  });

  it('수나사 · 가는 나사 · 널링', () => {
    expect(parseFeatures('(Z0. ~ Z-18. 나사 M20x1.5)').threads[0]).toMatchObject({ dia: 20, pitch: 1.5, inner: false });
    expect(parseFeatures('(Z-32. ~ Z-92. 널링)').knurls[0]).toMatchObject({ z0: -32, z1: -92 });
  });

  it('호칭이나 구간이 빠지면 무엇이 없는지 알려 주고, 이름 주석은 넘어간다', () => {
    expect(parseFeatures('(나사 M6 내경)').errors[0].message).toMatch(/Z 구간/);
    expect(parseFeatures('(내경 나사 Z0. ~ Z-13.)').errors[0].message).toMatch(/호칭/);
    expect(parseFeatures('(나사축.dxf : 최대 지름 20.)')).toEqual({ threads: [], knurls: [], errors: [] });
  });

  it('자동으로 적는 줄은 다시 읽어도 같다', () => {
    const t = { dia: 20, pitch: 1.5, z0: 0, z1: -15, inner: true };
    expect(parseFeatures(threadLine(t)).threads[0]).toEqual({ ...t, line: 0 });
  });
});
