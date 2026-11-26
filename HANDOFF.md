# HANDOFF — Voca Quest 첫 구현 (2026-11-25, 11-26 보완)

이 파일만 읽고도 같은 데이터·설정으로 이어서 작업할 수 있게 정리했다. 서버·데이터 부분은 Claude가, 학생 화면·아트는 Codex가 맡았다(규칙과 진행 로그: `COLLAB.md`). 화면 쪽 상세는 아래 `## 화면(Codex)` 섹션(Codex가 추가)과 `qa/`를 본다.

## 1. 현재 상태 한눈에

| 항목 | 상태 |
|---|---|
| 실행 | 로컬에서 실행 확인 (PGlite DB + `next dev` 3000 / `next build`+`next start`) |
| 서버 테스트 | `npm test` **30/30 통과** (메모리 PGlite). 같은 테스트를 `pg` 드라이버·임시 스키마 경로(`TEST_DATABASE_URL`)로도 29/29 통과(누적 오답시험 테스트 추가 전) |
| HTTP 통합 | `npm run e2e:smoke` **33/33 통과** — 11-25 프로덕션 빌드, 11-26 빈 DB에서 README 절차를 처음부터 따라 한 새 빌드(재현 검증) 모두 |
| 재현 검증 (11-26) | 빈 데이터 폴더에서 README 순서 그대로: 마이그레이션 3개 → 임포트 800/800 → `exam:create` → `exam:check` → `exam:sample` → `next build` → `next start` → 스모크 33/33 |
| 브라우저 | 375px 모바일로 첫 화면→PLAY→이름·복구 코드→지도·D-day→시험·시간 초과→그만하기→성적표→PASS 미션 연출(새로고침 시 반복 없음)→My Record→오답노트 확인, 콘솔 오류 0 (Claude). Codex는 실제 Chrome 390×844로 20문항×4회 18정답(90%) PASS → 미션 4단계·Mission Complete까지 확인(`qa/live-*.json`, 캡처) |
| 실제 단어장 | 교사용 엑셀 800행 → 20 Unit 800단어 임포트, 재임포트 신규 0 |
| 운영 배포 | **안 함**. 배포 계정·운영 DB·도메인 필요(아래 7절) |
| 실제 시험 설정 | **안 함**. 학교·학년·시험명·범위·퀘스트 기간을 교사에게 받아야 함. 로컬에는 `[예시]` 시험만 있음 |
| git | 저장소 아님(이 PC PATH에 git 없음). 커밋 없음 |

## 2. 주요 파일

| 경로 | 내용 |
|---|---|
| `docs/API.md`, `src/shared/api.ts` | 화면↔서버 API 계약과 타입 |
| `src/shared/time.ts` | KST 표시·날짜 계산 |
| `db/migrations/001_init.sql`, `002_recovery_ip.sql`, `003_word_conflicts.sql` | 스키마 |
| `config/wordbooks/vmap-basic-b1.synonyms.json` | 동의·유사 그룹 61개 (같은 그룹은 한 문항 보기로 함께 안 나옴, 교사 수정 가능) |
| `src/server/review.ts`, `data/review/` | 교사 검토용 예시 문항 CSV (`exam:sample`) |
| `src/server/wrong-test.ts` | 누적 오답시험 (Codex 추가 → Claude 보완: 보기 재섞기·이어 가기 범위·테스트) |
| `src/server/db.ts` | pg / PGlite 공통 DB 계층 (`DB_FORCE_TX`) |
| `src/server/migrations.ts` | 마이그레이션 실행기 (스크립트·테스트 전용) |
| `src/server/importer.ts`, `config/wordbooks/vmap-basic-b1.json` | 엑셀 파싱·검증·교차 확인·upsert, 매핑 설정 |
| `src/server/normalize.ts`, `src/server/options.ts` | 정규화, 4지선다 보기 생성·충돌 검사 |
| `src/server/attempts.ts` | 회차 생성·문항 제시·채점·그만하기·성적표·연습 |
| `src/server/quest.ts`, `src/server/exams.ts` | 퀘스트 적립, 시험 설정·기간·미리보기·출제 점검 |
| `src/server/identity.ts` | 이름 입장·기기 연결·복구 코드·시도 제한 |
| `src/server/records.ts` | 오답노트, My Record |
| `src/server/http.ts`, `src/app/api/**` | Route Handler |
| `scripts/` | `local-db.ts`, `migrate.ts`, `import-words.ts`, `admin.ts`, `e2e-smoke.ts` |
| `tests/` | vitest (메모리 PGlite + 실제 단어장) |
| `data/source/` | 원본 사본(수정 금지): 교사용·학생용 엑셀, 학습 안내 PDF |
| `data/import-reports/` | 임포트 결과 `vmap-basic-b1-latest.{md,json}` |
| `src/app/t/[slug]/[[...path]]`, `src/components/**`, `src/app/globals.css`, `public/art/**` | 학생 화면 (Codex) |

