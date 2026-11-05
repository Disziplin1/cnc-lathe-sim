import { describe, expect, it } from 'vitest';
import { compile, type MachineConfig } from '../src/nc/interpreter';
import { defaultOffsets, defaultTools } from '../src/machine/tools';
import { CutSim } from '../src/sim/simulator';
import { Player } from '../src/sim/player';
import { SAMPLES } from '../src/samples';
import { compareStock, parseTarget } from '../src/sim/compare';
import { areaOf, difference, intersection, rect } from '../src/sim/geometry';

const cfg = (over: Partial<MachineConfig> = {}): MachineConfig => ({
  home: { z: 150, r: 100 },
  rapidRate: 15000,
  maxRpm: 4000,
  decimalMode: 'mm',
  blockSkip: true,
  tools: defaultTools(),
  offsets: defaultOffsets(),
  ...over,
});

const head = 'G50 S2000 T0300 ;\nG97 S1000 M03 ;\n';
const last = (p: ReturnType<typeof compile>) => {
  const s = p.segments[p.segments.length - 1];
  return s.pts[s.pts.length - 1];
};
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 3);

describe('interpreter', () => {
  it('소수점: 쉼표와 전각 문자도 받아 준다 (쉼표는 경고)', () => {
    const p = compile(head + 'G00 X40,5 Z2. ;\nＧ０１ Ｘ３０．２ Ｆ0.2 ;\n', cfg());
    expect(p.alarm).toBeNull();
    near(p.segments[p.segments.length - 2].pts.at(-1)!.r, 20.25);
    near(last(p).r, 15.1);
    expect(p.warnings.some((w) => w.code === 'W002')).toBe(true);
  });

  it('소수점이 두 번이면 알기 쉬운 알람', () => {
    const p = compile(head + 'G00 X40. Z2. ;\nG01 Z-9.5. F0.2 ;\n', cfg());
    expect(p.alarm?.message).toContain('소수점이 두 번');
    expect(p.alarm?.message).toContain('Z-9.5 처럼');
  });

  it('X 는 직경, U/W 는 증분', () => {
    const p = compile(head + 'G00 X40. Z2. ;\nG01 U-4. W-10. F0.2 ;\n', cfg());
    expect(p.alarm).toBeNull();
    near(last(p).r, 18);
    near(last(p).z, -8);
  });

  it('G00 은 축별 독립 이동이라 경로가 꺾인다', () => {
    const p = compile(head + 'G00 X40. Z2. ;\n', cfg());
    const rapid = p.segments.find((s) => s.kind === 'rapid')!;
    expect(rapid.pts.length).toBe(3);
  });

  it('G03 R 지령 : 볼록 모서리', () => {
    const p = compile(head + 'G00 X34. Z-30. ;\nG03 X38. Z-32. R2. F0.1 ;\n', cfg());
    expect(p.alarm).toBeNull();
    const arc = p.segments[p.segments.length - 1].pts;
    const mid = arc[Math.floor(arc.length / 2)];
    // 중심 (Z-32, 반경 17), 반지름 2
    near(Math.hypot(mid.z + 32, mid.r - 17), 2);
    expect(mid.z).toBeGreaterThan(-32);
  });

  it('G02 I/K 지령과 R 지령 결과가 같다', () => {
    const a = compile(head + 'G00 X38. Z-57. ;\nG02 X44. Z-60. R3. F0.1 ;\n', cfg());
    const b = compile(head + 'G00 X38. Z-57. ;\nG02 X44. Z-60. I3. K0. F0.1 ;\n', cfg());
    const pa = a.segments[a.segments.length - 1].pts;
    const pb = b.segments[b.segments.length - 1].pts;
    near(pa[Math.floor(pa.length / 2)].z, pb[Math.floor(pb.length / 2)].z);
  });

  it('R 이 너무 작으면 알람', () => {
    const p = compile(head + 'G00 X30. Z0. ;\nG02 X40. Z-10. R2. F0.1 ;\n', cfg());
    expect(p.alarm?.code).toBe('PS0020');
  });

  it('G90 모달 반복 : 시작점으로 돌아온다', () => {
    const p = compile(head + 'G00 X52. Z2. ;\nG90 X48. Z-30. F0.2 ;\nX46. ;\n', cfg());
    expect(p.alarm).toBeNull();
    near(last(p).r, 26);
    near(last(p).z, 2);
    const feeds = p.segments.filter((s) => s.kind === 'feed');
    near(feeds[2].pts[0].r, 23);
  });

  it('주축 정지 상태 절삭은 알람', () => {
    const p = compile('T0100 ;\nG00 X40. Z2. ;\nG01 Z-10. F0.2 ;\n', cfg());
    expect(p.alarm?.code).toBe('SIM01');
  });

  it('F 없이 G01 은 알람', () => {
    const p = compile(head + 'G01 X40. Z-10. ;\n', cfg());
    expect(p.alarm?.code).toBe('PS0011');
  });

  it('strict 모드는 소수점 없는 좌표를 거부', () => {
    const p = compile(head + 'G00 X40 Z2. ;\n', cfg({ decimalMode: 'strict' }));
    expect(p.alarm).not.toBeNull();
  });

  it('fanuc 모드는 소수점 없는 값을 µm 로 해석', () => {
    const p = compile(head + 'G00 X40000 Z2. ;\n', cfg({ decimalMode: 'fanuc' }));
    near(last(p).r, 20);
  });

  it('공백 없이 붙여 써도 읽는다', () => {
    const p = compile('G50S2000T0300;\nG97S1000M03;\nG00X40.Z2.;\n', cfg());
    expect(p.alarm).toBeNull();
    near(last(p).r, 20);
  });

  it('G96 회전수는 G50 최고 회전수로 제한', () => {
    const p = compile('G50 S1500 T0300 ;\nG96 S150 M03 ;\nG00 X2. Z2. ;\nG01 Z0. F0.1 ;\n', cfg());
    const f = p.segments.find((s) => s.kind === 'feed')!;
    expect(f.rpm).toBeLessThanOrEqual(1500);
  });
});

