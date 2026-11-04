import type { Vec } from '../nc/types';

export type ToolType = 'rough' | 'finish' | 'groove' | 'thread' | 'drill' | 'boring' | 'knurl' | 'ithread' | 'igroove' | 'tap';

export interface ToolDef {
  no: number;
  type: ToolType;
  /** 홈 바이트 폭 / 드릴 직경 / 널링 롤러 폭 (mm) */
  width: number;
  /** 인서트 노즈 반경 (mm) — 실제 공구의 모양 */
  noseR: number;
}

/** 공구 보정 화면의 한 줄 (보정번호 1번 = 배열 0번) */
export interface ToolOffset {
  /** X 보정 (직경값) */
  X: number;
  Z: number;
  /** 컨트롤러가 인선R보정에 쓰는 노즈 반경 */
  R: number;
  /** 가상 인선 번호 (0~9) */
  T: number;
}

export const TOOL_LABEL: Record<ToolType, string> = {
  rough: '외경 황삭 (80° 마름모)',
  finish: '외경 정삭 (55° 마름모)',
  groove: '홈 바이트',
  thread: '나사 바이트 (60°)',
  drill: '드릴',
  boring: '보링바 (내경, 55°)',
  knurl: '널링 (롤러)',
  ithread: '내경 나사 바이트 (60°)',
  igroove: '내경 홈 바이트',
  tap: '탭 (암나사)',
};

export const TOOL_COLOR: Record<ToolType, string> = {
  rough: '#4aa3ff',
  finish: '#3ddc97',
  groove: '#ffb547',
  thread: '#c387ff',
  drill: '#ff7aa8',
  boring: '#5ee6e6',
  knurl: '#e8c547',
  ithread: '#a98bff',
  igroove: '#ffd27a',
  tap: '#ff9f6b',
};

/** 폭/직경 칸을 쓰는 공구 */
export const USES_WIDTH: ToolType[] = ['groove', 'igroove', 'drill', 'tap', 'knurl'];
/** 노즈 반경이 있는 공구 */
export const USES_NOSE: ToolType[] = ['rough', 'finish', 'boring'];

export const MAX_TOOLS = 12;
export const MAX_OFFSETS = 16;

export function defaultTools(): ToolDef[] {
  return [
    { no: 1, type: 'rough', width: 3, noseR: 0.8 },
    { no: 3, type: 'finish', width: 3, noseR: 0.4 },
    { no: 5, type: 'groove', width: 3, noseR: 0 },
    { no: 6, type: 'igroove', width: 2, noseR: 0 },
    { no: 7, type: 'thread', width: 3, noseR: 0 },
    { no: 8, type: 'ithread', width: 3, noseR: 0 },
    { no: 9, type: 'boring', width: 3, noseR: 0.4 },
    { no: 10, type: 'tap', width: 6, noseR: 0 },
    { no: 11, type: 'drill', width: 20, noseR: 0 },
    { no: 12, type: 'knurl', width: 8, noseR: 0 },
  ];
}

export function defaultOffsets(): ToolOffset[] {
  const list: ToolOffset[] = Array.from({ length: MAX_OFFSETS }, () => ({ X: 0, Z: 0, R: 0, T: 0 }));
  list[0] = { X: 0, Z: 0, R: 0.8, T: 3 };
  list[2] = { X: 0, Z: 0, R: 0.4, T: 3 };
  list[8] = { X: 0, Z: 0, R: 0.4, T: 2 };
  return list;
}

/** 나중에 생긴 공구 종류: 예전 설정에 없으면 이 번호가 비어 있을 때 넣어 준다 */
const ADDED_LATER: ToolDef[] = [
  { no: 12, type: 'knurl', width: 8, noseR: 0 },
  { no: 8, type: 'ithread', width: 3, noseR: 0 },
  { no: 6, type: 'igroove', width: 2, noseR: 0 },
  { no: 10, type: 'tap', width: 6, noseR: 0 },
];

/** 저장된 예전 설정에 빠진 값 채우기 */
export function normalizeTools(tools: Partial<ToolDef>[]): ToolDef[] {
  const out: ToolDef[] = tools.map((t) => ({ no: t.no ?? 1, type: t.type ?? 'rough', width: t.width ?? 3, noseR: t.noseR ?? 0 }));
  for (const add of ADDED_LATER)
    if (!out.some((t) => t.type === add.type) && !out.some((t) => t.no === add.no) && out.length < MAX_TOOLS) out.push({ ...add });
  return out.sort((a, b) => a.no - b.no);
}

/**
 * 가상 인선 번호별 "노즈 중심 → 가상 인선점" 방향.
 * 화면 기준 Z 오른쪽 +, X 위 +.  3 = 외경 공구(왼쪽 아래), 2 = 내경 공구(왼쪽 위).
 */
export function tipVector(T: number, R: number): Vec {
  const d: Record<number, [number, number]> = {
    1: [1, 1],
    2: [-1, 1],
    3: [-1, -1],
    4: [1, -1],
    5: [1, 0],
    6: [0, 1],
    7: [-1, 0],
    8: [0, -1],
  };
  const [z, r] = d[T] ?? [0, 0];
  return { z: z * R, r: r * R };
}

const deg = Math.PI / 180;
const dir = (a: number): Vec => ({ z: Math.cos(a * deg), r: Math.sin(a * deg) });