## 3. 실제 명령과 결과 (2026-11-25, Windows 11, Node v26.13.1)

```text
npm install                                   → 성공 (npm audit: moderate 2건, 아래 8절)
npx tsc --noEmit                              → 오류 0
npm run db:local                              → PGlite 127.0.0.1:54329, 데이터 .data/pglite
npm run db:migrate                            → 001_init.sql, 002_recovery_ip.sql 적용
npm run import:words -- --config vmap-basic-b1 → 1회차 신규 800 / 재실행 신규 0·변경 없음 800
npm run admin -- exam:create ... --slug demo-vmap-b1 --sample → /t/demo-vmap-b1
npm run admin -- exam:check demo-vmap-b1      → 20 Unit 모두 단어 40·출제 가능 40·제외 0
npm test                                      → 29 passed
npx next build                                → 성공(경고 0), 라우트 23개
npx next start -p 3100 + npm run e2e:smoke -- --base http://localhost:3100 → 33/33 PASS
```

2026-11-26 (동의 그룹·검토 CSV·누적 오답시험 보완 후):

```text
npm run db:migrate                                   → 003_word_conflicts.sql 적용
npm run import:words -- --config vmap-basic-b1       → 갱신 197(그룹 반영) → 재실행 변경 없음 800, 경고 0
npm run admin -- exam:sample demo-vmap-b1 --per-unit 6 → data/review/demo-vmap-b1-sample.csv (120문항)
TEST_DATABASE_URL=<PGlite 소켓 54340> TEST_DB_FORCE_TX=1 npm test → 29 passed (pg 드라이버·스키마 격리 경로)
[빈 DB 54350] db:migrate → import:words(신규 800) → exam:create → exam:check → exam:sample
NEXT_DIST_DIR=.next-cleanroom next build → next start -p 3300 → e2e:smoke 33/33 PASS (정리 후 폴더 삭제)
npx tsc --noEmit → 오류 0 / npm test → 30 passed
```

## 4. 원본 단어장 조사·임포트 집계

- 파일: `[단어시험] Vocabulary Map Basic B-1_교사용.xlsx` (sha256 `27440d9453ca8fba…`), 시트 20개 `Ch1_Day 1` … `Ch10_Day 2` (`Ch2_Day 1 `은 이름 끝 공백 → 패턴에서 허용).
- 시트 구조: 2행 제목, 3행 Date/Name/Score, 4행 헤더 `번호|단어|품사|뜻` ×2 블록(B–E: 1~20, F–I: 21~40), 5~24행 데이터. 영단어 열에 단어·구·회화 문장이 섞여 있음(`Can you guess ~?`, `end up + 동명사`). 품사는 구·문장에서 비어 있음. 복수 뜻은 `,`로 구분, 괄호 설명 있음(`(천주교의) 교황`). **유사어·혼동어 열은 없음.**
- 학생용 파일: 같은 구조의 빈칸 시험지(1~20은 뜻 없음, 21~40은 영어 없음) → 출제 원본에서 제외, 교사용과 교차 확인에만 사용.
- 집계(`data/import-reports/vmap-basic-b1-latest.md`):
  - 읽음 800 · 정상 반영 800 · 같은 Unit 중복 0 · 제외 0 · 확인 필요 0
  - Unit 20개 모두 읽음 40 / 반영 40
  - 다른 Unit 반복(같은 단어·뜻) 23건 → 두 Unit 모두 유지, 한 회차에서는 1번만 출제 (Codex 독립 감사도 고유 777 + 반복 23으로 일치)
  - 같은 영어·다른 뜻 34건(예: `match` 맞수/경기/일치하다) → 영→한 문항에서 서로 보기로 쓰지 않음
  - 같은 뜻·다른 영어 25건(예: `cruel`/`brutal` 잔혹한, `book`/`reserve` 예약하다) → 한→영 문항에서 서로 보기로 쓰지 않음
  - 앞뒤 공백 정리 9칸 (info)
  - 학생용 교차 확인: 800 비교, 불일치 0
  - 출제 점검: 800개 모두 최소 한 방향 출제 가능, 출제 불가 0
  - 동의·유사 그룹 61개 적용 → 영어 표현 181개(단어장 행 200개)에 충돌 정보 저장, 그룹 항목 중 단어장에 없는 것 0
