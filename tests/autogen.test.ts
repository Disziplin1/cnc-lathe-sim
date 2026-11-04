import { describe, expect, it } from 'vitest';
import { generateProgram } from '../src/nc/autogen';
import { compile, type MachineConfig } from '../src/nc/interpreter';
import { defaultOffsets, defaultTools } from '../src/machine/tools';
import { CutSim } from '../src/sim/simulator';
import { compareStock, parseTarget } from '../src/sim/compare';
import { SAMPLES } from '../src/samples';

const cfg: MachineConfig = {
  home: { z: 150, r: 100 },
  rapidRate: 15000,
  maxRpm: 4000,
  decimalMode: 'mm',
  blockSkip: true,
  tools: defaultTools(),
  offsets: defaultOffsets(),
};
const stock = { diameter: 50, length: 91, grip: 20, faceAllowance: 1 };

/** 모범 답안을 만들어 끝까지 깎고 도면과 비교 */
function cut(drawing: string, st = stock) {
  const gen = generateProgram({ drawing, stock: st, tools: cfg.tools, offsets: cfg.offsets });
  const p = compile(gen.code, cfg);
  expect(p.alarm).toBeNull();
  const sim = new CutSim(p, st, cfg.tools);
  expect(sim.advanceTo(p.duration)).toBeNull();
  const target = parseTarget(drawing).target!;
  return { gen, res: compareStock(sim.stock, target, [], 0.8 * 1.6 + 0.05) };
}

