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

  it('끝면이 왼쪽: 단의 세로선과 그 아래 필렛 원호가 같은 방향으로 출발해도 원호를 따라간다', () => {
    // 끝면 x=0 (왼쪽), Ø20 → 단(세로선이 축까지 그려짐) → 필렛 R1.5 → Ø7 → Ø20 → 척 쪽 x=50
    const src = dxf([
      line(0, 0, 0, 10),
      line(0, 10, 20, 10),
      line(20, 10, 20, 0),
      arc(21.5, 5, 1.5, 180, 270),
      line(21.5, 3.5, 40, 3.5),
      line(40, 3.5, 40, 10),
      line(40, 10, 50, 10),
      line(50, 10, 50, 0),
      line(0, 0, 50, 0, 'CENTER'),
    ]);
    const r = dxfToTarget(src, { faceLeft: true });
    expect(r.flipped).toBe(false);
    sameProfile(r.text, ['X0. Z0.', 'X20.', 'Z-20.', 'X10.', 'G02 X7. Z-21.5 R1.5', 'G01 Z-40.', 'X20.', 'Z-50.'].join('\n'));
  });

  it('끝면이 왼쪽을 직접 고르면 척 쪽 끝이 뾰족해도 뒤집지 않는다', () => {
    // 끝면 x=0 Ø20, 척 쪽 x=30 에서 원뿔로 축까지
    const src = dxf([line(0, 0, 0, 10), line(0, 10, 20, 10), line(20, 10, 30, 0), line(0, 0, 30, 0, 'CENTER')]);
    const r = dxfToTarget(src, { faceLeft: true });
    expect(r.flipped).toBe(false);
    sameProfile(r.text, ['X0. Z0.', 'X20.', 'Z-20.', 'X0. Z-30.'].join('\n'));
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

describe('도면에 맞춰 소재 맞추기', () => {
  const stock = { diameter: 50, length: 91, grip: 20, faceAllowance: 1 };
  it('작으면 지름은 5mm 단위로, 길이는 도면 + 10mm 나오게 늘린다', () => {
    expect(fitStock(stock, 55, 65)).toEqual({ diameter: 60, length: 75 + 21, grip: 20, faceAllowance: 1 });
  });
  it('딱 맞으면 그대로', () => {
    expect(fitStock(stock, 46, 60)).toEqual(stock);
  });
  it('너무 크면 줄인다 (물림 · 단면 여유는 그대로)', () => {
    expect(fitStock(stock, 10, 76)).toEqual({ diameter: 15, length: 86 + 21, grip: 20, faceAllowance: 1 });
    expect(fitStock(stock, 20, 10)).toEqual({ diameter: 25, length: 20 + 21, grip: 20, faceAllowance: 1 });
  });
});

describe('DXF 나사 · 널링 글자 찾기', () => {
  // 사용자 도면과 같은 모양: Ø15 x 60 (널링) + Ø6 x 32, 끝 15mm M6 나사 (골지름 가는 선 포함)
  const ax = 50;
  const half = (s: number): Ent[] => [
    line(92, ax, 92, ax + s * 2.5),
    line(92, ax + s * 2.5, 91.5, ax + s * 3),
    line(91.5, ax + s * 3, 60, ax + s * 3),
    line(60, ax + s * 3, 60, ax + s * 7.5),
    line(60, ax + s * 7.5, 0, ax + s * 7.5),
    line(0, ax + s * 7.5, 0, ax),
    // 골지름 선과 나사 끝 선
    line(91.5, ax + s * 2.5, 77, ax + s * 2.5),
    line(77, ax + s * 2.5, 77, ax + s * 3),
  ];
  const ents: Ent[] = [
    ...half(1),
    ...half(-1),
    line(-5, ax, 100, ax, 'CENTER'),
    ['DIMENSION', [[8, 'DIM'], [3, 'ISO-25'], [1, 'M6'], [11, 100], [21, ax]]],
    ['TEXT', [[8, 'TEXT'], [10, 25], [20, ax + 20], [1, 'KNURLING']]],
    ['LEADER', [[8, 'DIM'], [10, 20], [20, ax + 5], [10, 25], [20, ax + 20]]],
    ['HATCH', [[8, 'HATCH'], [10, 0], [20, 0], [10, 10], [20, ax + 3], [10, 30], [20, ax + 3], [10, 30], [20, ax + 7.5], [10, 10], [20, ax + 7.5]]],
  ];

  it('M6 → 보통나사 피치 1, 골지름 선 길이만큼 / 널링은 그 지름 구간 전체', () => {
    const r = dxfToTarget(dxf(ents, [['CENTER', 'CENTER']]));
    expect(r.threads).toBe(1);
    expect(r.knurls).toBe(1);
    expect(r.text).toContain('(나사 M6 Z0. ~ Z-15.)');
    expect(r.text).toContain('(널링 Z-32. ~ Z-92.)');
    sameProfile(r.text, 'X0. Z0.\nX5.\nX6. Z-0.5\nZ-32.\nX15.\nZ-92.\n');
  });

  it('치수 글자 "M<>*L70" 의 <> 는 잰 값(42)으로 바꿔 읽는다', () => {
    const dim: Ent[] = [...ents.filter((e) => e[0] !== 'DIMENSION'), ['DIMENSION', [[8, 'DIM'], [1, 'M<>*L70'], [42, 6], [11, 100], [21, ax]]]];
    const r = dxfToTarget(dxf(dim, [['CENTER', 'CENTER']]));
    expect(r.threads).toBe(1);
    expect(r.text).toContain('(나사 M6 Z0. ~ Z-15.)');
  });

  it('KNURLING 글자 하나에 화살표가 둘이면 두 구간 모두 널링', () => {
    const two: Ent[] = [...ents, ['LEADER', [[8, 'DIM'], [10, 70], [20, ax + 3], [10, 26], [20, ax + 19]]]];
    const r = dxfToTarget(dxf(two, [['CENTER', 'CENTER']]));
    expect(r.knurls).toBe(2);
    expect(r.text).toContain('(널링 Z-32. ~ Z-92.)');
    expect(r.text).toContain('(널링 Z-0.5 ~ Z-32.)');
  });

  it('글자가 없으면 나사 · 널링 줄도 없다', () => {
    const r = dxfToTarget(dxf(ents.filter((e) => e[0] === 'LINE'), [['CENTER', 'CENTER']]));
    expect(r.threads + r.knurls).toBe(0);
    expect(r.text).not.toMatch(/나사|널링/);
  });
});

describe('DXF 내경(구멍) 찾기', () => {
  const ax = 50;
  // 부시: Ø40 x 30, 끝면 x=30, 관통 구멍 Ø20 (끝면 쪽 C1), 단면도 (구멍 선이 실선)
  const bushHalf = (s: number): Ent[] =>
    chain(
      [
        [30, ax + s * 11],
        [30, ax + s * 20],
        [0, ax + s * 20],
        [0, ax + s * 10],
        [29, ax + s * 10],
        [30, ax + s * 11],
      ].map(([x, y]) => [x, y] as [number, number]),
    );

  it('관통 구멍: (내경) 아래에 구멍 윤곽', () => {
    const r = dxfToTarget(dxf([...bushHalf(1), ...bushHalf(-1), line(-5, ax, 40, ax, 'CENTER')], [['CENTER', 'CENTER']]));
    const [outer, inner] = r.text.split('(내경)');
    expect(inner).toBeDefined();
    expect(outer).toContain('X22. Z0.');
    expect(outer).toContain('X40.');
    expect(inner.trim().split('\n')).toEqual(['X22. Z0.', 'G01 X20. Z-1.', 'G01 X20. Z-30.']);
    const t = parseTarget(r.text).target!;
    expect(t.inner).not.toBeNull();
  });

  it('막힌 구멍을 숨은선으로 그린 도면도 읽는다', () => {
    // Ø40 x 30, 구멍 Ø16 깊이 15 (바닥 평평), 구멍은 숨은선
    const outer: Ent[] = [
      ...chain([[30, ax - 20], [30, ax + 20], [0, ax + 20], [0, ax - 20], [30, ax - 20]] as [number, number][]),
    ];
    const hid = (x1: number, y1: number, x2: number, y2: number) => line(x1, y1, x2, y2, 'HID');
    const hole: Ent[] = [hid(30, ax + 8, 15, ax + 8), hid(15, ax + 8, 15, ax - 8), hid(15, ax - 8, 30, ax - 8)];
    const r = dxfToTarget(dxf([...outer, ...hole, line(-5, ax, 40, ax, 'CENTER')], [['CENTER', 'CENTER'], ['HID', 'HIDDEN']]));
    const inner = r.text.split('(내경)')[1];
    expect(inner).toBeDefined();
    expect(inner.trim().split('\n')).toEqual(['X16. Z0.', 'G01 X16. Z-15.', 'G01 X0. Z-15.']);
    // 외경은 그대로
    sameProfile(r.text.split('(내경)')[0], 'X0. Z0.\nX40.\nZ-30.\n');
  });
});

describe('DXF 파일 끝 처리', () => {
  it('EOF 뒤에 남은 찌꺼기(덮어쓰기로 남은 옛 내용)는 무시한다', () => {
    const src = dxf([...chain(TOP, 100), line(65, 109, 64, 110), line(65, 91, 64, 90), line(65, 91, 65, 109), line(0, 72.5, 0, 127.5)]) + '\r\n302821302821\r\n310\r\n3028213028\r\n  0\r\nENDSEC\r\n';
    sameProfile(dxfToTarget(src).text, WANT);
  });

  it('읽을 수 없는 줄은 몇 번째 줄인지 알려 준다', () => {
    const src = dxf(chain(TOP, 100)).replace('ENTITIES', 'ENTITIES\r\nGARBAGE');
    expect(() => dxfToTarget(src)).toThrow(/번째 줄을 읽을 수 없습니다/);
  });
});

describe('DXF 암나사 찾기', () => {
  it('구멍 지름이 안지름이고 M20x1.5 글자가 있으면 내경 나사', () => {
    const ax = 50;
    const half = (s: number): Ent[] => [
      ...chain([[30, ax + s * 9.188], [30, ax + s * 20], [0, ax + s * 20], [0, ax + s * 9.188], [30, ax + s * 9.188]] as [number, number][]),
      // 바깥지름 가는 선 (나사 길이 15)
      line(30, ax + s * 10, 15, ax + s * 10, 'THIN'),
    ];
    const ents: Ent[] = [...half(1), ...half(-1), line(-5, ax, 40, ax, 'CENTER'), ['DIMENSION', [[8, 'DIM'], [1, 'M20x1.5'], [11, 20], [21, ax + 5]]]];
    const r = dxfToTarget(dxf(ents, [['CENTER', 'CENTER']]));
    expect(r.text).toContain('(내경)');
    expect(r.text).toContain('(나사 M20x1.5 Z0. ~ Z-15. 내경)');
  });
});

describe('DXF 숨은선 단차 구멍', () => {
  it('단차·모따기 모서리가 축을 가로지르는 세로선이어도 구멍 벽을 따라간다', () => {
    const ax = 50;
    const H = 'HID';
    const hid = (x1: number, y1: number, x2: number, y2: number) => line(x1, y1, x2, y2, H);
    // Ø60 x 40 (끝면 x=40), 구멍: 입구 C1 → Ø30 깊이 10 → Ø20 관통. 단차 모서리 세로선이 축을 가로지름
    const ents: Ent[] = [
      ...chain([[40, ax - 30], [40, ax + 30], [0, ax + 30], [0, ax - 30], [40, ax - 30]] as [number, number][]),
      ...[1, -1].flatMap((s) => [hid(40, ax + s * 16, 39, ax + s * 15), hid(39, ax + s * 15, 30, ax + s * 15), hid(30, ax + s * 10, 0, ax + s * 10)]),
      hid(39, ax - 15, 39, ax + 15),
      hid(30, ax - 15, 30, ax + 15),
      line(-5, ax, 45, ax, 'CENTER'),
    ];
    const r = dxfToTarget(dxf(ents, [['CENTER', 'CENTER'], [H, 'HIDDEN']]));
    const inner = r.text.split('(내경)')[1].trim().split('\n');
    expect(inner).toEqual(['X32. Z0.', 'G01 X30. Z-1.', 'G01 X30. Z-10.', 'G01 X20. Z-10.', 'G01 X20. Z-40.']);
  });
});