- 원본 내용 중 교사 확인이 필요해 보이는 항목(자동 수정하지 않고 원문 그대로 출제됨):

| 위치 | 원문 | 의심 내용 |
|---|---|---|
| Ch1_Day 1 F12:I12 | point A at B — A를 B에 **겨낭**하다 | 오타(겨냥) |
| Ch1_Day 2 F24:I24 | worth — 품사 **동** | 형용사/전치사 |
| Ch3_Day 1 B18:E18 | replace — **대처하다** | '대체하다'의 오기 가능성 (Ch6_Day 1 replace는 대체하다, 바꾸다) |
| Ch3_Day 2 F9:I9 | light — (식사가) 가벼운, **단백한** | 오타(담백한) |
| Ch4_Day 1 F18:I18 | deadly — 품사 **부** | 형용사 (Ch10_Day 1 deadly는 형) |
| Ch10_Day 1 B9:E9 | take measures — 품사 **동** | 구인데 품사 표기 (영향 없음) |
| Ch2_Day 2 F21:I21 | gas — 무연 휘발유 | 의미 범위가 좁음 (확인 권장) |

## 5. 구현 규칙 — PDF 요구사항 vs 채택한 기본값

### PDF(학습 안내)에서 확인한 요구사항
- 카톡 링크 하나로 시작, 앱 설치·로그인 없음. 학교·시험별 링크(예: '인천외고 1학년 어휘끝 (기말 범위)' — **PDF의 예시이며 실제 설정 아님**)
- PLAY → 성문이 열리며 시험 화면으로
- 이름 입력(같은 이름으로 들어와야 기록·오답노트 이어짐), Unit 범위 선택, 퀘스트 지도(진행·D-day·마감일)
- 한→영·영→한 섞기, 철자가 비슷한 헷갈리는 보기, 문항당 10초, 시간 초과 오답, 틀리면 정답 즉시 공개, 그만하기
- 성적표: 이름·학교·시험명·범위·응시 일시·소요 시간·점수·정답률·PASS/FAIL 도장·이번 오답
- 90% 이상 PASS, PASS만 전진(FAIL·그만하기 미전진), 기간 안 PASS만 지도 반영, 4번 PASS → Mission Complete, 미션 애니메이션(화면 어두워지고 전체 화면)
- 틀린 것만 다시(연습, PASS/FAIL·퀘스트 미반영), 누적 오답노트(그만둔 시험 포함), 첫 화면·성적표에서 열람
- My Record: 오늘 기준 응시·PASS·FAIL·그만하기 표, 회차별 날짜·시간·범위·점수·소요 시간·통과 미션, 그만둔 회차(STOP) 표시

