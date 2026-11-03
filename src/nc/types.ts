/** 2D 점: z = Z축(mm), r = 반경(mm). 기계 X 지령은 직경이므로 r = X / 2. */
export interface Vec {
  z: number;
  r: number;
}

export interface Alarm {
  code: string;
  message: string;
  /** 0부터 시작하는 소스 줄 번호 */
  line: number;
  level: 'alarm' | 'warning';
}

export type SegKind = 'rapid' | 'feed' | 'thread' | 'dwell' | 'tool' | 'stop';

/** 블록 실행 시점의 모달 상태 (화면 표시용) */
export interface Snapshot {
  modal: string[];
  F: number;
  S: number;
  T: string;
  spindle: 'M03' | 'M04' | 'M05';
  coolant: boolean;
  /** 물리 좌표 = 공작물 좌표 + offset (G50 X Z 로 바뀜) */
  offset: Vec;
}

export interface Segment {
  kind: SegKind;
  line: number;
  tool: number;
  /** 공구 끝점 경로 (물리 좌표) */
  pts: Vec[];
  /** pts 각 점까지의 누적 시간(초), times[0] = 0 */
  times: number[];
  /** 프로그램 시작부터의 절대 시작 시간(초) */
  start: number;
  duration: number;
  /** 표시용 이송속도 mm/min */
  feed: number;
  rpm: number;
  /** 나사 리드 (thread 전용) */
  pitch: number;
  /** M01 선택 정지 */
  optional?: boolean;
  /** 사이클 안에서 이 동작이 하는 일 (코드에 안 보이는 후퇴·복귀 설명) */
  note?: string;
  /** 이 동작을 실행시킨 메인 흐름의 블록 줄 (G70 이 P~Q 줄을 실행해도 G70 줄) */
  top: number;
  snap: Snapshot;
}

export interface Program {
  segments: Segment[];
  /** 프로그램을 멈추게 한 알람 (그 블록 직전까지의 동작은 segments 에 있음) */
  alarm: Alarm | null;
  warnings: Alarm[];
  duration: number;
}
