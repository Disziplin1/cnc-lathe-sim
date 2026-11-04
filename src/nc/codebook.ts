/**
 * G코드 · M코드 · 어드레스 사전 (Fanuc 0i-TF 선반, G코드 체계 A 기준).
 * 편집기 마우스 설명과 "코드 사전" 탭이 같이 쓴다.
 */

export type CodeKind = 'G' | 'M' | 'addr';
export type Support = 'yes' | 'partial' | 'no';

export interface CodeInfo {
  code: string;
  kind: CodeKind;
  name: string;
  desc: string;
  /** 지령 형식 (두 블록 사이클은 두 줄) */
  format?: string[];
  /** 편집기에 넣을 예시 */
  example?: string;
  /** 모달(다음 블록까지 유지) 여부 */
  modal?: boolean;
  /** 이 블록에서 쓰는 어드레스의 뜻 */
  params?: Record<string, string>;
  /** 두 블록 사이클의 첫 블록 어드레스 뜻 */
  params1?: Record<string, string>;
  support: Support;
  /** 이 시뮬레이터에서의 차이 */
  note?: string;
}

export const SUPPORT_LABEL: Record<Support, string> = { yes: '지원', partial: '일부 지원', no: '미지원' };

const AXIS = {
  X: 'X 끝점 (직경값, 절대)',
  Z: 'Z 끝점 (절대)',
  U: 'X 이동량 (직경값, 증분)',
  W: 'Z 이동량 (증분)',
};
const CONTOUR_2ND = {
  P: '형상 첫 블록의 N번호 (ns)',
  Q: '형상 마지막 블록의 N번호 (nf)',
  U: 'X 방향 정삭 여유 Δu (직경값, 내경은 −)',
  W: 'Z 방향 정삭 여유 Δw',
  F: '황삭 이송속도 (P~Q 블록 안의 F 는 황삭에서 무시)',
};