### PDF에 없어 채택한 기본값 (지시서 3절 + 구현 판단)
- 학생 식별: 이름 + httpOnly 기기 쿠키(`vq_device`, DB엔 HMAC 해시만). 같은 기기·같은 시험·같은 이름 → 같은 기록. 다른 기기는 12자리 복구 코드(60비트, Crockford base32, `XXXX-XXXX-XXXX`, 원문 미저장·HMAC만, 처음 한 번만 표시, 재발급 가능). 같은 이름만으로는 다른 학생 기록을 열지 않음. 복구 실패 제한: 기기당 10회, IP당 60회 / 10분.
- 문항 수 기본 20(시험별 설정). 유효 문항이 적으면 시작 전 실제 수 안내, 0개면 시작 불가(422) + `exam:check`로 원인 확인.
- 10초: 서버가 문항 제시 시 `deadlineAt = 제시 + 10초`를 확정. 서버 수신 시각 ≥ deadlineAt이면 선택과 무관하게 시간 초과. **네트워크 유예 없음**(Codex 검토 반영).
- 새로고침·재접속: 제시된 문항은 같은 마감으로 이어짐(타이머 재시작 없음). 마감이 지난 미응답 문항은 조회 시점에 시간 초과로 확정. 뒤로가기·끊김은 그만하기가 아님(진행 중으로 남아 이어 풀기).
- PASS 판정: `정답 수 × 100 ≥ 전체 문항 수 × 90` 정수 비교(표시 정답률은 소수 1자리 반올림).
- 기간: Asia/Seoul로 표시, timestamptz 저장, 시작 포함·종료 제외. 날짜만 입력한 마감일은 그날 23:59:59 KST까지. 판정 기준은 서버의 회차 완료 시각.
- 퀘스트는 시험(링크)별·학생별. 4칸 이후 PASS는 적립 없음(사유 표시). 칸당 1회 적립은 DB 부분 유일 인덱스로 보장. 미션 연출은 `mission_seen_at`으로 1회만(‘다시 보기’는 화면에서 수동).
- 중복 방지: 회차 행 `FOR UPDATE` 잠금 + 조건부 UPDATE. 시작·연습은 `clientRequestId`로 멱등. 학생당 진행 중 정규 회차 1개(부분 유일 인덱스). 같은 기기·이름 동시 입장은 advisory lock.
- 출제: 범위 안 단어를 영단어 기준 중복 제거 후 무작위, 한→영/영→한 절반씩. 보기 후보는 책 전체(범위 안 우선). 우선순위: 원본 혼동어(이 교재엔 없음) → 같은 유형(단어/구/문장)·품사 → 철자 유사(한→영)·뜻 길이 유사(영→한). 제외: 같은 표기(대소문자·공백·축약형 포함), 같은/포함 관계의 뜻(책 전체 기준), 4글자 이상 핵심 부분이 길게 겹치는 뜻(예: '나는 ~을 확신한다' / '나는 ~라는 것을 확신한다'), 핵심어를 공유하는 비슷한 뜻 표현, 동의·유사 그룹(설정 파일), 서로 겹치는 오답끼리. 3개를 못 채우면 그 방향/문항 제외(임포트 보고서 `not_testable`, `exam:check`).
- 누적 오답시험(Codex 추가): 정규 회차(완료+그만둠)의 오답·시간 초과를 단어별 최신 문항으로 1번씩, 문항·보기 순서를 다시 섞어 연습 회차로. 정규 기록·퀘스트·오답노트 미반영. 진행 중인 누적 오답시험만 이어 가고, 다른 연습이 진행 중이면 종료 후 새로 만든다.
- 연습('틀린 것만 다시'): 원 회차 오답의 문항 스냅샷을 그대로(보기 순서만 다시 섞음) 사용. 정규 집계·오답노트·퀘스트 미반영. 진행 중 연습이 있으면 새 연습 시작 시 종료 처리.
- 오답노트: 현재 시험·현재 학생의 정규 회차(완료+그만둠)에서 확정된 오답·시간 초과를 영단어 기준으로 묶음(횟수, 시간 초과 수, 최근 시각).
- My Record '오늘': KST 오늘 **종료된** 정규 회차의 PASS+FAIL+그만하기. 진행 중 회차 제외.
- 그만하기: 확정된 답안 보존, 제시 중 미응답 문항은 마감 전이면 버리고 마감 후면 시간 초과로 확정.

