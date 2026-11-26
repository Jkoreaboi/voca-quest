/**
 * Voca Quest — 화면(Codex)과 서버(Claude)가 공유하는 API 타입.
 * 계약 설명은 docs/API.md. 이 파일은 런타임 의존성이 없어 클라이언트에서 import 해도 된다.
 * 모든 시각은 ISO 8601 UTC 문자열이며, 화면 표시는 Asia/Seoul 로 변환한다 (src/shared/time.ts).
 */

export type Direction = 'ko2en' | 'en2ko'; // ko2en: 뜻 → 영단어 고르기, en2ko: 영단어 → 뜻 고르기
export type AttemptMode = 'regular' | 'practice'; // practice = '틀린 것만 다시' 또는 누적 오답시험 (PASS/FAIL·퀘스트·오답노트 미반영)
/** 연습 종류: retry = 성적표의 '이번 오답 다시 풀기', wrong-test = 누적 오답시험. 정규 회차는 null */
export type PracticeKind = 'retry' | 'wrong-test';
export type AttemptStatus = 'in_progress' | 'completed' | 'quit';
export type AnswerResult = 'correct' | 'wrong' | 'timeout';
export type QuestStepNo = 1 | 2 | 3 | 4;

export const QUEST_STEPS = [
  { step: 1, key: 'bridge', name: '출렁다리' },
  { step: 2, key: 'thorns', name: '가시덤불' },
  { step: 3, key: 'dragon', name: '드래곤' },
  { step: 4, key: 'castle', name: '공주의 성' },
] as const;
export const QUEST_TOTAL_STEPS = 4;

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND' // 시험/회차 없음 (또는 이 기기의 학생 것이 아님)
  | 'EXAM_INACTIVE'
  | 'NO_STUDENT' // 이 기기에 이 시험의 학생 세션이 없음 → 이름 입력 화면으로
  | 'INVALID_RANGE' // 시작 Unit > 끝 Unit, 허용 범위 밖
  | 'NO_VALID_QUESTIONS' // 범위 안에 출제 가능한 문항이 0개
  | 'ATTEMPT_IN_PROGRESS' // 진행 중인 정규 회차가 있음 (details.attemptId)
  | 'ATTEMPT_FINISHED' // 이미 끝난 회차에 답안/그만하기
  | 'QUESTION_MISMATCH' // 지금 제시된 문항이 아닌 seq 로 답안
  | 'NO_WRONG_ANSWERS' // 틀린 것만 다시: 오답 없음
  | 'RECOVERY_FAILED' // 복구 코드 불일치
  | 'USERNAME_TAKEN' // 가입: 이미 쓰는 아이디
  | 'LOGIN_FAILED' // 로그인: 아이디 또는 비밀번호 불일치 (어느 쪽인지 알려 주지 않음)
  | 'ACCOUNT_REQUIRED' // 계정이 있는 학생이 /enter·/recover·/recovery-code 를 쓰려 함 → 로그인으로
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED' // 관리자 토큰 없음/불일치
  | 'INTERNAL';

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

// ───────────────────────── 시험(링크) 정보 ─────────────────────────

export interface UnitInfo {
  ordinal: number; // 범위 선택 값 (unitFrom/unitTo 로 보냄)
  code: string; // 예: 'CH01-D1'
  label: string; // 예: 'Ch1 Day 1' — 화면 표시용
  wordCount: number; // 원본 단어 수 (보통 40)
  usableCount: number; // 출제 가능한 단어 수 (보기 4개를 만들 수 있는 것)
}

export interface QuestPeriod {
  startsAt: string | null; // 포함
  endsAt: string | null; // 제외 (마감일 다음날 00:00 KST)
  startDate: string | null; // 'YYYY-MM-DD' (KST)
  endDate: string | null; // 'YYYY-MM-DD' (KST, 마감일 — 이날 끝까지 유효)
  status: 'not_configured' | 'upcoming' | 'active' | 'ended';
  dDay: number | null; // 마감일까지 남은 일수 (KST 날짜 기준). 0 = 오늘 마감(D-Day), 기간 종료 후 null
}

export interface ExamPublic {
  slug: string;
  school: string; // '인천외고'
  grade: string; // '1학년'
  textbook: string; // '어휘끝'
  title: string; // '기말 범위'
  displayTitle: string; // '인천외고 1학년 어휘끝 (기말 범위)'
  examLabel: string; // '어휘끝 (기말 범위)'
  isSample: boolean; // 예시/데모 시험이면 true → 화면에 '예시' 배지
  units: UnitInfo[]; // 이 링크에서 고를 수 있는 Unit 만 (ordinal 오름차순)
  totalWords: number;
  questionCount: number; // 목표 문항 수 (실제 수는 preview 로 확인)
  timeLimitSec: number; // 10
  passPercent: number; // 90
  quest: QuestPeriod;
  serverNow: string;
}