describe('simulator', () => {
  const stock = { diameter: 50, length: 91, grip: 20, faceAllowance: 1 };

  it('예제 프로그램은 알람 없이 끝까지 실행된다', () => {
    for (const s of SAMPLES.filter((x) => x.id !== 'bugs')) {
      const p = compile(s.code, cfg());
      expect(p.alarm, s.id).toBeNull();
      const sim = new CutSim(p, s.stock, defaultTools());
      expect(sim.advanceTo(p.duration + 1), s.id).toBeNull();
      if (s.id !== 'empty') expect(sim.version, s.id).toBeGreaterThan(1);
    }
  });

  it('에러 연습 예제는 알람이 난다', () => {
    const s = SAMPLES.find((x) => x.id === 'bugs')!;
    const p = compile(s.code, cfg());
    expect(p.alarm?.code).toBe('SIM01');
    // M03 을 넣어 고치면 다음 실수(G00 으로 소재 관통)가 드러난다
    const fixed = compile(s.code.replace('G96 S150 ;', 'G96 S150 M03 ;'), cfg());
    expect(fixed.alarm).toBeNull();
    const sim = new CutSim(fixed, s.stock, defaultTools());
    expect(sim.advanceTo(fixed.duration)?.code).toBe('SIM02');
  });

  it('G00 으로 소재를 관통하면 충돌 알람', () => {
    const p = compile(head + 'G00 X40. Z2. ;\nZ-20. ;\n', cfg());
    const sim = new CutSim(p, stock, defaultTools());
    expect(sim.advanceTo(p.duration)?.code).toBe('SIM02');
  });

  it('출발점이 소재 안쪽이면 충돌 알람에 소재 지름을 알려 준다 (소재를 바꾼 뒤 예전 프로그램)', () => {
    const big = { ...stock, diameter: 85 };
    const p = compile(head + 'G00 X74. Z0. ;\n', cfg());
    const a = new CutSim(p, big, defaultTools()).advanceTo(p.duration);
    expect(a?.code).toBe('SIM02');
    expect(a?.message).toContain('X74 Z0 가 소재 Ø85 안쪽');
    // 도착점이 소재 밖이면(소재를 가로질러 지나감) 안내 없이 충돌만 알린다
    const q = compile(head + 'G00 X40. Z2. ;\nX60. Z-20. ;\nZ-60. ;\nX40. Z-40. ;\n', cfg());
    const b = new CutSim(q, stock, defaultTools()).advanceTo(q.duration);
    expect(b?.code).toBe('SIM02');
    expect(b?.message).not.toContain('안쪽입니다');
  });

  it('외경 절삭 후 소재 반경이 줄어든다', () => {
    const p = compile(head + 'G00 X52. Z2. ;\nG90 X40. Z-30. F0.2 ;\nM30 ;\n', cfg());
    const sim = new CutSim(p, stock, defaultTools());
    sim.advanceTo(p.duration);
    const pts = sim.stock.flat();
    const atZ15 = pts.filter((q) => q.X < -2000 && q.X > -28000).map((q) => q.Y);
    expect(Math.max(...atZ15)).toBeLessThanOrEqual(20000 + 5);
  });
});

