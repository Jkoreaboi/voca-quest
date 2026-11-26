# Voca Quest API 계약 (v1)

작성: Claude (서버). 타입 정의: `src/shared/api.ts`, 시간 표시 도우미: `src/shared/time.ts`.
화면(Codex)은 이 문서와 타입만 보고 구현할 수 있어야 한다. 바꿔야 할 점은 `COLLAB.md`의 "요청 / 질문"에 적어 주세요.

## 공통

- 모든 요청은 같은 출처(same-origin) `fetch`. 학생 식별은 서버가 심는 httpOnly 쿠키 `vq_device`로 한다. 화면은 쿠키를 직접 다루지 않는다.
- 성공 응답은 JSON 본문 그대로. 실패는 HTTP 4xx/5xx + `ApiErrorBody` `{ error: { code, message, details? } }`. `message`는 학생에게 그대로 보여 줘도 되는 한국어 문장이다.
- 시각은 모두 ISO UTC 문자열. 표시는 `src/shared/time.ts`의 `formatKst*`를 쓴다.
- 정답 위치·내부 키는 답안 확정 전까지 절대 내려가지 않는다. 화면은 서버 응답만으로 정오를 표시한다.
- URL에는 시험 slug와 회차 id(UUID)만 들어간다. 이름·복구 코드·점수는 URL에 넣지 않는다(쿼리스트링 포함).

## 학생 화면 라우트 제안 (Codex 소유, 참고용)

| 화면 | 경로 예시 | 사용하는 API |
|---|---|---|
| 첫 화면(성문, PLAY/오답노트/My Record) | `/t/[slug]` | `GET /api/exams/:slug` |
| 이름·Unit 범위·퀘스트 지도 | `/t/[slug]/start` | `GET /api/exams/:slug`, `POST /enter`, `POST /recover`, `GET /preview`, `POST /attempts` |
| 시험 | `/t/[slug]/play/[attemptId]` | `GET /api/attempts/:id`, `POST /next`, `POST /answer`, `POST /quit` |
| 성적표(+미션 연출) | `/t/[slug]/result/[attemptId]` | `GET /api/attempts/:id/result`, `POST /mission-seen`, `POST /practice` |
| 오답노트 | `/t/[slug]/wrong-notes` | `GET /api/exams/:slug/wrong-notes` |
| My Record | `/t/[slug]/records` | `GET /api/exams/:slug/records` |

## 시험 링크

### `GET /api/exams/:slug` → `ExamHomeResponse`
시험 정보(학교·학년·교재·시험명·허용 Unit·문항 수·10초·90%·퀘스트 기간·D-day)와, 이 기기에서 들어온 학생이 있으면 `me`(퀘스트 진행, 진행 중 회차, 오답 수).
- 404 `NOT_FOUND`: 없는 링크. 410 `EXAM_INACTIVE`: 비활성 시험.
- `exam.isSample=true`면 예시 시험이므로 화면에 "예시" 표시.

### 계정: `POST /signup`·`/login`·`/logout` (11-26, 새 UI는 이것만 사용)
- `POST /api/exams/:slug/signup` `{ school, name, username, password }` → 201 `AuthResponse {student, me}` + 세션 쿠키 회전. 400 검증, 409 `USERNAME_TAKEN`, 429.
- `POST /api/exams/:slug/login` `{ username, password }` → 200 `AuthResponse` + 세션 쿠키 회전. 실패는 항상 401 `LOGIN_FAILED`("아이디 또는 비밀번호가 맞지 않아요."), 429(아이디 10·기기 20·IP 60회/10분).
- `POST /api/exams/:slug/logout` `{}` → `{ ok: true }`, 세션 폐기·쿠키 삭제.
- username 4~20자 `[a-z0-9._-]`(대문자→소문자), 전체 공통 유일. password 8~64자, 아이디와 달라야 함. scrypt+salt.
- 계정은 시험 공통, 시험별 학생 기록은 로그인 시 자동 생성. 가입 시 이 기기의 계정 없는 기존 학생 중 학교·이름이 같은 기록(시험별 1개)을 계정에 연결.
- 계정 학생 또는 로그인 상태에서 `/enter`·`/recover`·`/recovery-code` → 409 `ACCOUNT_REQUIRED`. 비밀번호 초기화는 운영자 CLI(`account:reset-password`)만.

