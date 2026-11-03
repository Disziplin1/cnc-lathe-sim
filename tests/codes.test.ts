/**
 * G코드 · M코드 하나하나가 Fanuc 과 같은 숫자를 내는지 확인.
 * 기계 원점 X200 Z150, 급속 15000 mm/min, 최고 4000 rpm.
 */
import { describe, expect, it } from 'vitest';
import { compile, type MachineConfig } from '../src/nc/interpreter';
import { defaultOffsets, defaultTools } from '../src/machine/tools';
import type { Program, Vec } from '../src/nc/types';
import { CutSim, type StockConfig } from '../src/sim/simulator';
import { Player } from '../src/sim/player';
import { intersection, rect } from '../src/sim/geometry';

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
const stock: StockConfig = { diameter: 50, length: 91, grip: 20, faceAllowance: 1 };

/** 줄(1부터)로 그 블록의 세그먼트 */
const segsOf = (p: Program, line1: number) => p.segments.filter((s) => s.line === line1 - 1);
const endOf = (p: Program): Vec => {
  const s = p.segments[p.segments.length - 1];
  return s.pts[s.pts.length - 1];
};
const X = (v: Vec) => 2 * v.r;
const close = (a: number, b: number, d = 3) => expect(a).toBeCloseTo(b, d);

const HEAD = 'G50 S3000 T0300 ;\nG97 S1000 M03 ;\n'; // 1, 2행

describe('G00 급속 이송', () => {
  it('X 는 직경, Z 는 그대로 (절대)', () => {
    const p = compile(HEAD + 'G00 X40. Z2. ;\n', cfg());
    close(X(endOf(p)), 40);
    close(endOf(p).z, 2);
  });
  it('U W 는 증분 (U 도 직경값)', () => {
    const p = compile(HEAD + 'G00 X40. Z2. ;\nU-10. W-5. ;\n', cfg());
    close(X(endOf(p)), 30);
    close(endOf(p).z, -3);
  });
  it('축마다 따로 움직여 꺾인 경로, 시간 = 긴 축 거리 / 급속속도', () => {
    const p = compile(HEAD + 'G00 X40. Z2. ;\n', cfg());
    const s = segsOf(p, 3)[0];
    // 원점 (r100, z150) → (r20, z2): Z 148, X(반경) 80 이동 → 45° 로 80 간 뒤 Z 만 68
    close(s.pts[1].r, 20);
    close(s.pts[1].z, 70);
    close(s.duration, 148 / (15000 / 60));
  });
});

describe('G01 직선 절삭', () => {
  it('G99 회전당 이송: F0.2 × 1000rpm = 200 mm/min → 20mm 는 6초', () => {
    const p = compile(HEAD + 'G00 X40. Z2. ;\nG01 Z-18. F0.2 ;\n', cfg());
    const s = segsOf(p, 4)[0];
    close(s.feed, 200);
    close(s.duration, 6);
  });
  it('G98 분당 이송: F100 → 10mm 는 6초', () => {
    const p = compile(HEAD + 'G00 X40. Z2. ;\nG98 G01 Z-8. F100. ;\n', cfg());
    close(segsOf(p, 4)[0].duration, 6);
  });
  it('테이퍼 끝점이 정확하다', () => {
    const p = compile(HEAD + 'G00 X20. Z2. ;\nG01 X30. Z-3. F0.1 ;\n', cfg());
    close(X(endOf(p)), 30);
    close(endOf(p).z, -3);
  });
  it('F 가 한 번 지령되면 다음 블록에도 유지 (모달)', () => {
    const p = compile(HEAD + 'G00 X40. Z2. ;\nG01 Z-8. F0.2 ;\nZ-18. ;\n', cfg());
    close(segsOf(p, 5)[0].duration, 3);
  });
  it('F 없이 G01 → PS0011', () => {
    expect(compile(HEAD + 'G01 X40. Z-8. ;\n', cfg()).alarm?.code).toBe('PS0011');
  });
});