describe('2단계: 복합 사이클 / 보정 / 도면 비교', () => {
  const stock = { diameter: 50, length: 91, grip: 20, faceAllowance: 1 };
  const run = (code: string, st = stock, over: Partial<MachineConfig> = {}) => {
    const p = compile(code, cfg(over));
    const sim = new CutSim(p, st, defaultTools());
    const alarm = sim.advanceTo(p.duration + 1);
    return { p, sim, alarm };
  };
  /** z0~z1 구간에서 소재의 최대 반경 */
  const maxR = (sim: CutSim, z0: number, z1: number) =>
    Math.max(...intersection(sim.stock, [rect(z1, z0, -1, 100)]).flat().map((q) => q.Y / 1000));

  it('새 예제들은 알람 없이 끝까지 실행된다', () => {
    for (const id of ['multi', 'bore']) {
      const s = SAMPLES.find((x) => x.id === id)!;
      const { p, alarm } = run(s.code, s.stock);
      expect(p.alarm, id).toBeNull();
      expect(alarm, id).toBeNull();
    }
  });

  it('G71 은 P~Q 블록을 건너뛰고 다음 블록으로 간다', () => {
    const { p } = run(`G50 S2000 T0100 ;\nG96 S150 M03 ;\nG00 X52. Z2. T0101 ;\nG71 U2. R0.5 ;\nG71 P1 Q2 U0.4 W0.1 F0.25 ;\nN1 G00 X30. ;\nN2 G01 Z-30. F0.1 ;\nG00 X100. ;\nM30 ;\n`);
    expect(p.alarm).toBeNull();
    const lines = new Set(p.segments.map((s) => s.line));
    expect(lines.has(5)).toBe(false);
    expect(lines.has(7)).toBe(true);
  });

  it('G71 황삭 후 정삭 여유가 남는다', () => {
    const { sim } = run(`G50 S2000 T0300 ;\nG96 S150 M03 ;\nG00 X52. Z2. T0300 ;\nG71 U2. R0.5 ;\nG71 P1 Q2 U0.4 W0.1 F0.25 ;\nN1 G00 X30. ;\nN2 G01 Z-30. ;\nM30 ;\n`);
    const r = maxR(sim, -5, -25);
    expect(r).toBeGreaterThan(15.15);
    expect(r).toBeLessThan(15.25);
  });

  it('형상이 단조가 아니면 PS0064', () => {
    const { p } = run(`G50 S2000 T0100 ;\nG96 S150 M03 ;\nG00 X52. Z2. T0101 ;\nG71 U2. R0.5 ;\nG71 P1 Q2 U0.4 W0.1 F0.25 ;\nN1 G00 X30. ;\nG01 Z-10. F0.1 ;\nX20. Z-15. ;\nN2 Z-30. ;\nM30 ;\n`);
    expect(p.alarm?.code).toBe('PS0064');
  });

  it('P 블록이 없으면 PS0063', () => {
    const { p } = run(`G50 S2000 T0100 ;\nG96 S150 M03 ;\nG00 X52. Z2. T0101 ;\nG71 P5 Q6 U0.4 W0.1 F0.25 ;\nM30 ;\n`);
    expect(p.alarm?.code).toBe('PS0063');
  });

  it('공구 보정 X 를 바꾸면 지름이 바뀐다', () => {
    const offsets = defaultOffsets();
    offsets[2] = { X: 0.2, Z: 0, R: 0, T: 3 };
    const code = `G50 S2000 T0300 ;\nG96 S150 M03 ;\nG00 X52. Z2. T0303 ;\nG90 X40. Z-30. F0.2 ;\nM30 ;\n`;
    const tools = defaultTools().map((t) => ({ ...t, noseR: 0 }));
    const p = compile(code, cfg({ offsets, tools }));
    const sim = new CutSim(p, stock, tools);
    sim.advanceTo(p.duration);
    expect(maxR(sim, -5, -25)).toBeCloseTo(20.1, 2);
  });

  it('G42 보정을 하면 테이퍼가 도면대로, 안 하면 살이 남는다', () => {
    const body = `G00 X20. Z2. ;\nG01 X30. Z-3. F0.1 ;\nZ-30. ;\nX52. ;\n`;
    const target = parseTarget('X0. Z0.\nX24.\nX30. Z-3.\nZ-30.\nX50.\n').target!;
    const res = (code: string) => {
      const p = compile(code, cfg());
      const sim = new CutSim(p, stock, defaultTools());
      sim.advanceTo(p.duration);
      return compareStock(sim.workpiece, target, [], 0.6);
    };
    const head2 = `G50 S2000 T0300 ;\nG96 S150 M03 ;\nG00 X60. Z0. T0303 ;\nG01 X-1. F0.1 ;\nG00 X60. Z2. ;\n`;
    const without = res(head2 + body + 'M30 ;\n');
    const withComp = res(head2 + 'G42 ' + body + 'G40 G00 X60. ;\nM30 ;\n');
    expect(without.maxExcess).toBeGreaterThan(0.1);
    expect(withComp.maxExcess).toBeLessThan(0.02);
    expect(withComp.maxOver).toBeLessThan(0.02);
  });

  it('G76 은 여러 번 나눠 깎고 마지막 깊이가 산높이', () => {
    const p = compile(`G97 S600 M03 ;\nT0707 ;\nG00 X24. Z5. ;\nG76 P020060 Q50 R0.05 ;\nG76 X18.16 Z-19.5 P920 Q350 F1.5 ;\nM30 ;\n`, cfg());
    expect(p.alarm).toBeNull();
    const th = p.segments.filter((s) => s.kind === 'thread');
    expect(th.length).toBeGreaterThan(6);
    expect(Math.min(...th.map((s) => s.pts[1].r))).toBeCloseTo(9.08, 3);
  });

  it('G72 단면 황삭 후 형상 + 여유만 남는다', () => {
    const { p, alarm, sim } = run(`G50 S2000 T0300 ;
G96 S150 M03 ;
G00 X52. Z2. T0300 ;
G72 W1.5 R0.5 ;
G72 P1 Q2 U0.4 W0.1 F0.2 ;
N1 G00 Z-10. ;
G01 X30. F0.1 ;
N2 Z2. ;
M30 ;
`);
    expect(p.alarm).toBeNull();
    expect(alarm).toBeNull();
    const r = maxR(sim, -1, -8);
    expect(r).toBeGreaterThan(15.15);
    expect(r).toBeLessThan(15.3);
  });

  it('G73 형상 반복은 R 횟수만큼 형상을 따라간다', () => {
    const { p, alarm } = run(`G50 S2000 T0300 ;
G96 S150 M03 ;
G00 X52. Z2. T0300 ;
G73 U3. W0. R3 ;
G73 P1 Q2 U0.4 W0.1 F0.2 ;
N1 G00 X40. ;
N2 G01 Z-20. F0.1 ;
M30 ;
`);
    expect(p.alarm).toBeNull();
    expect(alarm).toBeNull();
    const passes = p.segments.filter((s) => s.kind === 'feed' && s.line === 4);
    expect(passes.length).toBe(3);
  });

  it('G74 드릴은 Q 만큼 쪼아 들어간다', () => {
    const p = compile(`G97 S500 M03 ;\nT1111 ;\nG00 X0. Z5. ;\nG74 R1. ;\nG74 Z-40. Q8000 F0.1 ;\nM30 ;\n`, cfg());
    expect(p.alarm).toBeNull();
    expect(p.segments.filter((s) => s.kind === 'feed').length).toBe(6);
  });
});