describe('모범 답안 자동 생성 (G71 / G70)', () => {
  it('홈 없는 축: 도면대로 깎인다 (모따기 · 테이퍼 · 원호)', () => {
    const drawing = 'X0. Z0.\nX16.\nX20. Z-2.\nZ-15.\nX30. Z-25.\nZ-35.\nG02 X36. Z-38. R3.\nG01 X44.\nG03 X48. Z-40. R2.\nG01 Z-50.\n';
    const { gen, res } = cut(drawing);
    expect(gen.grooves).toEqual([]);
    expect(gen.code).toContain('G71 P10 Q20');
    expect(gen.code).toContain('G42 G00');
    // 모따기를 Z2 까지 늘여서 들어간다
    expect(gen.code).toContain('N10 G00 X12. ;');
    expect(res.maxExcess).toBeLessThan(0.02);
    expect(res.maxOver).toBeLessThan(0.02);
  });

  it('홈이 있는 도면: G71 · G70 은 메워서 지나가고 정삭 뒤 홈 바이트 G75 로 깎는다', () => {
    const drawing = SAMPLES.find((s) => s.id === 'multi')!.target!;
    const { gen, res } = cut(drawing);
    expect(gen.grooves).toHaveLength(1);
    expect(gen.grooves[0].z0).toBeCloseTo(-18, 3);
    expect(gen.grooves[0].z1).toBeCloseTo(-22, 3);
    expect(gen.grooves[0].minDia).toBeCloseTo(16, 3);
    expect(gen.code).toContain('(홈 Z-18. ~ Z-22. Ø16. : G75 로 1mm 씩 쪼아 들어감)');
    expect(gen.code).toContain('G00 Z-21. ;\nX22. ;');
    expect(gen.code).toContain('G75 X16. Z-22. P1000 Q2400 F0.07 ;');
    expect(res.maxOver).toBeLessThan(0.02);
    expect(res.maxExcess).toBeLessThan(0.02);
  });

  it('척 쪽에서 오목하게 끝나는 원호도 일부만 깎고 메운다', () => {
    // Ø40 다음에 볼록 원호가 다시 내려가는 형상
    const drawing = 'X0. Z0.\nX30.\nZ-10.\nG03 X30. Z-30. R10.\nG01 Z-40.\n';
    const { gen, res } = cut(drawing);
    expect(gen.grooves).toHaveLength(1);
    expect(gen.code).toContain('G03 X50. Z-20. R10.');
    expect(res.maxOver).toBeLessThan(0.02);
  });

  it('원호 끝에서 바로 벽으로 올라가는 오목 모서리도 G42 가 과삭하지 않는다', () => {
    const { res } = cut('X0. Z0.\nX20.\nG03 X30. Z-5. R5.\nG01 X40.\nZ-20.\n');
    expect(res.maxOver).toBeLessThan(0.02);
    expect(res.maxExcess).toBeLessThan(0.02);
  });

  it('끝면 → 척 반대로 쓴 도면도 같은 답안', () => {
    const a = generateProgram({ drawing: 'X0. Z0.\nX20.\nZ-10.\nG02 X30. Z-15. R5.\nG01 Z-30.\n', stock, tools: cfg.tools, offsets: cfg.offsets });
    const b = generateProgram({ drawing: 'X30. Z-30.\nZ-15.\nG03 X20. Z-10. R5.\nG01 Z0.\nX0.\n', stock, tools: cfg.tools, offsets: cfg.offsets });
    expect(b.code).toBe(a.code);
  });

  it('소재보다 큰 도면 · 긴 도면 · 빈 도면은 알기 쉬운 오류', () => {
    const gen = (drawing: string) => () => generateProgram({ drawing, stock, tools: cfg.tools, offsets: cfg.offsets });
    expect(gen('X0. Z0.\nX60.\nZ-10.\n')).toThrow(/소재 Ø50/);
    expect(gen('X0. Z0.\nX40.\nZ-80.\n')).toThrow(/척에서 나온 길이 70/);
    expect(gen('')).toThrow(/목표 형상이 없습니다/);
  });

  it('도면 탭의 나사 · 널링 줄로 G76 과 널링을 넣는다', () => {
    const drawing = ['X0. Z0.', 'X5.', 'X6. Z-0.5', 'Z-32.', 'X15.', 'Z-92.', '(나사 M6 Z0. ~ Z-15.)', '(널링 Z-32. ~ Z-92.)'].join('\n');
    const st = { diameter: 20, length: 123, grip: 20, faceAllowance: 1 };
    const gen = generateProgram({ drawing, stock: st, tools: cfg.tools, offsets: cfg.offsets });
    expect(gen.code).toContain('G76 X4.774 Z-15. P613 Q230 F1. ;');
    expect(gen.code).toContain('G01 X14.6 F0.1 ;');
    const p = compile(gen.code, cfg);
    expect(p.alarm).toBeNull();
    expect(p.segments.some((s) => s.kind === 'thread')).toBe(true);
    const sim = new CutSim(p, st, cfg.tools);
    expect(sim.advanceTo(p.duration)).toBeNull();
    expect(sim.knurled).toHaveLength(1);
    expect(sim.knurled[0][0]).toBeCloseTo(-92, 1);
    expect(sim.knurled[0][1]).toBeCloseTo(-32, 1);
  });

  it('나사 줄 형식이 틀리면 알려 준다', () => {
    const gen = (drawing: string) => () => generateProgram({ drawing, stock, tools: cfg.tools, offsets: cfg.offsets });
    const base = ['X0. Z0.', 'X20.', 'Z-20.'];
    expect(gen([...base, '(나사 M7 Z0. ~ Z-10.)'].join('\n'))).toThrow(/M7x1.5 처럼/);
    expect(gen([...base, '(나사 M20 Z0)'].join('\n'))).toThrow(/나사 줄 형식/);
    expect(gen([...base, '(널링 Z-10. ~ Z-40.)'].join('\n'))).toThrow(/도면\(Z0. ~ Z-20.\) 밖/);
  });
});