describe('G02 / G03 원호', () => {
  // 시작 (Z0, X20) → 끝 (Z-5, X30), R5 = 90° 원호
  const center = (code: string) => {
    const p = compile(HEAD + `G00 X20. Z0. ;\n${code} X30. Z-5. R5. F0.1 ;\n`, cfg());
    expect(p.alarm).toBeNull();
    const pts = segsOf(p, 4)[0].pts;
    const mid = pts[Math.floor(pts.length / 2)];
    return { p, mid };
  };
  it('G03(반시계) 은 볼록 모서리: 중심 (Z-5, X20)', () => {
    const { p, mid } = center('G03');
    close(Math.hypot(mid.z + 5, mid.r - 10), 5);
    close(X(endOf(p)), 30);
  });
  it('G02(시계) 는 오목 모서리: 중심 (Z0, X30)', () => {
    const { mid } = center('G02');
    close(Math.hypot(mid.z - 0, mid.r - 15), 5);
  });
  it('I K 지령도 같은 원호', () => {
    const p = compile(HEAD + 'G00 X20. Z0. ;\nG03 X30. Z-5. I0. K-5. F0.1 ;\n', cfg());
    const pts = segsOf(p, 4)[0].pts;
    const mid = pts[Math.floor(pts.length / 2)];
    close(Math.hypot(mid.z + 5, mid.r - 10), 5);
  });
  it('R 마이너스는 180° 보다 큰 원호', () => {
    const p = compile(HEAD + 'G00 X20. Z0. ;\nG03 X30. Z-5. R-5. F0.1 ;\n', cfg());
    const pts = segsOf(p, 4)[0].pts;
    const len = pts.slice(1).reduce((a, q, i) => a + Math.hypot(q.z - pts[i].z, q.r - pts[i].r), 0);
    close(len, (3 * Math.PI * 5) / 2, 1); // 270°
  });
  it('시간 = 원호 길이 / 이송속도', () => {
    const { p } = center('G03');
    close(segsOf(p, 4)[0].duration, ((Math.PI * 5) / 2 / 100) * 60, 2);
  });
  it('R 이 너무 작으면 PS0020', () => {
    expect(compile(HEAD + 'G00 X20. Z0. ;\nG03 X40. Z-10. R2. F0.1 ;\n', cfg()).alarm?.code).toBe('PS0020');
  });
});

describe('G04 일시정지', () => {
  it.each([
    ['P1500', 1.5],
    ['X2.', 2],
    ['U0.5', 0.5],
  ])('G04 %s → %s초', (w, sec) => {
    const p = compile(HEAD + `G04 ${w} ;\n`, cfg());
    const s = segsOf(p, 3)[0];
    expect(s.kind).toBe('dwell');
    close(s.duration, sec as number);
  });
});

describe('G28 원점 복귀', () => {
  it('U0. W0. → 기계 원점 (X200 Z150)', () => {
    const p = compile(HEAD + 'G00 X40. Z2. ;\nG28 U0. W0. ;\n', cfg());
    close(X(endOf(p)), 200);
    close(endOf(p).z, 150);
  });
  it('지정한 축만 돌아간다 (U0. 만 → Z 는 그대로)', () => {
    const p = compile(HEAD + 'G00 X40. Z2. ;\nG28 U0. ;\n', cfg());
    close(X(endOf(p)), 200);
    close(endOf(p).z, 2);
  });
  it('중간점을 거쳐서 간다', () => {
    const p = compile(HEAD + 'G00 X40. Z2. ;\nG28 X60. Z10. ;\n', cfg());
    const first = segsOf(p, 4)[0];
    close(X(first.pts[first.pts.length - 1]), 60);
    close(first.pts[first.pts.length - 1].z, 10);
  });
});

describe('G32 나사 절삭', () => {
  it('리드 × 회전수로 이송, 주축 정지면 알람', () => {
    const p = compile(HEAD + 'G00 X20. Z5. ;\nG32 Z-20. F1.5 ;\n', cfg());
    const s = segsOf(p, 4)[0];
    expect(s.kind).toBe('thread');
    close(s.feed, 1500);
    expect(compile('T0700 ;\nG00 X20. Z5. ;\nG32 Z-20. F1.5 ;\n', cfg()).alarm?.code).toBe('SIM01');
  });
});

describe('G50', () => {
  it('G96 일 때만 S 최고 회전수 제한', () => {
    const p96 = compile('G50 S1500 T0300 ;\nG96 S200 M03 ;\nG00 X10. Z2. ;\nG01 Z0. F0.1 ;\n', cfg());
    close(segsOf(p96, 4)[0].rpm, 1500);
    const p97 = compile('G50 S1500 T0300 ;\nG97 S3000 M03 ;\nG00 X10. Z2. ;\nG01 Z0. F0.1 ;\n', cfg());
    close(segsOf(p97, 4)[0].rpm, 3000);
  });
  it('X Z: 현재 위치를 그 좌표로 정의', () => {
    const p = compile(HEAD + 'G50 X100. Z50. ;\nG00 X80. Z40. ;\n', cfg());
    // 원점(물리 X200 Z150)이 X100 Z50 이 되므로 X80 Z40 은 물리 X180 Z140
    close(X(endOf(p)), 180);
    close(endOf(p).z, 140);
  });
});