export const G_CODES: CodeInfo[] = [
  {
    code: 'G00', kind: 'G', name: '급속 위치결정', modal: true, support: 'yes',
    desc: '공구를 최대 속도(급속)로 지령 위치까지 옮깁니다. 절삭하지 않는 이동에만 씁니다. 축마다 따로 움직여서 경로가 꺾일 수 있으므로 공작물·척 근처에서는 경로를 확인하세요.',
    format: ['G00 X(U)__ Z(W)__ ;'], example: 'G00 X52. Z2. ;', params: AXIS,
  },
  {
    code: 'G01', kind: 'G', name: '직선 보간 (직선 절삭)', modal: true, support: 'yes',
    desc: 'F 로 지정한 이송속도로 직선을 따라 깎습니다. 외경, 단면, 테이퍼, 모따기 모두 G01 입니다.',
    format: ['G01 X(U)__ Z(W)__ F__ ;'], example: 'G01 Z-30. F0.2 ;',
    params: { ...AXIS, F: '이송속도 (G99: mm/rev, G98: mm/min)' },
  },
  {
    code: 'G02', kind: 'G', name: '원호 보간 (시계 방향 CW)', modal: true, support: 'yes',
    desc: '시계 방향 원호로 깎습니다. 화면처럼 X 위, Z 오른쪽으로 볼 때(후면 공구대) 시계 방향입니다. 외경 가공에서 오목한 R(필릿)이 보통 G02 입니다.',
    format: ['G02 X(U)__ Z(W)__ R__ F__ ;', 'G02 X(U)__ Z(W)__ I__ K__ F__ ;'], example: 'G02 X34. Z-42. R2. ;',
    params: {
      ...AXIS,
      R: '원호 반지름 (180° 보다 큰 원호는 −)',
      I: '시작점에서 원호 중심까지 X 거리 (반경값, 증분)',
      K: '시작점에서 원호 중심까지 Z 거리 (증분)',
      F: '이송속도',
    },
  },
  {
    code: 'G03', kind: 'G', name: '원호 보간 (반시계 방향 CCW)', modal: true, support: 'yes',
    desc: '반시계 방향 원호로 깎습니다. 외경 가공에서 볼록한 모서리 R 이 보통 G03 입니다.',
    format: ['G03 X(U)__ Z(W)__ R__ F__ ;', 'G03 X(U)__ Z(W)__ I__ K__ F__ ;'], example: 'G03 X46. Z-44. R2. ;',
    params: {
      ...AXIS,
      R: '원호 반지름 (180° 보다 큰 원호는 −)',
      I: '시작점에서 원호 중심까지 X 거리 (반경값, 증분)',
      K: '시작점에서 원호 중심까지 Z 거리 (증분)',
      F: '이송속도',
    },
  },
  {
    code: 'G04', kind: 'G', name: '드웰 (일시 정지)', support: 'yes',
    desc: '지정한 시간 동안 이송을 멈춥니다. 홈 바닥을 깨끗하게 하거나 칩을 끊을 때 씁니다. 주축은 계속 돕니다.',
    format: ['G04 P__ ;  (ms)', 'G04 X__ ;  (초)'], example: 'G04 P1000 ;',
    params: { P: '정지 시간 ms (P1000 = 1초, 소수점 쓰지 않음)', X: '정지 시간 (초)', U: '정지 시간 (초)' },
  },
  {
    code: 'G10', kind: 'G', name: '데이터 설정 (보정값 등 입력)', support: 'no',
    desc: '프로그램에서 공구 보정값 등을 입력합니다.',
  },
  {
    code: 'G18', kind: 'G', name: 'ZX 평면 선택', modal: true, support: 'yes',
    desc: '선반은 ZX 평면이 기본이라 보통 쓰지 않아도 됩니다.',
  },
  {
    code: 'G20', kind: 'G', name: '인치 입력', modal: true, support: 'no',
    desc: '좌표를 인치로 입력합니다. 이 시뮬레이터는 mm(G21)만 지원합니다.',
  },
  {
    code: 'G21', kind: 'G', name: 'mm 입력', modal: true, support: 'yes',
    desc: '좌표를 mm 로 입력합니다 (기본).',
  },
  {
    code: 'G27', kind: 'G', name: '원점 복귀 확인', support: 'no',
    desc: '지령한 위치가 기계 원점인지 확인합니다.',
  },
  {
    code: 'G28', kind: 'G', name: '자동 원점 복귀', support: 'yes',
    desc: '지령한 중간점을 거쳐 기계 원점으로 급속 이동합니다. 지정한 축만 돌아갑니다. 보통 U0. W0. 로 "지금 위치를 중간점으로" 해서 바로 복귀합니다. 공구 교환 전에 많이 씁니다.',
    format: ['G28 U0. W0. ;'], example: 'G28 U0. W0. ;',
    params: { X: '중간점 X (직경, 절대)', Z: '중간점 Z (절대)', U: '중간점까지 X 이동량 (U0. = 그 자리)', W: '중간점까지 Z 이동량 (W0. = 그 자리)' },
  },
  {
    code: 'G30', kind: 'G', name: '제2 원점 복귀', support: 'no',
    desc: '기계에 따로 정한 제2 원점(공구 교환 위치 등)으로 복귀합니다.',
  },
  {
    code: 'G32', kind: 'G', name: '나사 절삭 (1회)', modal: true, support: 'yes',
    desc: '주축 회전에 맞춰 리드만큼 이송하며 나사를 한 번 깎습니다. 진입·후퇴는 G00 으로 직접 써야 합니다. 회전수는 G97 로 고정합니다.',
    format: ['G32 X(U)__ Z(W)__ F(리드) ;'], example: 'G32 Z-20. F1.5 ;',
    params: { ...AXIS, F: '나사 리드 (mm, 1줄 나사는 피치)' },
  },
  {
    code: 'G40', kind: 'G', name: '인선R보정 취소', modal: true, support: 'yes',
    desc: 'G41/G42 보정을 끝냅니다. 보정을 끝내는 블록은 G00 또는 G01 로 공작물에서 떨어지는 이동이 좋습니다.',
    example: 'G40 G00 X100. Z50. ;',
  },
  {
    code: 'G41', kind: 'G', name: '인선R보정 왼쪽', modal: true, support: 'yes',
    desc: '진행 방향의 왼쪽으로 노즈 반경만큼 보정합니다. 후면 공구대에서 내경(보링) 가공에 씁니다. 공구 보정 화면의 R(노즈 반경)과 T(가상 인선 번호, 내경 = 2)가 필요합니다.',
    format: ['G41 G00(G01) X__ Z__ ;'], example: 'G41 G00 X19. Z2. ;',
  },
  {
    code: 'G42', kind: 'G', name: '인선R보정 오른쪽', modal: true, support: 'yes',
    desc: '진행 방향의 오른쪽으로 노즈 반경만큼 보정합니다. 후면 공구대에서 외경 가공에 씁니다. 보정하지 않으면 테이퍼·R 에 살이 남거나 더 깎입니다. 공구 보정 화면의 R 과 T(외경 = 3)가 필요합니다.',
    format: ['G42 G00(G01) X__ Z__ ;'], example: 'G42 G00 X52. Z2. ;',
  },
  {
    code: 'G50', kind: 'G', name: '주축 최고 회전수 / 좌표계 설정', support: 'yes',
    desc: 'S 를 쓰면 주축 최고 회전수를 제한합니다 (G96 에서 지름이 작아질 때 회전수가 너무 올라가는 것을 막음). X Z 를 쓰면 지금 공구 위치를 그 좌표로 정합니다 (요즘은 G54 를 주로 씀).',
    format: ['G50 S__ ;', 'G50 X__ Z__ ;'], example: 'G50 S2000 ;',
    params: { S: '주축 최고 회전수 rpm (G96 일 때 적용)', X: '지금 위치를 이 X 좌표로 정함', Z: '지금 위치를 이 Z 좌표로 정함' },
  },
  {
    code: 'G54', kind: 'G', name: '공작물 좌표계 1', modal: true, support: 'partial',
    desc: '공작물 좌표계 1번을 씁니다 (기본). G55~G59 는 이 시뮬레이터에서 지원하지 않습니다.',
  },
  {
    code: 'G65', kind: 'G', name: '매크로 호출', support: 'no',
    desc: '사용자 매크로 프로그램을 호출합니다.',
  },
  {
    code: 'G70', kind: 'G', name: '정삭 사이클', support: 'yes',
    desc: 'G71·G72·G73 으로 황삭한 뒤 P~Q 블록 형상을 그대로 한 번 따라가 정삭합니다. P~Q 블록 안의 F·S 를 씁니다. 끝나면 사이클 시작점으로 돌아옵니다.',
    format: ['G70 P(ns) Q(nf) ;'], example: 'G70 P10 Q20 ;',
    params: { P: '정삭할 형상 첫 블록의 N번호', Q: '정삭할 형상 마지막 블록의 N번호' },
  },
  {
    code: 'G71', kind: 'G', name: '내·외경 황삭 사이클', support: 'partial',
    desc: '완성 형상(P~Q 블록)을 한 번만 쓰면, 절입량씩 여러 번 나눠 깎고 정삭 여유를 남깁니다. 끝나면 Q 블록 다음 줄로 넘어갑니다. 형상은 한 방향으로만 커지거나 작아져야 합니다 (Type I).',
    format: ['G71 U(Δd) R(e) ;', 'G71 P(ns) Q(nf) U(Δu) W(Δw) F__ ;'],
    example: 'G71 U1.5 R0.5 ;\nG71 P10 Q20 U0.4 W0.1 F0.25 ;',
    params1: { U: '1회 절입량 Δd (반경값)', R: '도피량 e (깎은 뒤 45° 로 빠지는 양)' },
    params: CONTOUR_2ND,
    note: 'Type I(단조 형상)만 지원. 오목한 형상(Type II)은 알람 PS0064.',
  },
  {
    code: 'G72', kind: 'G', name: '단면 황삭 사이클', support: 'partial',
    desc: 'G71 과 같지만 Z 방향으로 절입하며 X 방향(단면)으로 깎습니다. 지름 차이가 크고 길이가 짧은 형상에 씁니다. P 블록은 Z 만 지령합니다.',
    format: ['G72 W(Δd) R(e) ;', 'G72 P(ns) Q(nf) U(Δu) W(Δw) F__ ;'],
    example: 'G72 W1.5 R0.5 ;\nG72 P10 Q20 U0.4 W0.1 F0.2 ;',
    params1: { W: '1회 절입량 Δd (Z 방향)', R: '도피량 e' },
    params: CONTOUR_2ND,
    note: 'Type I(단조 형상)만 지원.',
  },
  {
    code: 'G73', kind: 'G', name: '형상 반복 사이클', support: 'yes',
    desc: '같은 형상을 조금씩 안쪽으로 옮기며 여러 번 따라 깎습니다. 주조·단조품처럼 이미 형상과 비슷한 소재에 씁니다.',
    format: ['G73 U(Δi) W(Δk) R(d) ;', 'G73 P(ns) Q(nf) U(Δu) W(Δw) F__ ;'],
    example: 'G73 U3. W0. R3 ;\nG73 P10 Q20 U0.4 W0.1 F0.2 ;',
    params1: { U: 'X 방향 총 도피량 Δi (반경값)', W: 'Z 방향 총 도피량 Δk', R: '반복(분할) 횟수 d' },
    params: CONTOUR_2ND,
  },
  {
    code: 'G74', kind: 'G', name: '단면 홈 · 드릴 펙 사이클', support: 'yes',
    desc: 'Z 방향으로 조금씩 쪼아 들어가며(펙) 칩을 끊습니다. X 를 생략하면 지금 X 위치(X0)에서 드릴 가공이 됩니다.',
    format: ['G74 R(e) ;', 'G74 X(U)__ Z(W)__ P(Δi) Q(Δk) F__ ;'],
    example: 'G74 R1. ;\nG74 Z-40. Q8000 F0.1 ;',
    params1: { R: '칩을 끊기 위해 뒤로 빠지는 양 e' },
    params: {
      X: '마지막 X 위치 (드릴은 생략)',
      Z: '가공 깊이 (절대)',
      U: 'X 이동량', W: 'Z 깊이 (증분)',
      P: 'X 방향 이동량 Δi (µm, 반경값, 소수점 없음)',
      Q: '1회 절입 깊이 Δk (µm, Q5000 = 5mm)',
      F: '이송속도',
    },
  },
  {
    code: 'G75', kind: 'G', name: '외경 홈 펙 사이클', support: 'yes',
    desc: 'X 방향으로 조금씩 쪼아 들어가며 홈을 팝니다. 홈이 바이트 폭보다 넓으면 Q 만큼 옆으로 옮겨가며 반복합니다.',
    format: ['G75 R(e) ;', 'G75 X(U)__ Z(W)__ P(Δi) Q(Δk) F__ ;'],
    example: 'G75 R0.5 ;\nG75 X16. Z-22. P1000 Q1000 F0.07 ;',
    params1: { R: '칩을 끊기 위해 뒤로 빠지는 양 e' },
    params: {
      X: '홈 바닥 지름', Z: '마지막 홈 위치 Z',
      U: 'X 깊이 (증분)', W: 'Z 이동 (증분)',
      P: '1회 절입량 Δi (µm, 반경값, P1000 = 1mm)',
      Q: 'Z 방향 이동량 Δk (µm)',
      F: '이송속도',
    },
  },
  {
    code: 'G76', kind: 'G', name: '복합형 나사 절삭 사이클', support: 'partial',
    desc: '나사 깊이를 여러 번에 나눠 자동으로 깎습니다. 절입량은 √n 비율로 점점 줄어듭니다.',
    format: ['G76 P(m)(r)(a) Q(Δdmin) R(d) ;', 'G76 X(U)__ Z(W)__ R(i) P(k) Q(Δd) F(L) ;'],
    example: 'G76 P020060 Q50 R0.05 ;\nG76 X18.16 Z-19.5 P920 Q350 F1.5 ;',
    params1: {
      P: '6자리 m rr aa: 정삭 반복 횟수, 나사 끝 모따기(리드×0.1), 공구 각도 (예 P020060)',
      Q: '최소 절입량 Δdmin (µm)',
      R: '정삭 여유 d (mm)',
    },
    params: {
      X: '나사 골지름 (바닥)', Z: '나사 끝 Z',
      U: 'X 증분', W: 'Z 증분',
      R: '테이퍼량 i (반경값, 평행 나사는 0)',
      P: '나사산 높이 k (µm, 반경값, P920 = 0.92mm)',
      Q: '첫 절입량 Δd (µm, 반경값)',
      F: '나사 리드 L',
    },
    note: '공구 각도에 따른 측면 절입·나사 끝 모따기는 생략하고 직각으로 절입합니다.',
  },
  {
    code: 'G80', kind: 'G', name: '드릴 고정 사이클 취소', modal: true, support: 'yes',
    desc: 'G83~G89 드릴 사이클과 G84 탭 사이클을 취소합니다.',
  },
  {
    code: 'G83', kind: 'G', name: '정면 드릴 사이클 (C축)', modal: true, support: 'no',
    desc: '회전 공구(밀링 축)가 있는 선반에서 정면 드릴링을 합니다. G85 보링 등도 같은 계열입니다.',
  },
  {
    code: 'G84', kind: 'G', name: '정면 탭 사이클', modal: true, support: 'partial',
    desc: '중심(X0.)에서 탭으로 암나사를 냅니다. 회전당 피치만큼 들어가고, 바닥에서 주축을 거꾸로 돌려 같은 피치로 빠져나옵니다. 탭 드릴로 밑구멍을 먼저 뚫어야 합니다 (M6 → Ø5).',
    format: ['G84 Z(W)__ R__ P__ F(피치) ;', 'G80 ;'],
    example: 'T1000 ;\nG97 S300 M03 ;\nG00 X0. Z5. T1010 ;\nG84 Z-10. R-3. F1. ;\nG80 ;',
    params: {
      Z: '탭 깊이', W: 'Z 증분',
      R: '시작점에서 R 점(탭이 들어가기 시작하는 곳)까지 Z 거리. 없으면 시작점이 R 점',
      P: '바닥에서 멈추는 시간 (ms)',
      F: '피치 (회전당 이송, M6 → F1.)',
    },
    note: '탭은 중심(X0.)에서만 씁니다. 실제 기계는 리지드 탭이면 M29 S__ 를 앞에 쓰는데, 연습기에서는 M29 를 받아들이기만 합니다.',
  },
  {
    code: 'G90', kind: 'G', name: '내·외경 절삭 사이클 (단일형)', modal: true, support: 'yes',
    desc: 'X 급속 진입 → Z 절삭 → X 절삭 복귀 → Z 급속 복귀의 4동작을 한 줄로 합니다. 다음 줄부터 X 만 바꿔 쓰면 같은 동작을 반복합니다.',
    format: ['G90 X(U)__ Z(W)__ R__ F__ ;'], example: 'G90 X46. Z-30. F0.25 ;',
    params: { ...AXIS, R: '테이퍼량 (반경값, 절삭 시작점 − 끝점)', F: '이송속도' },
  },
  {
    code: 'G92', kind: 'G', name: '나사 절삭 사이클 (단일형)', modal: true, support: 'yes',
    desc: 'X 급속 진입 → 나사 절삭 → X 급속 후퇴 → Z 급속 복귀를 한 줄로 합니다. 다음 줄부터 X 만 바꿔 깊이를 늘려가며 씁니다.',
    format: ['G92 X(U)__ Z(W)__ R__ F(리드) ;'], example: 'G92 X19.3 Z-20. F1.5 ;',
    params: { ...AXIS, R: '테이퍼량 (반경값)', F: '나사 리드' },
  },
  {
    code: 'G94', kind: 'G', name: '단면 절삭 사이클 (단일형)', modal: true, support: 'yes',
    desc: 'Z 급속 진입 → X 절삭 → Z 절삭 복귀 → X 급속 복귀의 4동작을 한 줄로 합니다. 끝면을 여러 번 깎을 때 씁니다.',
    format: ['G94 X(U)__ Z(W)__ R__ F__ ;'], example: 'G94 X20. Z-2. F0.2 ;',
    params: { ...AXIS, R: '테이퍼량 (Z 방향)', F: '이송속도' },
  },
  {
    code: 'G96', kind: 'G', name: '주속 일정 제어', modal: true, support: 'yes',
    desc: 'S 를 절삭속도(m/min)로 보고, 지름이 작아지면 회전수를 올려 절삭속도를 일정하게 유지합니다. 회전수 = 1000×S ÷ (π×지름). 반드시 G50 S 로 최고 회전수를 제한하세요.',
    format: ['G96 S(m/min) M03 ;'], example: 'G96 S150 M03 ;',
    params: { S: '절삭속도 m/min' },
  },
  {
    code: 'G97', kind: 'G', name: '주속 일정 취소 (회전수 일정)', modal: true, support: 'yes',
    desc: 'S 를 회전수(rpm)로 봅니다. 나사 절삭·드릴·홈 가공처럼 회전수가 일정해야 할 때 씁니다.',
    format: ['G97 S(rpm) M03 ;'], example: 'G97 S600 M03 ;',
    params: { S: '주축 회전수 rpm' },
  },
  {
    code: 'G98', kind: 'G', name: '분당 이송 (mm/min)', modal: true, support: 'yes',
    desc: 'F 를 1분에 움직이는 거리(mm/min)로 봅니다. 주축이 멈춰 있어도 이송됩니다.',
    example: 'G98 G01 Z-10. F100. ;',
  },
  {
    code: 'G99', kind: 'G', name: '회전당 이송 (mm/rev)', modal: true, support: 'yes',
    desc: 'F 를 주축 1회전에 움직이는 거리(mm/rev)로 봅니다. 선반의 기본입니다. 주축이 멈춰 있으면 이송되지 않습니다.',
    example: 'G99 G01 Z-10. F0.2 ;',
  },
];