### `POST /api/exams/:slug/enter` `{ name, school? }` → `EnterResponse` (계정 없는 기존 학생 호환용)
- 이 기기에서 같은 이름(공백·대소문자 정규화)으로 들어온 적 있으면 그 학생으로 이어감(`created:false`).
- 없으면 새 학생을 만들고 `recoveryCode`(예: `K7QM-4XN2-WP9D`)를 **한 번만** 돌려준다. 화면은 "다른 기기에서 이어하려면 이 코드를 적어 두세요"를 보여 줘야 한다.
- 다른 기기에서 같은 이름을 써도 기존 기록은 연결·공개되지 않는다(복구 코드 필요).
- 400 `BAD_REQUEST`: 이름이 비었거나 20자 초과.

### `POST /api/exams/:slug/recover` `{ code }` → `RecoverResponse`
복구 코드로 다른 기기의 기록을 이 기기에 연결. 하이픈·대소문자·공백 무시. 400 `RECOVERY_FAILED`, 429 `RATE_LIMITED`(기기당 10분 10회).

### `POST /api/exams/:slug/recovery-code` → `RecoveryCodeResponse`
현재 학생의 복구 코드 재발급(이전 코드 무효). 401 `NO_STUDENT`.

### `GET /api/exams/:slug/preview?from=1&to=3` → `PreviewResponse`
시작 전 실제 문항 수 확인. `from > to`면 400 `INVALID_RANGE`(message: "시작 Unit이 끝 Unit보다 뒤에 있어요."). 허용 범위 밖도 400 `INVALID_RANGE`. 출제 가능 0개면 `canStart:false`와 안내 문구.

### `POST /api/exams/:slug/attempts` `{ unitFrom, unitTo, clientRequestId }` → 201 `StartAttemptResponse`
정규 회차 생성(문항·보기·정답을 이 시점에 서버가 확정해 회차에 저장). 같은 `clientRequestId` 재전송은 같은 회차를 돌려준다.
- 409 `ATTEMPT_IN_PROGRESS` `details.attemptId`: 진행 중 정규 회차가 있음 → 화면은 "이어 풀기 / 그만하고 새로 시작"을 제시(그만하기는 `POST /api/attempts/:id/quit`).
- 400 `INVALID_RANGE`, 422 `NO_VALID_QUESTIONS`, 401 `NO_STUDENT`.

## 시험 진행 (서버 타이머)

상태 흐름: `needsNext` → `POST /next`(문항 제시, 서버가 `deadlineAt` 확정) → `POST /answer` → 정답 공개(`reveal`) → 학생이 "다음" → `POST /next` … 마지막 답안 후 `status: completed` → 성적표.

### `GET /api/attempts/:id` → `AttemptState`
새로고침·재접속 시 사용.
- `current`가 있으면 그 문항을 `remainingMs`부터 이어서 보여 준다(타이머 재시작 없음. 이미 제시된 문항의 마감은 바뀌지 않는다).
- 마감이 지난 미응답 문항은 서버가 조회 시점에 `timeout`으로 확정하고 `last`로 돌려준다.
- `current`가 없고 `needsNext=true`면: `last`가 있으면 정답 공개 화면을 복원하고 "다음" 버튼에서 `POST /next`, 없으면(첫 문항 전) 바로 `POST /next`.
- `status`가 `completed`/`quit`면 성적표로 이동.
- 다른 학생/기기의 회차는 404.

`AttemptState`·`ResultView`에는 화면 표시용 `practiceKind`(`null` = 정규, `'retry'` = 성적표의 이번 오답 다시 풀기, `'wrong-test'` = 누적 오답시험)와 `rangeLabel`(예: `Ch1 Day 1 ~ Ch1 Day 2`, `누적 오답 7개 단어`)이 있다(11-26 추가, 기존 필드 유지).

### `POST /api/attempts/:id/next` → `AttemptState`
다음 문항을 제시(서버 시각으로 `presentedAt`, `deadlineAt = presentedAt + 10초`). 이미 제시된 미응답 문항이 있으면 그대로 반환(연타·재시도 안전).

### `POST /api/attempts/:id/answer` `{ seq, choice }` → `AnswerResponse`
- `choice`는 0~3, 화면 타이머가 0이 되면 `choice:null`로 보낸다(서버는 마감 시각 기준으로 판정).
- 서버 수신 시각이 `deadlineAt` 이상이면 선택과 관계없이 `timeout`(오답). 네트워크 유예 없음(Codex 검토 반영, 정확히 10초 서버 기준).
- 이미 확정된 `seq`를 다시 보내면 처음 결과를 그대로 반환(`duplicate:true`). 중복 탭·연타·재시도 안전.
- 409 `QUESTION_MISMATCH`: 제시되지 않은 문항. 409 `ATTEMPT_FINISHED`.
- 마지막 문항이면 같은 요청 안에서 회차가 완료(`state.status='completed'`)되고 PASS/FAIL·퀘스트 적립이 확정된다.