describe('G90 / G92 / G94 단일 사이클', () => {
  it('G90: X 급속 → Z 절삭 → X 절삭 복귀 → Z 급속 복귀', () => {
    const p = compile(HEAD + 'G00 X52. Z2. ;\nG90 X40. Z-30. F0.2 ;\n', cfg());
    const k = segsOf(p, 4).map((s) => s.kind);
    expect(k).toEqual(['rapid', 'feed', 'feed', 'rapid']);
    close(endOf(p).r, 26);
    close(endOf(p).z, 2);
  });
  it('G90 R: 테이퍼 (반경값, 시작 - 끝)', () => {
    const p = compile(HEAD + 'G00 X52. Z2. ;\nG90 X40. Z-30. R-2. F0.2 ;\n', cfg());
    const cut = segsOf(p, 4)[1];
    close(cut.pts[0].r, 18);
    close(cut.pts[cut.pts.length - 1].r, 20);
  });
  it('G92: 나사 절삭 후 X 급속 후퇴, F 가 리드', () => {
    const p = compile(HEAD + 'G00 X24. Z5. ;\nG92 X19.3 Z-20. F1.5 ;\n', cfg());
    const k = segsOf(p, 4).map((s) => s.kind);
    expect(k).toEqual(['rapid', 'thread', 'rapid', 'rapid']);
    close(segsOf(p, 4)[1].feed, 1500);
  });
  it('G94: Z 급속 → X 절삭 → Z 절삭 복귀 → X 급속 복귀', () => {
    const p = compile(HEAD + 'G00 X52. Z2. ;\nG94 X20. Z-2. F0.2 ;\n', cfg());
    const s = segsOf(p, 4);
    expect(s.map((x) => x.kind)).toEqual(['rapid', 'feed', 'feed', 'rapid']);
    close(s[1].pts[s[1].pts.length - 1].r, 10);
    close(s[1].pts[s[1].pts.length - 1].z, -2);
  });
});

describe('G96 / G97 회전수', () => {
  it('G96 S150 은 Ø50 에서 955 rpm, Ø25 에서 1910 rpm', () => {
    const p = compile('G50 S3000 T0300 ;\nG96 S150 M03 ;\nG00 X50. Z2. ;\nG01 Z0. F0.1 ;\nG00 X25. ;\nG01 Z-2. ;\n', cfg());
    close(segsOf(p, 4)[0].rpm, 954.93, 1);
    close(segsOf(p, 6)[0].rpm, 1909.86, 1);
  });
  it('G97 S800 은 어디서나 800 rpm', () => {
    const p = compile('T0300 ;\nG97 S800 M03 ;\nG00 X50. Z2. ;\nG01 Z0. F0.1 ;\n', cfg());
    close(segsOf(p, 4)[0].rpm, 800);
  });
});

describe('그 밖의 G코드', () => {
  it('G21 G18 G54 G40 G80 은 받아들인다', () => {
    expect(compile(HEAD + 'G21 G18 G54 G40 G80 ;\n', cfg()).alarm).toBeNull();
  });
  it('G20(인치), 지원하지 않는 G65 는 알람', () => {
    expect(compile('G20 ;\n', cfg()).alarm).not.toBeNull();
    expect(compile('G65 P1000 ;\n', cfg()).alarm).not.toBeNull();
  });
  it('같은 그룹 G 두 개는 알람 (G00 G01)', () => {
    expect(compile('G00 G01 X10. ;\n', cfg()).alarm?.code).toBe('PS0010');
  });
});

describe('M코드', () => {
  it('M03 / M04 / M05 주축', () => {
    const p = compile('T0300 ;\nG97 S500 M04 ;\nG00 X50. Z2. ;\nM05 ;\nG00 X60. ;\nM03 ;\nG00 X70. ;\n', cfg());
    expect(segsOf(p, 3)[0].snap.spindle).toBe('M04');
    expect(segsOf(p, 5)[0].snap.spindle).toBe('M05');
    expect(segsOf(p, 7)[0].snap.spindle).toBe('M03');
  });
  it('M05 뒤 절삭은 알람', () => {
    expect(compile(HEAD + 'M05 ;\nG01 X40. F0.2 ;\n', cfg()).alarm?.code).toBe('SIM01');
  });
  it('M08 / M09 절삭유', () => {
    const p = compile(HEAD + 'G00 X50. Z2. M08 ;\nG00 X60. M09 ;\nG00 X70. ;\n', cfg());
    expect(segsOf(p, 3)[0].snap.coolant).toBe(true);
    expect(segsOf(p, 5)[0].snap.coolant).toBe(false);
  });
  it('M30 / M02 뒤의 블록은 실행하지 않는다', () => {
    for (const m of ['M30', 'M02']) {
      const p = compile(HEAD + `G00 X50. Z2. ;\n${m} ;\nG00 X10. ;\n`, cfg());
      expect(p.segments.some((s) => s.line === 4)).toBe(false);
    }
  });
  it('M00 은 항상, M01 은 선택정지 켰을 때만 멈춘다', () => {
    const p = compile(HEAD + 'G00 X50. Z2. ;\nM00 ;\nG00 X60. ;\nM01 ;\nG00 X70. ;\nM30 ;\n', cfg());
    const pl = new Player(p, stock, defaultTools());
    pl.start();
    pl.tick(1000);
    expect(pl.state).toBe('stop');
    close(X(pl.current().pos!), 50);
    pl.start();
    pl.tick(1000);
    expect(pl.state).toBe('done'); // M01 은 꺼져 있으면 지나감
    const pl2 = new Player(p, stock, defaultTools());
    pl2.optionalStop = true;
    pl2.start();
    pl2.tick(1000);
    pl2.start();
    pl2.tick(1000);
    expect(pl2.state).toBe('stop');
    close(X(pl2.current().pos!), 60);
  });
  it('지원하지 않는 M98 은 알람', () => {
    expect(compile('M98 P1000 ;\n', cfg()).alarm).not.toBeNull();
  });
});