### 자료 간 충돌·교사 결정 필요 (영향 / 현재 동작)
1. **Unit 체계** — PDF 예시는 'Unit 36~45'(어휘끝)인데 실제 자료는 Chapter·Day 시트. / 시트 1개 = Unit 1개(ordinal 1~20, 표시 'Ch1 Day 1'). 'Unit n'으로 부르려면 `unitLabelTemplate`만 바꾸고 재임포트.
2. **문항 수** — PDF 화면 예시 60문항(4/40도 보임) vs 지시서 기본 20. / 기본 20, 시험별 `--questions`로 변경.
3. **이어하기 범위** — PDF는 '같은 이름이면 이어짐'. / 같은 기기에서만 이름으로 이어지고, 기기를 바꾸면 복구 코드 필요. 코드를 잃은 학생은 새 기록으로 시작(교사 수동 병합 기능 없음).
4. **같은 기기 동명이인** — 형제가 한 휴대폰을 같은 이름으로 쓰면 기록이 합쳐짐. / 이름에 구분자(예: 최지원2)를 쓰도록 안내 필요.
5. **완료 시각 소급** — 마지막 문항을 연 채 창을 닫으면 완료 시각 = 그 문항 마감 시각. 기간이 끝난 뒤 재접속해도 기간 안 완료로 판정되어 PASS면 적립될 수 있음(그 사이 학생이 바꿀 수 있는 것은 없음). / 현재 동작 유지, 테스트로 고정. '재접속 시각 기준'을 원하면 `expireOverdue`의 완료 시각만 바꾸면 됨.
6. **10초 체감 시간** — 서버 기준이라 네트워크 지연만큼 학생 체감 시간이 줄어듦(수백 ms). / 유예 없음.
7. **보기 품질** — 원본에 혼동어 열이 없어 'cannon·canon·canyon' 같은 보기는 책 안 단어의 철자 유사도로 만든다. 뜻 충돌은 책 안의 뜻 기준 규칙 검사라 책 밖 의미(사전적 다의어)는 다 잡지 못한다. 11-26에 검토 CSV를 직접 훑어 실제 복수 정답 사례(`I'm certain that` / `I'm confident that`)를 찾았고, 뜻 비교 규칙 보강 + Claude가 800개를 검토한 동의·유사 그룹 61개로 막았다. / **교사가 `data/review/demo-vmap-b1-sample.csv`(120문항)와 `config/wordbooks/vmap-basic-b1.synonyms.json`을 검토**하고, 문제 문항은 그룹에 추가 후 재임포트. 혼동어를 제공하면 1순위로 사용.
8. **원본 오탈자** — 4절 표. / 원문 그대로 출제.
9. **시험 선택 드롭다운** — PDF 2단계 화면엔 '시험 선택'이 있음. / 지시서대로 링크별 시험(선택 없음).
10. **아트 자산** — PDF 이미지는 쓰지 않았고, 화면 아트(`public/art/*.png`)는 Codex가 이미지 생성 도구로 만듦(`qa/art-prompts.json`). 사용 범위·저작권 확인은 교사/운영자 결정. 원본 PNG는 장당 약 3MB지만 Codex 확인으로 Next Image가 기기 크기에 맞춘 WebP로 변환해 보내므로 원본이 그대로 전송되지 않음.

## 6. 데이터 모델 요약

`wordbooks` → `units`(ordinal) → `words`(english_norm, senses jsonb, kind, conflicts jsonb, check_en2ko/ko2en, source_cell, content_hash, status) / `import_runs` / `exams`(slug, 허용 unit_from~to, question_count, time_limit_ms, pass_percent, quest_starts_at~ends_at, is_sample, is_active) / `students`(exam별, name_key, recovery_code_hash) / `device_students` / `recovery_failures` / `attempts`(mode regular|practice, status, 스냅샷, passed, quest_step, quest_note, mission_seen_at) / `attempt_questions`(prompt, options, correct_index, english, meaning, presented_at, deadline_at, answered_at, result).

## 7. 운영 준비에 필요한 값 (가짜 값으로 '준비 완료'를 주장하지 않음)