export const M_CODES: CodeInfo[] = [
  { code: 'M00', kind: 'M', name: '프로그램 정지', support: 'yes', desc: '프로그램을 멈춥니다. 사이클 스타트를 누르면 다음 블록부터 계속합니다. 치수 측정·칩 제거에 씁니다.', example: 'M00 ;' },
  { code: 'M01', kind: 'M', name: '선택 정지', support: 'yes', desc: '조작반의 "M01 선택정지" 스위치가 켜져 있을 때만 멈춥니다. 꺼져 있으면 그냥 지나갑니다.', example: 'M01 ;' },
  { code: 'M02', kind: 'M', name: '프로그램 끝', support: 'yes', desc: '프로그램을 끝냅니다. 주축·절삭유도 멈춥니다.', example: 'M02 ;' },
  { code: 'M03', kind: 'M', name: '주축 정회전', support: 'yes', desc: '주축을 정방향으로 돌립니다. 보통 S 와 같이 씁니다.', example: 'G97 S1000 M03 ;' },
  { code: 'M04', kind: 'M', name: '주축 역회전', support: 'yes', desc: '주축을 반대 방향으로 돌립니다. 공구를 뒤집어 단 경우 등에 씁니다.', example: 'M04 ;' },
  { code: 'M05', kind: 'M', name: '주축 정지', support: 'yes', desc: '주축을 멈춥니다. 공구 교환·프로그램 끝 전에 씁니다. 주축이 멈춘 상태에서 G99 절삭을 하면 알람입니다.', example: 'M05 ;' },
  { code: 'M08', kind: 'M', name: '절삭유 ON', support: 'yes', desc: '절삭유를 켭니다.', example: 'M08 ;' },
  { code: 'M09', kind: 'M', name: '절삭유 OFF', support: 'yes', desc: '절삭유를 끕니다.', example: 'M09 ;' },
  { code: 'M19', kind: 'M', name: '주축 정위치 정지', support: 'no', desc: '주축을 정해진 각도에 세웁니다 (오리엔테이션).' },
  { code: 'M30', kind: 'M', name: '프로그램 끝 · 처음으로', support: 'yes', desc: '프로그램을 끝내고 처음으로 되돌아갑니다. 실제 기계에서 가장 많이 쓰는 끝 코드입니다.', example: 'M30 ;' },
  { code: 'M98', kind: 'M', name: '보조 프로그램 호출', support: 'no', desc: 'P 로 지정한 보조 프로그램(서브 프로그램)을 실행합니다.', format: ['M98 P____ ;'] },
  { code: 'M99', kind: 'M', name: '보조 프로그램 끝', support: 'no', desc: '보조 프로그램을 끝내고 호출한 곳으로 돌아갑니다.' },
];