describe('재생기', () => {
  const stock = { diameter: 50, length: 91, grip: 20, faceAllowance: 1 };
  const code = `G50 S2000 T0300 ;\nG96 S150 M03 ;\nG00 X52. Z2. T0303 ;\nG90 X46. Z-30. F0.2 ;\nX42. ;\nG00 X100. Z100. ;\nM30 ;\n`;

  it('줄을 골라 그 블록부터 다시 재생하면 앞부분 절삭은 끝나 있다', () => {
    const p = compile(code, cfg());
    const player = new Player(p, stock, defaultTools());
    player.start();
    const t = p.segments.find((s) => s.line === 4)!.start;
    player.seek(t);
    expect(player.state).toBe('run');
    expect(player.time).toBeCloseTo(t, 6);
    const r = Math.max(...intersection(player.sim.stock, [rect(-25, -5, -1, 100)]).flat().map((q) => q.Y / 1000));
    expect(r).toBeLessThan(23.5);
    // 뒤로 가면 소재가 처음부터 다시 깎인다
    player.seek(0);
    expect(player.sim.version).toBeGreaterThan(0);
    expect(Math.max(...player.sim.stock.flat().map((q) => q.Y / 1000))).toBeCloseTo(25, 3);
  });

  it('급속 오버라이드는 급속 구간만 느리게 한다', () => {
    const p = compile(code, cfg());
    const rapid = p.segments[0].kind === 'rapid' ? p.segments[0] : p.segments.find((s) => s.kind === 'rapid')!;
    const a = new Player(p, stock, defaultTools());
    const b = new Player(p, stock, defaultTools());
    b.rapidOverride = 0.25;
    for (const pl of [a, b]) {
      pl.start();
      pl.time = rapid.start;
      pl.sim.advanceTo(rapid.start);
      pl.tick(rapid.duration / 2);
    }
    expect(b.time - rapid.start).toBeCloseTo((a.time - rapid.start) / 4, 6);
  });
});