| 필요한 것 | 용도 |
|---|---|
| 배포 대상(Vercel 계정 또는 Node 서버) + HTTPS 도메인 | 카톡으로 공유할 학생 링크 |
| 관리형 PostgreSQL 15+ `DATABASE_URL` | 운영 DB (PGlite 소켓 서버는 로컬 전용) |
| `APP_SECRET` (32자 이상 임의) | 복구 코드·기기·IP HMAC. 운영 후 변경 금지 |
| `ADMIN_TOKEN` (32자 이상 임의) | 관리자 API |
| `PUBLIC_BASE_URL` | 관리 명령이 출력하는 링크 |
| 교사 입력: 학교, 학년, 교재 표기, 시험명, 허용 Unit 범위, 문항 수, 퀘스트 시작일·마감일 | `npm run admin -- exam:create ...` |

순서: DB 생성 → `.env` 설정 → `db:migrate` → `import:words` → `exam:check`로 보기 표본 확인 → `exam:create` → 배포 → 스테이징에서 `e2e:smoke` → 교사가 휴대폰으로 링크 1회 응시 → 카톡 공유. 실제 PostgreSQL 서버에서는 아직 실행해 보지 않았다(PGlite = PostgreSQL 17 WASM으로만 검증) → 스테이징에서 반드시 마이그레이션·스모크 먼저.

## 8. 남은 문제·재현 절차

1. **화면 소소한 항목 — 해결됨**: Claude가 브라우저 점검에서 발견한 4건(숫자 키 1~4, 완료 후 '그만하기' 노출, 오답 0개 연습 버튼, 시간대 표시)을 Codex가 처리하고 프로덕션 빌드에서 재검증(`qa/last-question-results.json`). Claude도 숫자 키 선택을 브라우저로 재확인.
   **실행 중 서버 주의**: 11-26 현재 Codex가 띄운 `next start -p 3200`은 동의 그룹·누적 오답시험 보완 **이전** 빌드다. 다음 작업자는 `npm run build` 후 서버를 다시 시작해야 오늘 변경이 반영된다(DB는 이미 마이그레이션·재임포트 완료).
2. **관리자 웹 화면 없음** — CLI와 관리자 API만 있음. 교사 원격 조회 화면은 PDF에 없어 범위 밖.
3. **npm audit moderate 2건** — `exceljs`가 쓰는 `uuid<11` (버퍼 경계 검사). 임포터 CLI에서만 쓰고 앱 런타임에는 포함되지 않음. 대안: 임포터를 다른 xlsx 파서로 교체.
4. **로컬 DB 다중화 제약** — PGlite 소켓 서버는 연결을 하나의 세션으로 다중화하므로 `DB_FORCE_TX=1`로 모든 쿼리를 트랜잭션에 넣어 격리한다. 운영 PostgreSQL에선 `0`.
5. **Codex 셸에서 `tsx` 실패** — Codex 샌드박스에서는 `uv_os_get_passwd ENOMEM`으로 tsx가 안 돌아 `qa/run-ts.mjs`(transpile)로 QA를 실행했다. 일반 터미널(Claude 셸 포함)에서는 `npx tsx` 정상.
6. 로컬 DB에는 점검용 `[예시]` 시험(`demo-vmap-b1`, `ui-pass-check`, 스모크용 여러 개)과 테스트 학생 기록이 있다. 깨끗하게 시작하려면 `db:local`을 끄고 `.data/pglite` 폴더를 지운 뒤 3절 명령을 다시 실행.

## 9. 이어서 할 일 (우선순위)

1. 교사에게 7절 값 받기 → 스테이징 배포 → 실제 PostgreSQL에서 마이그레이션·`TEST_DATABASE_URL=... npm test`·`e2e:smoke`.
2. 교사 검토: `data/review/demo-vmap-b1-sample.csv`(보기 품질), `config/wordbooks/vmap-basic-b1.synonyms.json`(동의 그룹), 4절 원본 의심 항목 → 수정 후 재임포트(멱등).
3. 로컬 서버를 최신 빌드로 재시작(8-1 주의).
4. (선택) 교사용 관리자 웹 화면, 다른 교재용 매핑 설정 추가, 실제 휴대폰·카카오 인앱 브라우저 확인.


