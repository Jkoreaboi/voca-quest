# Voca Quest

교사가 시험 링크 하나를 카카오톡으로 공유하면, 학생이 휴대폰에서 앱 설치 없이 처음 한 번 학교·이름·아이디·비밀번호로 가입하고(이후 아이디·비밀번호 로그인) 단어 시험(4지선다, 문항당 10초, 90% 이상 PASS)을 보며 퀘스트(출렁다리 → 가시덤불 → 드래곤 → 공주의 성)·오답노트·My Record로 기록을 이어 가는 한국어 웹앱. 다른 휴대폰·PC에서도 같은 아이디로 로그인하면 기록이 이어진다. 비밀번호를 잊으면 선생님이 운영자 명령으로 초기화한다(이메일 찾기 없음). 계정이 없던 기존 학생의 이름 입장·복구 코드는 호환용으로만 남아 있다.

- 스택: Next.js 16 (App Router, TypeScript) + PostgreSQL (`pg`). 로컬은 설치 없이 PGlite(WASM PostgreSQL 17) 소켓 서버로 실행.
- 서버·데이터: Claude / 학생 화면·아트: Codex. 작업 규칙은 `COLLAB.md`, API 계약은 `docs/API.md`, 인수인계는 `HANDOFF.md`.

## 1. 준비물

- Node.js 20 이상 (검증: v26.13.1, npm 11.20). 이 PC에는 `winget install OpenJS.NodeJS.LTS`로 설치됨 (`C:\Program Files\nodejs`).
- 로컬 개발에는 PostgreSQL 설치가 필요 없다. 운영에는 PostgreSQL 15+ 필요.

```powershell
npm install
Copy-Item .env.example .env   # 그 뒤 APP_SECRET, ADMIN_TOKEN 을 임의의 긴 문자열로 바꾼다
```

## 2. 환경변수 (`.env`)

| 이름 | 용도 | 로컬 값 |
|---|---|---|
| `DATABASE_URL` | PostgreSQL 연결 문자열 | `postgres://postgres:postgres@127.0.0.1:54329/postgres` (PGlite 소켓 서버) |
| `DB_FORCE_TX` | `1`이면 모든 쿼리를 트랜잭션으로 감쌈. PGlite 소켓 서버(연결 다중화) 전용. 운영 PostgreSQL은 `0` | `1` |
| `APP_SECRET` | 로그인 세션·기기 쿠키·복구 코드·시도 제한 키의 HMAC 키(16자 이상). 바꾸면 모든 로그인이 끊기고 기존 복구 코드가 무효(비밀번호는 영향 없음) | 임의 문자열 |
| `ADMIN_TOKEN` | `/api/admin/*` Bearer 토큰(16자 이상). 비우면 관리자 API 비활성(CLI만 사용) | 임의 문자열 |
| `PUBLIC_BASE_URL` | 관리 명령이 출력하는 학생용 링크의 앞부분 | `http://localhost:3000` |
| `DB_POOL_MAX` | (선택) pg 풀 크기 | 기본 4(로컬)/10 |

## 3. 로컬 실행 (PowerShell, 터미널 2개)

터미널 A — 로컬 DB (켜 둔다, 데이터는 `.data/pglite`):

```powershell
npm run db:local
```

터미널 B — 마이그레이션 → 단어장 임포트 → 시험 생성 → 앱:

```powershell
npm run db:migrate
```

```powershell
npm run import:words -- --config vmap-basic-b1
```

```powershell
npm run admin -- exam:create --wordbook vmap-basic-b1 --school "예시고" --grade "1학년" --textbook "Vocabulary Map Basic B-1" --title "예시 범위" --units 1-20 --questions 20 --quest-start 2026-11-25 --quest-end 2026-12-06 --sample
```

```powershell
npm run dev
```

출력된 `http://localhost:3000/t/<slug>`를 연다. 휴대폰에서 같은 와이파이로 열려면 `PUBLIC_BASE_URL`을 PC의 IP로 바꾼다.

프로덕션 모드 확인: `npm run build` 후 `npx next start -p 3100`. 같은 폴더에서 이미 `next start`가 돌고 있으면 그 서버의 `.next`를 덮어쓰지 않도록 `$env:NEXT_DIST_DIR = ".next-check"`를 지정해 빌드·실행한다(빌드가 tsconfig `include`에 해당 폴더 경로를 자동 추가하니 확인 후 지운다).