export interface StudentSummary {
  studentId: string;
  name: string;
  school: string; // 학생이 입력한 학교 (생략한 구 클라이언트는 시험 학교)
  username: string | null; // 로그인 아이디. null = 계정 없는 기존(기기 연결) 학생
}

// ───────────────────────── 계정 (아이디·비밀번호) ─────────────────────────
// 계정은 모든 시험(링크) 공통. 다른 시험 링크에서 로그인하면 그 시험의 기록이 자동으로 생긴다.

/** POST /api/exams/:slug/signup → 201 AuthResponse (세션 쿠키 새로 발급) */
export interface SignupRequest {
  school: string; // 1~60자
  name: string; // 1~20자
  username: string; // 4~20자, 영문 소문자·숫자·. _ - (대문자는 소문자로 정규화), 전체 공통 유일
  password: string; // 8~64자, 아이디와 같으면 안 됨
}

/** POST /api/exams/:slug/login → 200 AuthResponse (세션 쿠키 새로 발급, 이전 연결은 이 브라우저에서 끊김) */
export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthResponse {
  student: StudentSummary;
  me: MeInfo;
}

/** POST /api/exams/:slug/logout → 200 { ok: true } (세션 폐기, 쿠키 삭제) */
export interface LogoutResponse {
  ok: true;
}

export interface QuestStepState {
  step: QuestStepNo;
  key: string;
  name: string;
  achievedAt: string | null;
  attemptId: string | null;
}

export interface QuestProgress {
  completedSteps: number; // 0..4
  missionComplete: boolean;
  steps: QuestStepState[]; // 항상 4개
  period: QuestPeriod;
}

export interface InProgressAttempt {
  attemptId: string;
  mode: AttemptMode;
  answered: number;
  total: number;
  unitFromLabel: string;
  unitToLabel: string;
  startedAt: string;
}

export interface MeInfo {
  student: StudentSummary;
  quest: QuestProgress;
  inProgress: InProgressAttempt | null; // 정규 회차만
  wrongNoteCount: number;
}

/** GET /api/exams/:slug */
export interface ExamHomeResponse {
  exam: ExamPublic;
  me: MeInfo | null; // 이 기기에서 이 시험에 들어온 적 없으면 null
}

/** POST /api/exams/:slug/enter  { name } */
export interface EnterRequest {
  name: string;
  /** 1~60자. 생략하면 시험(링크)의 학교. 빈 문자열은 400 */
  school?: string;
}
export interface EnterResponse {
  student: StudentSummary;
  created: boolean; // 새 학생 기록을 만들었으면 true
  recoveryCode: string | null; // created=true 일 때만 1회 표시. 이후 다시 조회 불가(재발급만 가능)
  me: MeInfo;
}

/** POST /api/exams/:slug/recover  { code } — 다른 기기/브라우저에서 이어하기 */
export interface RecoverRequest {
  code: string;
}
export interface RecoverResponse {
  student: StudentSummary;
  me: MeInfo;
}

/** POST /api/exams/:slug/recovery-code — 현재 학생 복구 코드 재발급(이전 코드 무효) */
export interface RecoveryCodeResponse {
  recoveryCode: string;
}

/** GET /api/exams/:slug/preview?from=&to= */
export interface PreviewResponse {
  unitFrom: number;
  unitTo: number;
  unitFromLabel: string;
  unitToLabel: string;
  wordCount: number; // 범위 안 단어 수 (중복 제거)
  usableCount: number; // 출제 가능한 단어 수
  questionCount: number; // 실제 출제될 문항 수 = min(목표, usable)
  targetQuestionCount: number;
  canStart: boolean;
  message: string | null; // 예: '출제 가능한 단어가 12개라 12문항으로 진행돼요.'
}

/** POST /api/exams/:slug/attempts  { unitFrom, unitTo, clientRequestId } */
export interface StartAttemptRequest {
  unitFrom: number;
  unitTo: number;
  clientRequestId: string; // 화면에서 만든 UUID. 연타/재시도 시 같은 값 → 같은 회차 반환
}
export interface StartAttemptResponse {
  attemptId: string;
  totalQuestions: number;
}

// ───────────────────────── 시험 진행 ─────────────────────────

export interface QuestionView {
  seq: number; // 1부터
  total: number;
  direction: Direction;
  instruction: string; // '알맞은 영어 단어를 고르세요' | '알맞은 우리말 뜻을 고르세요'
  prompt: string;
  pos: string | null; // 품사 힌트 (예: '동'), 없으면 null
  options: string[]; // 항상 4개. 정답 위치는 내려주지 않음
  presentedAt: string;
  deadlineAt: string; // 서버가 정한 마감 시각
  remainingMs: number; // 응답 생성 시점의 남은 시간 (클라이언트 시계 보정용)
}