export const ADDRESSES: CodeInfo[] = [
  { code: 'O', kind: 'addr', name: '프로그램 번호', support: 'yes', desc: '프로그램 이름입니다. O 다음 4자리 (O0001 ~ O9999).', example: 'O0001 ;' },
  { code: 'N', kind: 'addr', name: '시퀀스(블록) 번호', support: 'yes', desc: '블록에 붙이는 번호. G70~G73 의 P, Q 가 이 번호로 형상 블록을 찾습니다.' },
  { code: 'G', kind: 'addr', name: '준비 기능', support: 'yes', desc: '어떤 동작을 할지 정합니다 (이동 방법, 사이클, 보정 등).' },
  { code: 'M', kind: 'addr', name: '보조 기능', support: 'yes', desc: '주축·절삭유·프로그램 정지 같은 기계 동작을 켜고 끕니다.' },
  { code: 'X', kind: 'addr', name: 'X 좌표 (직경)', support: 'yes', desc: 'X 축 절대 좌표. 선반은 직경값으로 씁니다 (X30. = 지름 30mm, 중심에서 15mm). 소수점을 꼭 붙이세요.' },
  { code: 'Z', kind: 'addr', name: 'Z 좌표', support: 'yes', desc: 'Z 축 절대 좌표. 보통 끝면이 Z0, 척 쪽이 − 입니다.' },
  { code: 'U', kind: 'addr', name: 'X 증분', support: 'yes', desc: '지금 위치에서 X 로 얼마나 움직일지 (직경값). U2. = 지름이 2mm 커짐.' },
  { code: 'W', kind: 'addr', name: 'Z 증분', support: 'yes', desc: '지금 위치에서 Z 로 얼마나 움직일지.' },
  { code: 'R', kind: 'addr', name: '반지름 · 테이퍼 · 도피량', support: 'yes', desc: '원호에서는 반지름, G90·G92·G94 에서는 테이퍼량, G71·G74·G75 첫 블록에서는 도피(후퇴)량입니다.' },
  { code: 'I', kind: 'addr', name: '원호 중심 X', support: 'yes', desc: '원호 시작점에서 중심까지 X 거리 (반경값, 증분).' },
  { code: 'K', kind: 'addr', name: '원호 중심 Z', support: 'yes', desc: '원호 시작점에서 중심까지 Z 거리 (증분).' },
  { code: 'F', kind: 'addr', name: '이송속도 · 리드', support: 'yes', desc: 'G99: 1회전당 mm (F0.2), G98: 분당 mm (F100.). 나사(G32·G92·G76)에서는 리드.' },
  { code: 'S', kind: 'addr', name: '주축 기능', support: 'yes', desc: 'G97: 회전수 rpm, G96: 절삭속도 m/min, G50: 최고 회전수.' },
  { code: 'T', kind: 'addr', name: '공구 기능', support: 'yes', desc: 'T□□△△ : 앞 2자리 공구 번호, 뒤 2자리 보정 번호. T0303 = 3번 공구, 3번 보정. T0300 = 보정 취소.', example: 'T0303 ;' },
  { code: 'P', kind: 'addr', name: '시간 · 번호 · 이동량', support: 'yes', desc: 'G04: 정지 시간(ms), G70~G73: 시작 N번호, G74·G75·G76: µm 단위 값. 정수로 씁니다.' },
  { code: 'Q', kind: 'addr', name: '끝 번호 · 절입량', support: 'yes', desc: 'G70~G73: 끝 N번호, G74·G75·G76: µm 단위 절입량·이동량. 정수로 씁니다.' },
  { code: ';', kind: 'addr', name: 'EOB (블록 끝)', support: 'yes', desc: '한 블록(한 줄)의 끝을 표시합니다.' },
  { code: '/', kind: 'addr', name: '옵셔널 블록 스킵', support: 'yes', desc: '블록 맨 앞에 쓰면, 조작반의 블록스킵이 켜져 있을 때 그 블록을 건너뜁니다.' },
  { code: '( )', kind: 'addr', name: '주석', support: 'yes', desc: '괄호 안은 기계가 무시합니다. 괄호 안에 괄호를 또 쓰면 안 됩니다.' },
];