describe('모범 답안: 내경 (드릴 → 보링 G71 → G70 G41)', () => {
  const withDrill = (dia: number) => cfg.tools.map((t) => (t.type === 'drill' ? { ...t, width: dia } : t));
  const run = (drawing: string, drillDia: number) => {
    const tools = withDrill(drillDia);
    const c = { ...cfg, tools };
    const gen = generateProgram({ drawing, stock, tools, offsets: cfg.offsets });
    const p = compile(gen.code, c);
    expect(p.alarm).toBeNull();
    const sim = new CutSim(p, stock, tools);
    expect(sim.advanceTo(p.duration)).toBeNull();
    return { gen, res: compareStock(sim.stock, parseTarget(drawing).target!, [], 0.8 * 1.6 + 0.05) };
  };

  it('관통 구멍 Ø20 (C1): 도면대로', () => {
    const drawing = ['X22. Z0.', 'X40.', 'Z-30.', '(내경)', 'X22. Z0.', 'X20. Z-1.', 'Z-30.'].join('\n');
    const { gen, res } = run(drawing, 16);
    expect(gen.code).toContain('G74 Z-35.9 Q5000 F0.1 ;');
    expect(gen.code).toContain('G71 P30 Q40 U-0.4 W0.1 F0.2 ;');
    expect(gen.code).toContain('N30 G00 X26. ;');
    expect(gen.code).toContain('G41 G00 X15. Z2. ;');
    expect(res.maxOver).toBeLessThan(0.02);
    expect(res.maxExcess).toBeLessThan(0.02);
  });

  it('막힌 구멍 Ø24 깊이 15 (바닥 평평): 드릴 끝을 바닥에 맞추고 보링으로 벽 · 바닥 정리', () => {
    const drawing = ['X0. Z0.', 'X40.', 'Z-30.', '(내경)', 'X24. Z0.', 'Z-15.', 'X0.'].join('\n');
    const { gen, res } = run(drawing, 18);
    expect(gen.code).toContain('G74 Z-15. Q5000');
    expect(gen.code).toContain('N40 G01 X17. ;');
    expect(res.maxOver).toBeLessThan(0.02);
    expect(res.maxExcess).toBeLessThan(0.02);
  });

  it('구멍과 같은 지름의 드릴이면 드릴로만 뚫는다 (막힌 Ø11 깊이 6.5)', () => {
    const drawing = ['X0. Z0.', 'X22.', 'Z-30.', '(내경)', 'X11. Z0.', 'Z-6.5', 'X0.'].join('\n');
    const tools = withDrill(11);
    const gen = generateProgram({ drawing, stock, tools, offsets: cfg.offsets });
    expect(gen.code).toContain('G74 Z-9.805 Q5000 F0.1 ;');
    expect(gen.code).not.toContain('G71 P30');
    const p = compile(gen.code, { ...cfg, tools });
    const sim = new CutSim(p, stock, tools);
    expect(sim.advanceTo(p.duration)).toBeNull();
  });

  it('설정의 드릴이 구멍에 안 맞으면 알맞은 지름으로 바꾸고 알려 준다', () => {
    const gen = (hole: number, drill: number) =>
      generateProgram({ drawing: ['X0. Z0.', 'X40.', 'Z-30.', '(내경)', `X${hole}. Z0.`, 'Z-10.', 'X0.'].join('\n'), stock, tools: withDrill(drill), offsets: cfg.offsets });
    // 드릴 구멍이 작아서 보링바가 못 들어감 → 보링바가 들어가는 가장 큰 드릴
    let r = gen(30, 12);
    expect(r.adjust).toEqual([{ no: 11, name: '드릴', from: 12, to: 28, why: expect.stringMatching(/Ø16 이상/) }]);
    expect(r.code).toContain('(드릴 Ø28.');
    // 구멍 자체가 작음 → 구멍과 같은 드릴로만
    r = gen(11, 8);
    expect(r.adjust[0].to).toBe(11);
    expect(r.code).toContain('구멍이 작아 드릴로만 뚫음');
    // 드릴이 구멍보다 큼 → 보링 여유를 남기는 가장 큰 드릴
    r = gen(20, 22);
    expect(r.adjust[0].to).toBe(18);
    // 맞는 드릴이면 그대로
    expect(gen(30, 20).adjust).toEqual([]);
  });

  it('드릴은 표준 지름만 쓴다 (Ø13 까지 0.1 단위), 암나사 밑구멍은 탭 드릴', () => {
    const hole = (d: string, extra: string[] = []) =>
      generateProgram({ drawing: ['X0. Z0.', 'X20.', 'Z-30.', '(내경)', `X${d} Z0.`, 'Z-10.', 'X0.', ...extra].join('\n'), stock, tools: withDrill(20), offsets: cfg.offsets });
    // 그냥 Ø4.917 구멍 → 가장 가까운 아래쪽 표준 드릴 Ø4.9
    let r = hole('4.917');
    expect(r.adjust[0].to).toBe(4.9);
    expect(r.code).toContain('표준 드릴 Ø4.9 의 차이 0.017');
    // M6 암나사 밑구멍(안지름 Ø4.917) → 탭 드릴 Ø5, 내경 나사 바이트는 못 들어가므로 탭 G84
    r = hole('4.917', ['(나사 M6 Z0. ~ Z-8. 내경)']);
    expect(r.adjust[0].to).toBe(5);
    expect(r.code).toContain('(탭 드릴 Ø5. : M6 암나사 밑구멍');
    expect(r.code).toContain('G84 Z-8. R-3. F1. ;');
    expect(r.code).not.toContain('G76 X6.');
    const tools = withDrill(5);
    const p = compile(r.code, { ...cfg, tools });
    expect(p.alarm).toBeNull();
    // 탭은 피치(회전당 1mm) 로 들어갔다가 거꾸로 돌며 나온다
    const taps = p.segments.filter((s) => s.kind === 'thread' && s.tool === 10);
    expect(taps).toHaveLength(2);
    expect(Math.min(...taps.flatMap((s) => s.pts.map((q) => q.z)))).toBeCloseTo(-8, 3);
    expect(taps[1].snap.spindle).toBe('M04');
    const sim = new CutSim(p, stock, tools);
    expect(sim.advanceTo(p.duration)).toBeNull();
    // 없는 지름으로 설정된 드릴(Ø4.917)도 표준으로
    r = generateProgram({ drawing: ['X0. Z0.', 'X20.', 'Z-30.', '(내경)', 'X4.917 Z0.', 'Z-10.', 'X0.'].join('\n'), stock, tools: withDrill(4.917), offsets: cfg.offsets });
    expect(r.adjust[0].to).toBe(4.9);
  });

  it('작은 데다 단까지 있는 구멍은 드릴 하나로도 안 되므로 알려 준다', () => {
    const drawing = ['X0. Z0.', 'X40.', 'Z-30.', '(내경)', 'X11. Z0.', 'Z-5.', 'X8.', 'Z-10.', 'X0.'].join('\n');
    expect(() => generateProgram({ drawing, stock, tools: withDrill(20), offsets: cfg.offsets })).toThrow(/단이 있어서 드릴 하나로도 못 뚫습니다/);
  });

  it('보링바가 구멍보다 크면 시뮬레이션에서 축 건너편 충돌 알람', () => {
    const tools = withDrill(8);
    const code = ['G28 U0. W0. ;', 'T1100 ;', 'G97 S500 M03 ;', 'G00 X0. Z5. T1111 ;', 'G01 Z-6.5 F0.1 ;', 'G00 Z5. ;', 'T0900 ;', 'G00 X7. Z2. T0909 ;', 'G01 Z-6. F0.1 ;', 'M30 ;'].join('\n');
    const p = compile(code, { ...cfg, tools });
    const sim = new CutSim(p, stock, tools);
    expect(sim.advanceTo(p.duration)?.code).toBe('SIM04');
  });
});