describe('T코드 · 블록 스킵 · 주석', () => {
  it('공구 교환 1초, 없는 공구는 알람', () => {
    const p = compile('T0300 ;\n', cfg());
    expect(p.segments[0].kind).toBe('tool');
    close(p.segments[0].duration, 1);
    expect(compile('T0200 ;\n', cfg()).alarm).not.toBeNull();
  });
  it('/ 블록은 블록스킵 켜면 건너뛰고, 끄면 실행', () => {
    const code = HEAD + 'G00 X50. Z2. ;\n/ G00 X10. ;\n';
    close(X(endOf(compile(code, cfg()))), 50);
    close(X(endOf(compile(code, cfg({ blockSkip: false })))), 10);
  });
  it('( ) 주석은 무시', () => {
    const p = compile(HEAD + 'G00 X50. Z2. (여기는 주석 G01 X0.) ;\n', cfg());
    expect(p.alarm).toBeNull();
    close(X(endOf(p)), 50);
  });
});

describe('가공 결과 치수', () => {
  /** z0~z1 사이 소재 최대 지름 */
  const dia = (sim: CutSim, z0: number, z1: number) =>
    2 * Math.max(...intersection(sim.stock, [rect(z1, z0, -1, 200)]).flat().map((q) => q.Y / 1000));

  it('계단축: 지름과 길이가 지령값 그대로 (G42 정삭)', () => {
    const code = `G50 S2500 T0300 ;\nG96 S180 M03 ;\nG00 X54. Z0. T0303 ;\nG01 X-1. F0.1 ;\nG00 X52. Z2. ;\nG90 X46. Z-35. F0.2 ;\nX42. ;\nX36. Z-19.9 ;\nX31. ;\nG42 G00 X30. Z2. ;\nG01 Z-20. F0.1 ;\nX40. ;\nZ-35. ;\nX52. ;\nG40 G00 X100. Z100. ;\nM30 ;\n`;
    const p = compile(code, cfg());
    expect(p.alarm).toBeNull();
    const sim = new CutSim(p, stock, defaultTools());
    expect(sim.advanceTo(p.duration)).toBeNull();
    close(dia(sim, -2, -18), 30, 2);
    close(dia(sim, -22, -33), 40, 2);
    // 어깨 위치 Z-20, 끝 Z-35, 끝면 Z0
    // (오목 모서리 0.4mm 안쪽은 노즈 R0.4 때문에 R 이 남으므로 0.5mm 떨어진 곳에서 잰다)
    close(dia(sim, -19.5, -19.52), 30, 2);
    close(dia(sim, -20.05, -20.07), 40, 2);
    close(dia(sim, -34.5, -34.52), 40, 2);
    close(dia(sim, -35.1, -35.2), 50, 2);
    expect(intersection(sim.stock, [rect(0.01, 5, -1, 200)]).length).toBe(0);
  });

  it('소재 크기: Ø 와 길이대로 만들어진다', () => {
    const s: StockConfig = { diameter: 64, length: 120, grip: 30, faceAllowance: 2 };
    const sim = new CutSim(compile('M30 ;\n', cfg()), s, defaultTools());
    const all = sim.stock.flat();
    close((2 * Math.max(...all.map((q) => q.Y))) / 1000, 64);
    close((Math.max(...all.map((q) => q.X)) - Math.min(...all.map((q) => q.X))) / 1000, 120);
    close(Math.max(...all.map((q) => q.X)) / 1000, 2);
  });
});
