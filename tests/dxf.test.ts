import { describe, expect, it } from 'vitest';
import { dxfToTarget } from '../src/sim/dxf';
import { parseTarget } from '../src/sim/compare';
import { fitStock } from '../src/sim/simulator';

type Ent = [string, [number, string | number][]];

/** 최소한의 ASCII DXF 만들기 */
function dxf(ents: Ent[], layers: [string, string][] = []): string {
  const out: (string | number)[] = [0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER'];
  for (const [name, lt] of layers) out.push(0, 'LAYER', 2, name, 70, 0, 6, lt);
  out.push(0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES');
  for (const [type, codes] of ents) {
    out.push(0, type);
    for (const [c, v] of codes) out.push(c, v);
  }
  out.push(0, 'ENDSEC', 0, 'EOF');
  return out.join('\r\n');
}

const line = (x1: number, y1: number, x2: number, y2: number, layer = '0'): Ent => ['LINE', [[8, layer], [10, x1], [20, y1], [11, x2], [21, y2]]];
const arc = (cx: number, cy: number, r: number, a0: number, a1: number): Ent => ['ARC', [[8, '0'], [10, cx], [20, cy], [40, r], [50, a0], [51, a1]]];

/** 선을 이어서 (위쪽 절반 꺾은선) */
const chain = (pts: [number, number][], mirrorAxis?: number): Ent[] => {
  const out: Ent[] = [];
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    out.push(line(a[0], a[1], b[0], b[1]));
    if (mirrorAxis !== undefined) out.push(line(a[0], 2 * mirrorAxis - a[1], b[0], 2 * mirrorAxis - b[1]));
  }
  return out;
};

/** 두 도면 텍스트의 외곽선이 같은지 */
function sameProfile(got: string, want: string) {
  const a = parseTarget(got);
  const b = parseTarget(want);
  expect(a.error).toBeNull();
  expect(b.error).toBeNull();
  const pa = a.target!.profile;
  const pb = b.target!.profile;
  expect(pa.length).toBe(pb.length);
  pa.forEach((p, i) => {
    expect(p.z).toBeCloseTo(pb[i].z, 3);
    expect(p.r).toBeCloseTo(pb[i].r, 3);
  });
}

// 질문에 나온 도면: Ø20×10 (C1), Ø40×20, 테이퍼 5, Ø55×30. 척 쪽 x=0, 끝면 x=65, 축 y=100
const TOP: [number, number][] = [
  [64, 110],
  [55, 110],
  [55, 120],
  [35, 120],
  [30, 127.5],
  [0, 127.5],
];
const WANT = `X0. Z0.
X18.
X20. Z-1.
Z-10.
X40.
Z-30.
X55. Z-35.
Z-65.
`;

describe('DXF 불러오기', () => {
  it('위아래 전체 도면 + 중심선 + 치수/문자는 무시', () => {
    const src = dxf(
      [
        ...chain(TOP, 100),
        line(65, 109, 64, 110),
        line(65, 91, 64, 90),
        line(65, 91, 65, 109), // 끝면: 축을 가로지른다
        line(0, 72.5, 0, 127.5), // 척 쪽 끝
        line(-5, 100, 70, 100, 'CENTER'),
        ['DIMENSION', [[8, 'DIM'], [10, 0], [20, 60], [13, 0], [23, 72.5], [14, 65], [24, 72.5]]],
        ['TEXT', [[8, '0'], [10, 30], [20, 50], [40, 3], [1, '65']]],
        line(0, 60, 65, 60, 'DIM'),
      ],
      [['CENTER', 'CENTER'], ['DIM', 'CONTINUOUS']],
    );
    const r = dxfToTarget(src, { name: 'shaft.dxf' });
    sameProfile(r.text, WANT);
    expect(r.maxDia).toBeCloseTo(55, 3);
    expect(r.length).toBeCloseTo(65, 3);
    expect(r.text.split('\n')[0]).toContain('shaft.dxf');
  });

  it('중심선이 없어도 위아래 대칭이면 가운데가 축', () => {
    const src = dxf([...chain(TOP, 100), line(65, 109, 64, 110), line(65, 91, 64, 90), line(65, 91, 65, 109), line(0, 72.5, 0, 127.5)]);
    sameProfile(dxfToTarget(src).text, WANT);
  });

  it('위쪽 절반만 그린 도면 (축은 맨 아래 선)', () => {
    const src = dxf([...chain(TOP), line(65, 109, 64, 110), line(65, 100, 65, 109), line(0, 100, 0, 127.5), line(0, 100, 65, 100)]);
    sameProfile(dxfToTarget(src).text, WANT);
  });

  it('끝면이 왼쪽인 도면', () => {
    const m = (pts: [number, number][]) => pts.map(([x, y]) => [-x, y] as [number, number]);
    const src = dxf([...chain(m(TOP), 100), line(-65, 109, -64, 110), line(-65, 91, -64, 90), line(-65, 91, -65, 109), line(0, 72.5, 0, 127.5)]);
    sameProfile(dxfToTarget(src, { faceLeft: true }).text, WANT);
  });

  it('원호: 오목 R1 은 G02, 볼록 R2 는 G03 (ARC 엔티티)', () => {
    // 끝면 x=50, Ø20 → 오목 R1 → 단 → Ø40 볼록 R2 → 척
    const src = dxf([
      line(50, 0, 50, 10),
      line(50, 10, 41, 10),
      arc(41, 11, 1, 180, 270), // (41,10) → (40,11) 오목
      line(40, 11, 40, 18),
      arc(38, 18, 2, 0, 90), // (40,18) → (38,20) 볼록
      line(38, 20, 0, 20),
      line(0, 0, 0, 20),
      line(0, 0, 50, 0),
    ]);
    const r = dxfToTarget(src);
    expect(r.text).toContain('G02 X22. Z-10. R1.');
    expect(r.text).toContain('G03 X40. Z-12. R2.');
    expect(r.arcs).toBe(2);
    sameProfile(r.text, 'X0. Z0.\nX20.\nZ-9.\nG02 X22. Z-10. R1.\nG01 X36.\nG03 X40. Z-12. R2.\nG01 Z-50.\n');
  });

  it('LWPOLYLINE 볼록률(bulge) 원호', () => {
    // 위 예제와 같은 형상을 닫힌 폴리선 하나로. 오목 R1 은 시계(bulge<0), 볼록 R2 는 반시계(bulge>0)
    const b = Math.tan(Math.PI / 8);
    const v: [number, number, number][] = [
      [50, 0, 0],
      [50, 10, 0],
      [41, 10, -b],
      [40, 11, 0],
      [40, 18, b],
      [38, 20, 0],
      [0, 20, 0],
      [0, 0, 0],
    ];
    const codes: [number, string | number][] = [[8, '0'], [90, v.length], [70, 1]];
    for (const [x, y, bulge] of v) codes.push([10, x], [20, y], [42, bulge]);
    const r = dxfToTarget(dxf([['LWPOLYLINE', codes]]));
    sameProfile(r.text, 'X0. Z0.\nX20.\nZ-9.\nG02 X22. Z-10. R1.\nG01 X36.\nG03 X40. Z-12. R2.\nG01 Z-50.\n');
  });

  it('외곽선이 없으면 알려 준다', () => {
    expect(() => dxfToTarget(dxf([['TEXT', [[8, '0'], [1, 'hello']]]]))).toThrow(/외곽선/);
    expect(() => dxfToTarget('hello')).toThrow(/DXF/);
  });
});

describe('도면에 맞춰 소재 늘리기', () => {
  const stock = { diameter: 50, length: 91, grip: 20, faceAllowance: 1 };
  it('작으면 지름은 5mm 단위로, 길이는 도면 + 10mm 나오게 늘린다', () => {
    expect(fitStock(stock, 55, 65)).toEqual({ diameter: 60, length: 75 + 21, grip: 20, faceAllowance: 1 });
  });
  it('이미 충분하면 그대로 (줄이지 않는다)', () => {
    expect(fitStock(stock, 46, 55)).toEqual(stock);
    expect(fitStock(stock, 20, 10)).toEqual(stock);
  });
});
