import { describe, expect, it } from 'vitest';
import { ALL_CODES, explainWord, normalizeCode, searchCodes } from '../src/nc/codebook';
import { compile } from '../src/nc/interpreter';
import { defaultOffsets, defaultTools } from '../src/machine/tools';

describe('코드 사전', () => {
  it('G1 → G01, m3 → M03 으로 맞춘다', () => {
    expect(normalizeCode('G', '1')).toBe('G01');
    expect(normalizeCode('m', '3')).toBe('M03');
    expect(normalizeCode('G', '50.3')).toBe('G50.3');
  });

  it('목록은 G코드 번호순 → M코드 번호순 → 어드레스', () => {
    const all = searchCodes('').map((c) => c.code);
    const g = all.filter((c) => c.startsWith('G') && c.length > 1).map((c) => parseFloat(c.slice(1)));
    expect(g).toEqual([...g].sort((a, b) => a - b));
    expect(all.indexOf('G99')).toBeLessThan(all.indexOf('M00'));
    expect(all.indexOf('M99')).toBeLessThan(all.indexOf('O'));
  });

  it('검색: 번호, 짧게 쓴 번호, 한글 낱말', () => {
    expect(searchCodes('G71')[0].code).toBe('G71');
    expect(searchCodes('g1')[0].code).toBe('G01');
    expect(searchCodes('m3')[0].code).toBe('M03');
    expect(searchCodes('나사').map((c) => c.code)).toEqual(expect.arrayContaining(['G32', 'G76', 'G92']));
    expect(searchCodes('절삭유', 'M').map((c) => c.code)).toEqual(expect.arrayContaining(['M08', 'M09']));
  });

  it('같은 어드레스도 블록에 따라 뜻이 다르다', () => {
    expect(explainWord('P', '1000', 'G04 P1000').value).toBe('1 초');
    expect(explainWord('P', '10', 'G70 P10 Q20').context).toContain('첫 블록의 N번호');
    expect(explainWord('U', '1.5', 'G71 U1.5 R0.5').context).toContain('G71 첫 블록');
    expect(explainWord('U', '0.4', 'G71 P10 Q20 U0.4 W0.1 F0.25').context).toContain('정삭 여유');
    expect(explainWord('Q', '8000', 'G74 Z-40. Q8000 F0.1').value).toBe('8 mm');
    expect(explainWord('P', '020060', 'G76 P020060 Q50 R0.05').value).toContain('정삭 2회');
    expect(explainWord('X', '30.', 'G01 X30.').value).toContain('지름 30');
    expect(explainWord('T', '0303', 'T0303').value).toBe('3번 공구, 3번 보정');
    expect(explainWord('S', '150', 'G96 S150 M03').value).toBe('절삭속도 150 m/min');
    expect(explainWord('G', '2', 'G2 X10. R5.').info?.code).toBe('G02');
  });

  it('"지원" 이라고 적힌 G·M 코드는 실제로 알람 없이 돈다', () => {
    const cfg = { home: { z: 150, r: 100 }, rapidRate: 15000, maxRpm: 4000, decimalMode: 'mm' as const, blockSkip: true, tools: defaultTools(), offsets: defaultOffsets() };
    for (const c of ALL_CODES.filter((x) => x.kind !== 'addr' && x.support !== 'no')) {
      const p = compile(`G50 S2000 T0300 ;\nG97 S500 M03 ;\nG00 X60. Z5. ;\n${c.code} ;\n`, cfg);
      // 단독으로 쓸 수 없는 코드(인수가 필요한 것)는 "지원하지 않는" 알람만 아니면 된다
      expect(p.alarm?.message ?? '', c.code).not.toMatch(/지원하지 않는/);
    }
    for (const c of ALL_CODES.filter((x) => x.kind !== 'addr' && x.support === 'no' && x.code !== 'G10')) {
      const p = compile(`${c.code} ;\n`, cfg);
      expect(p.alarm, c.code).not.toBeNull();
    }
  });
});