export interface AnswerReveal {
  seq: number;
  direction: Direction;
  prompt: string;
  options: string[];
  result: AnswerResult;
  chosenIndex: number | null; // timeout 이면 null
  correctIndex: number;
  english: string;
  meaning: string;
}

/** GET /api/attempts/:id, POST /next, POST /quit 응답 */
export interface AttemptState {
  attemptId: string;
  examSlug: string;
  mode: AttemptMode;
  practiceKind: PracticeKind | null;
  status: AttemptStatus;
  total: number;
  answered: number;
  correct: number;
  unitFromLabel: string;
  unitToLabel: string;
  rangeLabel: string; // 화면 표시용 범위: 'Ch1 Day 1 ~ Ch1 Day 2' 또는 '누적 오답 7개 단어'
  current: QuestionView | null; // 제시되어 타이머가 도는 문항
  last: AnswerReveal | null; // 가장 최근 확정된 문항 (새로고침 후 정답 공개 화면 복원용)
  needsNext: boolean; // current 없음 + 남은 문항 있음 → POST /next 호출
  serverNow: string;
}

/** POST /api/attempts/:id/answer  { seq, choice } — choice=null 은 시간 초과 신고 */
export interface AnswerRequest {
  seq: number;
  choice: 0 | 1 | 2 | 3 | null;
}
export interface AnswerResponse {
  reveal: AnswerReveal;
  state: AttemptState;
  duplicate: boolean; // 이미 확정된 답안을 다시 보낸 경우 true (결과는 처음 것)
}

// ───────────────────────── 성적표 ─────────────────────────

export interface WrongItem {
  seq: number;
  english: string;
  meaning: string;
  pos: string | null;
  direction: Direction;
  result: 'wrong' | 'timeout';
  chosenText: string | null;
  unitLabel: string;
}

export interface MissionRef {
  step: QuestStepNo;
  name: string;
}

export interface ResultView {
  attemptId: string;
  examSlug: string;
  mode: AttemptMode;
  practiceKind: PracticeKind | null;
  status: AttemptStatus; // completed | quit (in_progress 면 409)
  studentName: string;
  school: string;
  grade: string;
  examLabel: string;
  displayTitle: string;
  unitFromLabel: string;
  unitToLabel: string;
  rangeLabel: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  total: number;
  answered: number;
  correct: number;
  accuracyPercent: number; // 표시용 (소수 첫째 자리 반올림). 판정은 passed 사용
  passPercent: number;
  passed: boolean | null; // practice/quit 이면 null
  wrongs: WrongItem[];
  quest: {
    credited: MissionRef | null; // 이 회차로 적립된 미션
    reason: string | null; // 적립되지 않은 이유 (정규 PASS 인데 미반영일 때 특히)
    celebrate: MissionRef | null; // 아직 연출을 보지 않은 새 미션 → 전체 화면 연출 후 POST /mission-seen
    progress: QuestProgress;
  };
}

/** POST /api/attempts/:id/practice  { clientRequestId } → StartAttemptResponse */
export interface PracticeRequest {
  clientRequestId: string;
}

// ───────────────────────── 오답노트 / My Record ─────────────────────────

export interface WrongNoteItem {
  key: string; // 묶음 키 (정규화된 영단어)
  english: string;
  meanings: string[];
  pos: string | null;
  count: number; // 오답+시간초과 총 횟수 (정규 회차만)
  timeoutCount: number;
  lastWrongAt: string;
  unitLabels: string[];
}

/** GET /api/exams/:slug/wrong-notes */
export interface WrongNotesResponse {
  studentName: string;
  asOf: string;
  total: number;
  items: WrongNoteItem[]; // lastWrongAt 내림차순
}

export interface RecordRound {
  no: number; // n회차 (정규 회차, 시작 순)
  attemptId: string;
  status: AttemptStatus;
  startedAt: string;
  finishedAt: string | null;
  unitFromLabel: string;
  unitToLabel: string;
  total: number;
  answered: number;
  correct: number;
  durationMs: number | null;
  passed: boolean | null;
  mission: MissionRef | null;
  questNote: string | null;
}

/** GET /api/exams/:slug/records */
export interface RecordsResponse {
  studentName: string;
  today: {
    date: string; // 'YYYY-MM-DD' KST
    attempts: number; // = pass + fail + quit (오늘 종료된 정규 회차)
    pass: number;
    fail: number;
    quit: number;
  };
  quest: QuestProgress;
  rounds: RecordRound[]; // 최신이 위
}