function convexHull(points: Vec[]): Vec[] {
  const pts = [...points].sort((a, b) => a.z - b.z || a.r - b.r);
  const cross = (o: Vec, a: Vec, b: Vec) => (a.z - o.z) * (b.r - o.r) - (a.r - o.r) * (b.z - o.z);
  const half = (list: Vec[]) => {
    const h: Vec[] = [];
    for (const p of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  return half(pts).concat(half([...pts].reverse()));
}

/**
 * 마름모 인서트. 두 날의 각도(minor, major)와 노즈 반경 R.
 * 원점 = 가상 인선점 (노즈 원의 아래쪽·왼쪽 접선의 교점), 노즈 중심 = (R, R).
 */
function rhombus(minor: number, major: number, R: number): Vec[] {
  const L = 10;
  const half = (major - minor) / 2;
  const bis = dir((minor + major) / 2);
  const c = { z: R, r: R };
  const k = R > 0 ? R / Math.sin(half * deg) : 0;
  const P = { z: c.z - bis.z * k, r: c.r - bis.r * k };
  const d1 = dir(minor);
  const d2 = dir(major);
  const A = { z: P.z + L * d1.z, r: P.r + L * d1.r };
  const C = { z: P.z + L * d2.z, r: P.r + L * d2.r };
  const B = { z: A.z + L * d2.z, r: A.r + L * d2.r };
  if (R <= 0) return [{ z: 0, r: 0 }, A, B, C];
  const circle: Vec[] = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * 360;
    circle.push({ z: c.z + R * Math.cos(a * deg), r: c.r + R * Math.sin(a * deg) });
  }
  return convexHull([...circle, A, B, C]);
}

/**
 * 공구 인서트 윤곽 (공구 끝점 = 가상 인선점 기준, 볼록 다각형).
 * 우수 외경 공구가 공작물 위쪽(+X)에서 -Z 방향으로 깎는 배치.
 */
export function toolShape(t: ToolDef): Vec[] {
  const R = Math.max(0, t.noseR || 0);
  switch (t.type) {
    case 'rough':
      // 부절인 5°, 주절인 85° (진입각 95°)
      return rhombus(5, 85, R);
    case 'finish':
      // 부절인 32°, 주절인 87° (진입각 93°)
      return rhombus(32, 87, R);
    case 'boring':
      // 정삭 인서트를 위아래로 뒤집은 모양 (구멍 안쪽 벽을 위로 깎음)
      return convexHull(rhombus(32, 87, R).map((p) => ({ z: p.z, r: -p.r })));
    case 'groove': {
      // 기준점: 왼쪽(척 쪽) 모서리, 날폭은 +Z 방향
      const w = t.width > 0 ? t.width : 3;
      return [
        { z: 0, r: 0 },
        { z: w, r: 0 },
        { z: w, r: 12 },
        { z: 0, r: 12 },
      ];
    }
    case 'thread': {
      // 날 끝 2mm 만 60° 산 모양, 그 위는 몸체
      const h = 2;
      const half = h * Math.tan(30 * deg);
      return [
        { z: 0, r: 0 },
        { z: half, r: h },
        { z: half, r: 12 },
        { z: -half, r: 12 },
        { z: -half, r: h },
      ];
    }
    case 'igroove': {
      // 외경 홈 바이트를 뒤집은 모양: 기준점 = 위쪽(구멍 벽 쪽) 척 쪽 모서리, 날폭은 +Z, 몸체는 아래로 짧게
      const w = t.width > 0 ? t.width : 2;
      return [
        { z: 0, r: 0 },
        { z: 0, r: -6 },
        { z: w, r: -6 },
        { z: w, r: 0 },
      ];
    }
    case 'ithread': {
      // 외경 나사 바이트를 위아래로 뒤집은 모양: 날 끝이 위(구멍 벽 쪽), 몸체는 아래로 짧게
      const h = 2;
      const half = h * Math.tan(30 * deg);
      return [
        { z: 0, r: 0 },
        { z: -half, r: -h },
        { z: -half, r: -6 },
        { z: half, r: -6 },
        { z: half, r: -h },
      ];
    }
    case 'knurl': {
      // 옆에서 본 롤러 (지름 16): 기준점 = 롤러 폭 가운데 아래
      const w = (t.width > 0 ? t.width : 8) / 2;
      return [
        { z: -w, r: 0 },
        { z: w, r: 0 },
        { z: w, r: 16 },
        { z: -w, r: 16 },
      ];
    }
    case 'tap': {
      // 기준점 = 탭 끝 (중심). 끝 1.5mm 는 물림부(모따기), 지름 = 호칭 지름
      const rr = (t.width > 0 ? t.width : 6) / 2;
      return [
        { z: 0, r: -rr * 0.75 },
        { z: 1.5, r: -rr },
        { z: 60, r: -rr },
        { z: 60, r: rr },
        { z: 1.5, r: rr },
        { z: 0, r: rr * 0.75 },
      ];
    }
    case 'drill': {
      // 날끝각 118°, 기준점 = 드릴 끝 (중심)
      const rr = (t.width > 0 ? t.width : 10) / 2;
      const h = rr / Math.tan(59 * deg);
      return [
        { z: 0, r: 0 },
        { z: h, r: -rr },
        { z: 70, r: -rr },
        { z: 70, r: rr },
        { z: h, r: rr },
      ];
    }
  }
}