describe('모범 답안: 내경 나사 (암나사)', () => {
  it('(나사 M20x1.5 ... 내경) → 보링 후 내경 나사 바이트로 G76', () => {
    const tools = cfg.tools.map((t) => (t.type === 'drill' ? { ...t, width: 16 } : t));
    const drawing = ['X18.376 Z0.', 'X40.', 'Z-30.', '(내경)', 'X18.376 Z0.', 'Z-30.', '(나사 M20x1.5 Z0. ~ Z-15. 내경)'].join('\n');
    const gen = generateProgram({ drawing, stock, tools, offsets: cfg.offsets });
    expect(gen.code).toContain('T0800 ;');
    expect(gen.code).toContain('G00 X17.3 Z5. T0808 M08 ;');
    expect(gen.code).toContain('G76 X20. Z-15. P920 Q350 F1.5 ;');
    const p = compile(gen.code, { ...cfg, tools });
    expect(p.alarm).toBeNull();
    const th = p.segments.filter((s) => s.kind === 'thread');
    expect(Math.max(...th.map((s) => s.pts[1].r))).toBeCloseTo(10, 3);
    const sim = new CutSim(p, stock, tools);
    expect(sim.advanceTo(p.duration)).toBeNull();
  });
});

describe('모범 답안: 내경 홈', () => {
  it('구멍 안쪽 홈은 보링 뒤 내경 홈 바이트 G75 로 깎는다', () => {
    const drawing = ['X30. Z0.', 'X40.', 'Z-30.', '(내경)', 'X30. Z0.', 'Z-10.', 'X34.', 'Z-13.', 'X30.', 'Z-30.'].join('\n');
    const gen = generateProgram({ drawing, stock, tools: cfg.tools, offsets: cfg.offsets });
    expect(gen.code).toContain('T0600 ;');
    expect(gen.code).toContain('G00 X0. Z5. T0606 M08 ;');
    expect(gen.code).toContain('G00 X28. Z-12. ;');
    expect(gen.code).toContain('G75 X34. Z-13. P1000 Q1600 F0.07 ;');
    const p = compile(gen.code, cfg);
    expect(p.alarm).toBeNull();
    const sim = new CutSim(p, stock, cfg.tools);
    expect(sim.advanceTo(p.duration)).toBeNull();
    const res = compareStock(sim.stock, parseTarget(drawing).target!, [], 0.8 * 1.6 + 0.05);
    expect(res.maxOver).toBeLessThan(0.02);
    expect(res.maxExcess).toBeLessThan(0.02);
  });
});