export const ALL_CODES: CodeInfo[] = [...G_CODES, ...M_CODES, ...ADDRESSES];

/** G1 → G01, m3 → M03, G50.3 그대로 */
export function normalizeCode(letter: string, value: string): string {
  const L = letter.toUpperCase();
  const v = parseFloat(value);
  if (!Number.isFinite(v)) return L;
  const i = Math.trunc(v);
  const frac = value.includes('.') ? value.split('.')[1].replace(/0+$/, '') : '';
  return L + String(i).padStart(2, '0') + (frac ? '.' + frac : '');
}

export function findCode(code: string): CodeInfo | undefined {
  return ALL_CODES.find((c) => c.code === code);
}

const CYCLE_FIRST_BLOCK: Record<string, (letters: Set<string>) => boolean> = {
  G71: (l) => !l.has('P'),
  G72: (l) => !l.has('P'),
  G73: (l) => !l.has('P'),
  G74: (l) => !['X', 'Z', 'U', 'W'].some((a) => l.has(a)),
  G75: (l) => !['X', 'Z', 'U', 'W'].some((a) => l.has(a)),
  G76: (l) => !['X', 'Z', 'U', 'W'].some((a) => l.has(a)),
};

export interface WordExplain {
  title: string;
  info?: CodeInfo;
  /** 이 블록 안에서의 뜻 */
  context?: string;
  /** 값 풀이 (예: X30. → 지름 30) */
  value?: string;
}