describe('풀어쓴 프로그램', () => {
  it('O4100(G00·G01) 은 O4000(복합 사이클) 과 같은 결과를 낸다', () => {
    const a = SAMPLES.find((x) => x.id === 'multi')!;
    const b = SAMPLES.find((x) => x.id === 'multi-g01')!;
    // 주석을 뺀 실제 코드에 반복 사이클이 없어야 한다
    expect(b.code.replace(/\([^)]*\)/g, '')).not.toMatch(/G7[0-6]|G9[024]/);
    const res = (code: string) => {
      const p = compile(code, cfg());
      expect(p.alarm).toBeNull();
      const sim = new CutSim(p, a.stock, defaultTools());
      expect(sim.advanceTo(p.duration + 1)).toBeNull();
      return { p, sim };
    };
    const A = res(a.code);
    const B = res(b.code);
    const xor = [...difference(A.sim.stock, B.sim.stock), ...difference(B.sim.stock, A.sim.stock)];
    const area = xor.reduce((s, q) => s + areaOf(q), 0);
    expect(area).toBeLessThan(0.05);
    expect(Math.abs(A.p.duration - B.p.duration)).toBeLessThan(1);
  });
});

describe('편집 미리보기', () => {
  const stock = { diameter: 50, length: 91, grip: 20, faceAllowance: 1 };
  const code = `G50 S2000 T0300 ;\nG97 S1000 M03 ;\nG00 X52. Z2. ;\nG90 X46. Z-30. F0.2 ;\nX42. ;\nG00 X100. Z100. ;\nM30 ;\n`;

  it('커서 블록까지 깎인 모습을 보여 주고, 시작하면 처음부터', () => {
    const p = compile(code, cfg());
    const pl = new Player(p, stock, defaultTools());
    const endOfLine4 = Math.max(...p.segments.filter((s) => s.line === 3).map((s) => s.start + s.duration));
    pl.setPreview(endOfLine4);
    expect(pl.state).toBe('ready');
    expect(pl.time).toBe(0);
    expect(pl.viewTime).toBeCloseTo(endOfLine4, 6);
    const r = Math.max(...intersection(pl.sim.stock, [rect(-25, -5, -1, 100)]).flat().map((q) => q.Y / 1000));
    expect(r).toBeCloseTo(23, 2);
    // 뒤로 가면 다시 원래 소재
    pl.setPreview(0);
    expect(Math.max(...pl.sim.stock.flat().map((q) => q.Y / 1000))).toBeCloseTo(25, 3);
    pl.setPreview(endOfLine4);
    pl.start();
    expect(pl.sim.time).toBe(0);
    expect(Math.max(...pl.sim.stock.flat().map((q) => q.Y / 1000))).toBeCloseTo(25, 3);
  });

  it('미리보기 중 충돌하면 알람을 알려 준다', () => {
    const p = compile(`G50 S2000 T0300 ;\nG97 S1000 M03 ;\nG00 X40. Z2. ;\nZ-20. ;\nM30 ;\n`, cfg());
    const pl = new Player(p, stock, defaultTools());
    pl.setPreview(p.duration);
    expect(pl.alarm?.code).toBe('SIM02');
    expect(pl.state).toBe('ready');
    pl.setPreview(0);
    expect(pl.alarm).toBeNull();
  });
});