describe('모범 답안: 홈 모따기 · 널링 묶기', () => {
  it('홈 입구 모따기는 바이트 끝면 쪽 모서리로 따라 깎는다', () => {
    const drawing = ['X30. Z0.', 'X40.', 'Z-30.', '(내경)', 'X30. Z0.', 'Z-10.', 'X32. Z-11.', 'X34.', 'Z-14.', 'X30.', 'Z-30.'].join('\n');
    const gen = generateProgram({ drawing, stock, tools: cfg.tools, offsets: cfg.offsets });
    expect(gen.code).toContain('G01 X34. F0.05 ;\nX32. Z-13. ;\nX30. Z-12. ;');
    const p = compile(gen.code, cfg);
    const sim = new CutSim(p, stock, cfg.tools);
    expect(sim.advanceTo(p.duration)).toBeNull();
    const res = compareStock(sim.stock, parseTarget(drawing).target!, [], 0.8 * 1.6 + 0.05);
    expect(res.maxOver).toBeLessThan(0.02);
    expect(res.maxExcess).toBeLessThan(0.02);
  });

  it('널링이 여러 구간이면 공구를 한 번만 불러서 끝면 쪽부터', () => {
    const drawing = ['X0. Z0.', 'X30.', 'Z-20.', 'X40.', 'Z-50.', '(널링 Z-20. ~ Z-50.)', '(널링 Z0. ~ Z-20.)'].join('\n');
    const gen = generateProgram({ drawing, stock, tools: cfg.tools, offsets: cfg.offsets });
    expect(gen.code.match(/T1200 ;/g)).toHaveLength(1);
    expect(gen.code.indexOf('(널링 Z0. ~ Z-20.')).toBeLessThan(gen.code.indexOf('(널링 Z-20. ~ Z-50.'));
  });
});

describe('모범 답안: 둥근 형상 (G73)', () => {
  // 공 손잡이: 끝면에 공(R18.631), 오목한 목(R49.864), Ø13, 척 쪽 Ø8 (사용자 도면)
  const drawing = ['X0. Z0.', 'G03 X17.659 Z-27.218 R18.631', 'G02 X13. Z-59.85 R49.864', 'G01 Z-67.85', 'X8.', 'Z-79.6', 'X6.75 Z-80.85'].join('\n');
  const st = { diameter: 30, length: 107, grip: 15, faceAllowance: 1 };

  it('G71 로 메운 뒤 G73 · G70 으로 공 뒤쪽과 오목한 목을 따라 깎고, Ø8 단은 홈 바이트로', () => {
    const gen = generateProgram({ drawing, stock: st, tools: cfg.tools, offsets: cfg.offsets });
    expect(gen.code).toContain('G73 P50 Q60 U0.8 W0.2 F0.15 ;');
    expect(gen.code).toContain('G02 X13. Z-59.85 R49.864 ;');
    expect(gen.code).toContain('G70 P50 Q60 ;');
    expect(gen.code).toContain('G75 X8. Z-72.552');
    const p = compile(gen.code, cfg);
    expect(p.alarm).toBeNull();
    const sim = new CutSim(p, st, cfg.tools);
    expect(sim.advanceTo(p.duration)).toBeNull();
    const res = compareStock(sim.stock, parseTarget(drawing).target!, [], 0.8 * 1.6 + 0.05);
    expect(res.maxOver).toBeLessThan(0.02);
    expect(res.maxExcess).toBeLessThan(0.05);
  });

  it('단순한 축은 G73 없이 G70', () => {
    const gen = generateProgram({ drawing: SAMPLES.find((s) => s.id === 'multi')!.target!, stock, tools: cfg.tools, offsets: cfg.offsets });
    expect(gen.code).not.toContain('G73');
    expect(gen.code).toContain('G70 P10 Q20 ;');
  });
});