/** 블록 안의 한 단어(G01, X30., P1000 …) 설명 */
export function explainWord(letter: string, value: string, blockText: string): WordExplain {
  const L = letter.toUpperCase();
  const clean = blockText.toUpperCase().replace(/\([^)]*\)?/g, ' ');
  const words = [...clean.matchAll(/([A-Z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g)];
  const letters = new Set(words.map((m) => m[1]));
  const gs = words.filter((m) => m[1] === 'G').map((m) => normalizeCode('G', m[2]));

  if (L === 'G' || L === 'M') {
    const code = normalizeCode(L, value);
    const info = findCode(code);
    return { title: code, info };
  }

  const info = findCode(L);
  const v = parseFloat(value);
  let context: string | undefined;
  for (const g of gs) {
    const gi = findCode(g);
    if (!gi) continue;
    const first = CYCLE_FIRST_BLOCK[g]?.(letters) ?? false;
    const table = first ? gi.params1 : gi.params;
    if (table?.[L]) {
      context = `${g}${first ? ' 첫 블록' : ''} 에서: ${table[L]}`;
      break;
    }
  }

  let valueText: string | undefined;
  // 복합 사이클의 U·W·R 은 이동량이 아니라 절입량·여유·도피량이라 일반 풀이를 붙이지 않는다
  const cycleParam = context && 'UWR'.includes(L) && gs.some((g) => /^G7[0-6]$/.test(g));
  if (Number.isFinite(v) && !cycleParam) {
    const micro = gs.some((g) => ['G74', 'G75', 'G76'].includes(g)) && (L === 'P' || L === 'Q') && !value.includes('.');
    if (L === 'X') valueText = `지름 ${v} mm (중심에서 ${+(v / 2).toFixed(4)} mm)`;
    else if (L === 'U') valueText = `지름이 ${Math.abs(v)} mm ${v >= 0 ? '커지는' : '작아지는'} 쪽으로 (반경 ${+(v / 2).toFixed(4)} mm)`;
    else if (L === 'T' && /^\d{3,4}$/.test(value)) {
      const n = Math.round(v);
      const off = n % 100;
      valueText = `${Math.floor(n / 100)}번 공구, ${off === 0 ? '보정 취소' : off + '번 보정'}`;
    } else if (L === 'P' && gs.includes('G04')) valueText = `${v / 1000} 초`;
    else if (L === 'P' && gs.includes('G76') && CYCLE_FIRST_BLOCK.G76(letters)) {
      const s = value.padStart(6, '0');
      valueText = `정삭 ${+s.slice(0, 2)}회, 모따기 ${+s.slice(2, 4) / 10}×리드, 공구각 ${+s.slice(4, 6)}°`;
    } else if (micro) valueText = `${v / 1000} mm`;
    else if (L === 'F') valueText = gs.some((g) => ['G32', 'G92', 'G76'].includes(g)) ? `리드 ${v} mm` : undefined;
    else if (L === 'S') {
      if (gs.includes('G50')) valueText = `최고 ${v} rpm`;
      else if (gs.includes('G96')) valueText = `절삭속도 ${v} m/min`;
      else if (gs.includes('G97')) valueText = `${v} rpm`;
    }
  }
  return { title: L + value, info, context, value: valueText };
}

const KIND_ORDER: Record<CodeKind, number> = { G: 0, M: 1, addr: 2 };
const ADDR_ORDER = ADDRESSES.map((a) => a.code);

/** 사전 순서: G코드 번호순 → M코드 번호순 → 어드레스 */
export function codeOrder(a: CodeInfo, b: CodeInfo): number {
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (a.kind === 'addr') return ADDR_ORDER.indexOf(a.code) - ADDR_ORDER.indexOf(b.code);
  return parseFloat(a.code.slice(1)) - parseFloat(b.code.slice(1));
}

/** 사전 검색: "g1" "원호" "나사" "M3" 모두 찾는다. 결과는 코드 번호 순서 (정확히 같은 코드만 맨 앞) */
export function searchCodes(query: string, kind: CodeKind | 'all' = 'all'): CodeInfo[] {
  const list = (kind === 'all' ? ALL_CODES : ALL_CODES.filter((c) => c.kind === kind)).slice().sort(codeOrder);
  const q = query.trim().toUpperCase();
  if (!q) return list;
  const m = /^([GM])\s*(\d+(?:\.\d+)?)$/.exec(q);
  const exact = m ? normalizeCode(m[1], m[2]) : null;
  const words = q.split(/\s+/);
  return list
    .map((c) => {
      const hay = [c.code, c.name, c.desc, ...(c.format ?? []), c.example ?? '', c.note ?? '', ...Object.values(c.params ?? {}), ...Object.values(c.params1 ?? {})]
        .join(' ')
        .toUpperCase();
      let score = 0;
      if (exact && c.code === exact) score = 100;
      else if (c.code === q) score = 90;
      else if (c.code.startsWith(q)) score = 50;
      else if (words.every((w) => hay.includes(w))) score = c.name.toUpperCase().includes(q) ? 20 : 10;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => Number(b.score >= 90) - Number(a.score >= 90) || codeOrder(a.c, b.c))
    .map((x) => x.c);
}