### `POST /api/attempts/:id/quit` → `AttemptState`
그만하기(화면에서 확인 대화상자를 거친 뒤 호출). 이미 확정된 답안·오답은 보존, 제시 중이던 미응답 문항은 마감 전이면 버리고 마감이 지났으면 `timeout`으로 확정. 이미 `quit`이면 같은 상태 반환. 완료된 회차는 409 `ATTEMPT_FINISHED`.
뒤로가기·네트워크 끊김만으로는 그만하기가 되지 않는다(진행 중으로 남고 첫 화면에서 이어 풀기 가능).

## 성적표·연습

### `GET /api/attempts/:id/result` → `ResultView`
이름·학교·학년·시험·범위·응시 일시(`startedAt`)·소요 시간·점수·정답률·PASS/FAIL·이번 회차 오답(`wrongs`, 비어 있을 수 있음)·퀘스트.
- `passed`: `correct*100 >= total*passPercent`(정수 비교). `accuracyPercent`는 표시용 반올림.
- `quest.credited`: 이 회차로 적립된 미션. `quest.reason`: 적립 안 된 이유(예: "퀘스트 기간(11/26~12/6) 밖에 완료한 시험이라 지도에 반영되지 않았어요.").
- `quest.celebrate`가 있으면 화면을 어둡게 하고 미션 장면 전체 화면 연출(건너뛰기·닫기 제공) → 연출이 끝나거나 닫으면 `POST /mission-seen`. 이후 재조회에서는 `celebrate:null`(자동 반복 없음). "미션 애니메이션 다시 보기"는 화면에서 `credited`로 직접 재생.
- 진행 중 회차는 409 `ATTEMPT_FINISHED`가 아니라 409 `ATTEMPT_IN_PROGRESS`.

### `POST /api/attempts/:id/mission-seen` → `{ ok: true }`
멱등.

### `POST /api/attempts/:id/practice` `{ clientRequestId }` → 201 `StartAttemptResponse`
'틀린 것만 다시': 이 회차의 확정 오답(오답+시간초과)만으로 연습 회차 생성. 연습은 PASS/FAIL·퀘스트·누적 오답노트·My Record 집계에 반영되지 않는다. 422 `NO_WRONG_ANSWERS`.

### `POST /api/exams/:slug/wrong-test` `{ clientRequestId }` → 201 `StartAttemptResponse`
누적 오답시험(Codex 추가, Claude 검토). 현재 시험·현재 학생의 정규 회차(완료+그만둠)에서 확정된 오답·시간 초과를 단어별 최신 문항으로 모아 연습 회차를 만든다. 같은 단어는 1번, 문항·보기 순서는 다시 섞음. 정규 기록·PASS/FAIL·퀘스트·누적 오답노트 미반영. 진행 중인 누적 오답시험이 있으면 그 회차를 돌려주고(이어 가기), 다른 연습이 진행 중이면 종료 후 새로 만든다. 422 `NO_WRONG_ANSWERS`, 401 `NO_STUDENT`.

## 오답노트·My Record

### `GET /api/exams/:slug/wrong-notes` → `WrongNotesResponse`
현재 시험·현재 학생의 정규 회차(완료+그만둔 회차)에서 확정된 오답·시간초과를 영단어 기준으로 묶음. 횟수·최근 오답 시각 포함. 연습 결과는 이력을 바꾸지 않는다.

### `GET /api/exams/:slug/records` → `RecordsResponse`
- `today`: 한국 시간 오늘 **종료된** 정규 회차의 PASS/FAIL/그만하기 수와 합계. 진행 중 회차는 제외.
- `rounds`: 정규 회차 목록(최신 위). 그만둔 회차는 `status:'quit'`, `answered/total`로 "60문항 중 3문항까지 풀고 그만둠" 표시. 인정된 미션은 `mission`.

## 관리자 (교사용, 학생 화면에 노출 금지)

`Authorization: Bearer $ADMIN_TOKEN` 필요. 동일 기능을 CLI로도 제공(`npm run admin -- help`).
- `GET /api/admin/exams` — 시험 목록 + 학생용 URL
- `POST /api/admin/exams` — 시험 생성 `{ wordbook, school, grade, textbook, title, unitFrom, unitTo, questionCount?, questStart?, questEnd? }` (날짜는 'YYYY-MM-DD', KST)
- `PATCH /api/admin/exams/:slug` — 수정
- `GET /api/admin/exams/:slug/check` — 출제 점검(Unit별 출제 가능 수, 제외 단어와 이유)
- `GET /api/admin/wordbooks` — 단어장·Unit 목록, 최근 임포트 요약