## 4. 단어장 임포트

- 매핑 설정: `config/wordbooks/vmap-basic-b1.json` (시트 이름 패턴 `Ch{n}_Day {d}` → Unit, 헤더 4행, 블록 B–E·F–I = 번호/단어/품사/뜻). 원본은 `data/source/`(수정 금지), 교사용 파일이 정답 원본이고 학생용 파일은 교차 확인에만 쓴다.
- 미리 보기(DB 미반영): `npm run import:words -- --config vmap-basic-b1 --dry-run`
- 결과: 콘솔 요약 + `data/import-reports/<code>-latest.{md,json}` (파일·Unit별 읽음/반영/중복/제외/확인 필요, 문제 행의 시트·셀 위치, 출제 점검 결과).
- 재임포트는 (Unit, 번호) 기준 upsert라 행이 늘지 않는다. 원본에서 사라진 행은 지우지 않고 `retired`로 둔다. 시험 회차는 문항·보기·정답을 스냅샷으로 저장하므로 단어장이 바뀌어도 예전 성적표가 그대로 재현된다.
- 다른 교재: `config/wordbooks/<code>.json`을 복사해 시트 패턴·열 문자를 맞추고 `--config <code>`로 실행. 혼동어 열이 있으면 블록에 `"confusables": "J"`처럼 지정하면 보기 생성에서 1순위로 쓴다.
- 동의·유사 그룹: `config/wordbooks/vmap-basic-b1.synonyms.json`. 같은 그룹의 표현(예: `Can I ~?` / `May I ~?` / `Is it okay if I ~?`)은 한 문항에서 정답·오답 보기로 함께 나오지 않는다. 원본에 동의어 정보가 없어 Claude가 800개를 검토해 만든 초기안(61그룹)이며, 교사가 그룹을 고친 뒤 임포트를 다시 실행하면 반영된다. 단어장에 없는 표현을 적으면 임포트 보고서에 경고가 나온다.

## 5. 시험(링크) 관리 — 교사용, 학생에게 노출하지 않음

```powershell
npm run admin -- exam:list
```

```powershell
npm run admin -- exam:check demo-vmap-b1
```

```powershell
npm run admin -- exam:update demo-vmap-b1 --questions 30 --units 3-10 --quest-start 2026-12-01 --quest-end 2026-12-14
```

```powershell
npm run admin -- exam:sample demo-vmap-b1 --per-unit 6
```

(`demo-vmap-b1` 자리에 `exam:list`가 보여 주는 slug를 넣는다.)

- `exam:sample`: 실제 출제와 같은 코드로 Unit마다 예시 문항을 만들어 `data/review/<slug>-sample.csv`로 저장(엑셀에서 바로 열림, 마지막 열에 검토 의견). 출시 전에 교사가 보기가 너무 쉽거나 정답이 둘인 문항이 없는지 확인하는 용도. 문제를 찾으면 동의·유사 그룹 파일에 추가하고 다시 임포트한다.

- `--quest-start/--quest-end`는 한국 날짜(KST). 마감일은 그날 23:59:59까지 유효(내부적으로 다음날 00:00 KST 제외).
- `--active false`로 링크 중지, `--clear-quest`로 퀘스트 기간 제거, `--sample`로 예시 시험 표시.
- 같은 기능의 HTTP API: `GET/POST /api/admin/exams`, `PATCH /api/admin/exams/:slug`, `GET /api/admin/exams/:slug/check`, `GET /api/admin/wordbooks` (`Authorization: Bearer $ADMIN_TOKEN`).

## 6. 테스트

```powershell
npm test
```

서버 규칙 37개 이상(실제 단어장 800개를 메모리 PGlite에 임포트해 검증, 개수는 `npm test` 출력 기준): 재임포트 멱등, 보기 정답 유일성(전 단어·양방향), 동의어·축약형·동의 그룹 충돌, 범위 검증, 0문항, 중복 출제 금지, 새로고침 타이머 유지, 10초 경계, 동시 답안, 시작 연타, 90% 경계 6종, 그만하기, 퀘스트 4회·5회, 기간 경계, 마감 소급, 연습 미반영, 오답 묶음, 누적 오답시험, 학교·이름 입장(동명이인·백필), 아이디·비밀번호(가입 검증·중복·해시·세션 회전·로그아웃·기존 기록 연결·우회 차단·시도 제한·초기화), KST 오늘 집계, 성적표 재현, 설정 변경.

