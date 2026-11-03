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

  it('홈이 있는 도면: 홈은 메우고 주석으로 알린다', () => {
    const drawing = SAMPLES.find((s) => s.id === 'multi')!.target!;
    const { gen, res } = cut(drawing);
    expect(gen.grooves).toHaveLength(1);
    expect(gen.grooves[0].z0).toBeCloseTo(-18, 3);
    expect(gen.grooves[0].z1).toBeCloseTo(-22, 3);
    expect(gen.grooves[0].minDia).toBeCloseTo(16, 3);
    expect(gen.code).toMatch(/\(홈 Z-18\. ~ Z-22\. 최소 Ø16\./);
    expect(res.maxOver).toBeLessThan(0.02);
    // 남은 살은 홈 자리만
    expect(res.maxExcess).toBeGreaterThan(0.1);
    expect(res.excessAt!.z).toBeLessThan(-17.9);
    expect(res.excessAt!.z).toBeGreaterThan(-22.1);
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

  it('막힌 구멍 Ø16 깊이 15 (바닥 평평): 드릴 끝을 바닥에 맞추고 보링으로 벽 · 바닥 정리', () => {
    const drawing = ['X0. Z0.', 'X40.', 'Z-30.', '(내경)', 'X16. Z0.', 'Z-15.', 'X0.'].join('\n');
    const { gen, res } = run(drawing, 12);
    expect(gen.code).toContain('G74 Z-15. Q5000');
    expect(gen.code).toContain('N40 G01 X11. ;');
    expect(res.maxOver).toBeLessThan(0.02);
    expect(res.maxExcess).toBeLessThan(0.02);
  });

  it('드릴이 구멍보다 크면 알맞은 지름을 알려 준다', () => {
    const drawing = ['X22. Z0.', 'X40.', 'Z-30.', '(내경)', 'X20. Z0.', 'Z-30.'].join('\n');
    expect(() => generateProgram({ drawing, stock, tools: cfg.tools, offsets: cfg.offsets })).toThrow(/T11 드릴 지름을 Ø18 이하로/);
  });
});