## 화면(Codex)

최종 확인: 2026-11-26. 학생 UI와 아트 5종을 구현했으며, 오프라인 안내/재시도, 키보드 1~4 선택, 마지막 답 확정 뒤 그만하기 숨김을 보완했습니다. HANDOFF 8-1의 네 항목은 실제 브라우저 검증을 마쳤습니다. 오답 0개 연습 버튼 비활성, 미국 기기 시간대에서도 KST 표시를 확인했습니다.

- 화면: src/components/StudentApp.tsx, QuestionCard.tsx, QuestMap.tsx, Dialog.tsx, GameArt.tsx 및 src/app/t/[slug]/[[...path]].
- 아트: 내장 imagegen으로 생성한 public/art/*.png 5장. 정확한 프롬프트는 qa/art-prompts.json. Next Image 반응형 최적화를 사용합니다. 연출은 이미지 확대/빛 효과이며 캐릭터 동영상은 아닙니다. 이미지 실패 및 동작 줄이기에서도 시험이 진행됩니다.
- 실제 Chrome 모바일 390px: 입장, 범위 오류, 타이머 재접속, 실제10초 초과, 그만하기, 연습, 누적노트, My Record, 다른 기기 복구 및 연결 실패 재시도 통과. 실제 18/20 PASS 네 회차와 Mission Complete, 재조회 적립 방지 확인.
- 360/390/768px 18화면 검사는 API mock 기반 레이아웃 검사이며 실제 서버 검증과 구분합니다. 가로 넘침/JS오류 0. 360px 이미지 차단, reduced-motion, 문항 포커스, 제품 버튼44px 이상도 확인했습니다. 실제 휴대폰 하드웨어·Safari·카카오 인앱 브라우저는 미검증입니다.
- 독립 DB 검증: qa/boundaries.ts 시작-1ms/시작정각/종료-1ms/종료정각, KST자정, 동시입장5요청 단일학생 통과. qa/import-check-results.json 재임포트 신규0·총800 유지.
- QA: node qa/ui-smoke.mjs (dev3000, mock), node qa/live-ui.mjs (dev3000, 실제DB), node qa/live-missions.mjs (dev3000, 실제DB), node qa/last-question.mjs (production3200), node qa/run-ts.mjs qa/boundaries.ts. Playwright 경로는 이 PC 번들 경로이므로 다른 PC에서는 설치한 playwright 경로로 바꿉니다.
- Codex 제한 셸에서 tsx userInfo ENOMEM이면 node qa/run-ts.mjs scripts/migrate.ts / scripts/import-words.ts --config vmap-basic-b1 / scripts/admin.ts exam:list 로 동일 명령 실행 가능. 일반 사용자 셸은 README의 npm 명령을 사용합니다.
- lint 스크립트/설정은 없습니다. lint 통과라고 보고하지 않았습니다. 전체 typecheck와 production build는 통과했습니다.


### 추가: Basic B-1 오답시험 (2026-11-26)
첫 화면·시험 준비·오답노트에 교재명에서 Vocabulary Map 접두사를 뺀 난이도 표기(Basic B-1)와 누적 오답시험 옵션을 추가했습니다. 본인·현재 시험의 완료/그만둔 정규 회차에서 오답·시간 초과를 단어별 최신 스냅샷으로 모아 출제합니다. 같은 단어는 한 번만 출제하며 정규 횟수·퀘스트·누적 오답 집계에는 영향을 주지 않습니다. 진행 중 연습이 있으면 이어갑니다. 오답이 없으면 버튼 비활성/서버422입니다. 기존 성적표의 이번 회차 틀린 것만 다시 기능도 유지합니다.
신규 API: POST /api/exams/:slug/wrong-test {clientRequestId}. 구현: src/server/wrong-test.ts. 회귀검사 node qa/run-ts.mjs qa/wrong-test-check.ts 통과, 실제 production3200 모바일 버튼→오답시험→성적표 검증 node qa/wrong-test-ui.mjs 통과. 타입검사·빌드 통과.


### UI 동선 개편 · Claude 공동 검토 (2026-11-26)
홈의 Basic B-1 학습카드를 정규 시험·오답 복습·나의 기록으로 구분하고, 단일 고정 메뉴/현재 위치 표시를 적용했습니다. 시험 중에는 메뉴를 숨기고 준비→문제풀기→결과 단계 표시를 제공합니다. 기록이 연결된 이름 입력은 접어 범위 선택을 먼저 보여줍니다. 이름 확인이 필요한 복습·기록 화면은 연결 후 원래 목적지로 돌아갑니다. 성적표 점수 바로 아래에 틀린 것만 다시/누적 오답 복습/새 정규 시험을 제공합니다. 완료시험은 replace 이동으로 브라우저 뒤로가기 반복을 없앴습니다.
Claude가 문구와 이동 흐름을 독립 검토했고 practiceKind/rangeLabel을 추가해 이번 회차 재풀이와 누적 오답시험을 정확하게 표시하도록 연결했습니다. 회귀: QA_BASE=http://localhost:3200 node qa/navigation-ui.mjs (PowerShell에서는 $env:QA_BASE를 먼저 지정). 360/390/768px, 이름입력 복귀, 빈오답, 정규/오답 시험, 기록, 뒤로가기와 새로고침을 검사합니다.

## 11-26 추가 (Claude): 학교·이름 입장, 아이디·비밀번호 계정

- 마이그레이션 `004_student_school`(학생 학교, 기존 학생은 시험 학교로 백필) → `005_student_school_nullable`(DB 먼저 바꿔도 이전 빌드가 동작하도록 NOT NULL 해제, 빈 학교는 시험 학교로 읽음) → `006_accounts`(accounts·sessions·auth_events, `students.account_id`).
- 계정(`src/server/accounts.ts`): 모든 시험 공통 아이디(4~20자 `[a-z0-9._-]`), 비밀번호 8~64자 scrypt+salt, 로그인·가입마다 세션 토큰 회전, 로그아웃 폐기, 시도 제한(로그인 실패 아이디 10·기기 20·IP 60 / 가입 기기 10·IP 100, 10분), 로그인 실패 메시지 단일화. 가입 시 이 기기의 계정 없는 기존 학생 중 학교·이름이 같은 기록을 연결해 보존.
- 계정 학생·로그인 상태에서는 이름 입장·복구 코드 사용 불가(409 ACCOUNT_REQUIRED). 계정 없는 기존 학생용 `/enter`·복구 코드는 호환으로 유지.
- 운영자: `npm run admin -- account:find --name 이름 [--school 학교]`, `npm run admin -- account:reset-password <아이디>`(임시 비밀번호 1회 표시, 기존 로그인 모두 끊김). 이메일이 없으므로 비밀번호 찾기는 선생님 문의로만.
- 검증: `npm test` 37/37, 스모크 — 이전 빌드 3200 34/34(호환), 최신 코드 dev 3000 39/39(가입·로그인·쿠키 회전·로그아웃 포함).

### 현재 학생 접속 방식 (2026-11-26)
처음에는 로그인 화면의 `처음 사용 · 회원가입`에서 학교, 학생 이름, 아이디(4~20자), 비밀번호(8~64자)를 입력합니다. 이후 다른 기기에서도 같은 아이디와 비밀번호로 로그인하면 시험별 학습 기록이 이어집니다. 반 입력은 후속 요청까지 추가하지 않습니다. 이름·학교만으로 다른 계정의 기록을 열 수 없습니다. 비밀번호 분실 시 선생님이 `npm run admin -- account:reset-password <아이디>`로 초기화하며 기존 세션은 폐기됩니다.
기존 계정 없는 기록은 해당 기기에서 같은 학교·이름으로 가입할 때 연결합니다. 복구 코드는 구 버전 호환 API에만 남으며 현재 화면에서는 표시·발급하지 않습니다. 위의 과거 검증 기록 중 이름 입장·코드 복구 항목은 이전 버전 결과입니다. 최신 브라우저 검증은 `node qa/auth-ui.mjs`와 `node qa/navigation-ui.mjs`이며, `QA_BASE`를 실행 중 서버 주소로 설정합니다.