운영자 계정 관리:

```powershell
npm run admin -- account:find --name 김하늘 --school 인천외고
```

```powershell
npm run admin -- account:reset-password harin
```

실제 PostgreSQL에서 같은 테스트 실행(비어 있는 테스트용 DB를 지정. 임시 스키마 `vq_test_*`를 만들고 끝나면 지움):

```powershell
$env:TEST_DATABASE_URL = "postgres://USER:PASSWORD@HOST:5432/vocaquest_test"; npm test
```

(PGlite 소켓 서버를 대상으로 할 때만 `$env:TEST_DB_FORCE_TX = "1"`을 함께 지정.)

HTTP 통합 점검 (앱과 DB가 떠 있어야 함, 약 30초, 실제 10초 대기 포함, 정답 확인을 위해 DB를 직접 읽으므로 운영 DB에서는 실행 금지):

```powershell
npm run e2e:smoke -- --base http://localhost:3000
```

타입 검사: `npm run typecheck`. 화면 QA 스크립트는 Codex가 `qa/`에 둠.

## 7. 배포 (아직 수행하지 않음)

권장: Vercel(또는 Node 서버) + 관리형 PostgreSQL(Neon, Supabase, RDS 등).

1. PostgreSQL 데이터베이스를 만들고 `DATABASE_URL`(TLS), `DB_FORCE_TX=0`, `APP_SECRET`, `ADMIN_TOKEN`, `PUBLIC_BASE_URL=https://<도메인>`을 배포 환경에 설정.
2. 배포 전에 같은 `DATABASE_URL`로 로컬에서 `npm run db:migrate` → `npm run import:words -- --config vmap-basic-b1` → `npm run admin -- exam:create ...` 실행.
3. `npm run build` / `npm start` (Vercel은 자동). 서버리스라면 `DB_POOL_MAX=1~3` 권장.
4. 스테이징 DB에서 `npm run e2e:smoke -- --base https://<스테이징 도메인>`으로 확인 후, 운영 링크를 카카오톡으로 공유.


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


### 현재 학생 접속 방식 (2026-11-26)
처음에는 로그인 화면의 `처음 사용 · 회원가입`에서 학교, 학생 이름, 아이디(4~20자), 비밀번호(8~64자)를 입력합니다. 이후 다른 기기에서도 같은 아이디와 비밀번호로 로그인하면 시험별 학습 기록이 이어집니다. 반 입력은 후속 요청까지 추가하지 않습니다. 이름·학교만으로 다른 계정의 기록을 열 수 없습니다. 비밀번호 분실 시 선생님이 `npm run admin -- account:reset-password <아이디>`로 초기화하며 기존 세션은 폐기됩니다.
기존 계정 없는 기록은 해당 기기에서 같은 학교·이름으로 가입할 때 연결합니다. 복구 코드는 구 버전 호환 API에만 남으며 현재 화면에서는 표시·발급하지 않습니다. 위의 과거 검증 기록 중 이름 입장·코드 복구 항목은 이전 버전 결과입니다. 최신 브라우저 검증은 `node qa/auth-ui.mjs`와 `node qa/navigation-ui.mjs`이며, `QA_BASE`를 실행 중 서버 주소로 설정합니다.

## 공개 저장소 안내
이 저장소에는 앱 소스와 테스트를 포함하며 원본 단어장·학생 안내 PDF, 로컬 DB, 학생 기록, 환경변수, 내부 협업 로그는 포함하지 않습니다. 기존 단어장 설정을 사용하려면 권한이 있는 원본 교사용·학생용 파일을 `config/wordbooks/vmap-basic-b1.json`의 `answerKeyFile`·`crossCheckFile` 경로에 별도로 준비하세요. 실제 단어장 기반 서버 테스트도 해당 파일이 필요합니다. `qa/`의 개인 PC 전용 브라우저 검사와 결과물은 공개본에서 제외하며, 표준 검증은 `npm run typecheck`, `npm test`, `npm run build`, `npm run e2e:smoke`를 사용합니다.
