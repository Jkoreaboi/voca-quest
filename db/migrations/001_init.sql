-- Voca Quest 초기 스키마 (PostgreSQL 15+, PGlite 0.6 호환)
-- 시각은 모두 timestamptz(UTC 저장), 표시는 Asia/Seoul.

CREATE TABLE wordbooks (
  id            serial PRIMARY KEY,
  code          text NOT NULL UNIQUE,            -- 'vmap-basic-b1'
  title         text NOT NULL,                   -- 'Vocabulary Map Basic B-1'
  is_sample     boolean NOT NULL DEFAULT false,  -- 테스트/예시 단어장 (실제 시험에 섞이지 않게 구분)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE units (
  id            serial PRIMARY KEY,
  wordbook_id   integer NOT NULL REFERENCES wordbooks(id),
  code          text NOT NULL,                   -- 'CH01-D1'
  label         text NOT NULL,                   -- 'Ch1 Day 1'
  ordinal       integer NOT NULL,                -- 1..N (범위 선택 순서)
  source_file   text NOT NULL,
  source_sheet  text NOT NULL,
  UNIQUE (wordbook_id, code),
  UNIQUE (wordbook_id, ordinal)
);

CREATE TABLE words (
  id            serial PRIMARY KEY,
  wordbook_id   integer NOT NULL REFERENCES wordbooks(id),
  unit_id       integer NOT NULL REFERENCES units(id),
  item_no       integer NOT NULL,                -- 원본 번호 1..40
  english       text NOT NULL,                   -- 표시용 (앞뒤 공백 제거)
  english_norm  text NOT NULL,                   -- 비교용 정규화
  pos           text,                            -- '동', '명', '형', '부', '명, 동' …
  meaning       text NOT NULL,                   -- 표시용 뜻
  senses        jsonb NOT NULL,                  -- 정규화된 뜻 조각 배열
  kind          text NOT NULL,                   -- 'word' | 'phrase' | 'sentence'
  confusables   jsonb NOT NULL DEFAULT '[]',     -- 원본 제공 혼동어(이 교재엔 없음)
  status        text NOT NULL DEFAULT 'active',  -- 'active' | 'needs_review' | 'retired'(원본에서 사라짐)
  status_reason text,
  check_en2ko   text,                            -- 출제 점검: NULL = 영→한 출제 가능, 아니면 제외 사유
  check_ko2en   text,                            -- 출제 점검: NULL = 한→영 출제 가능, 아니면 제외 사유
  checked_at    timestamptz,
  source_file   text NOT NULL,
  source_sheet  text NOT NULL,
  source_cell   text NOT NULL,                   -- 'B5:E5' 처럼 원본 위치
  content_hash  text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (unit_id, item_no)
);
CREATE INDEX words_wordbook_idx ON words (wordbook_id, status);
CREATE INDEX words_english_idx ON words (wordbook_id, english_norm);

CREATE TABLE import_runs (
  id            serial PRIMARY KEY,
  wordbook_id   integer NOT NULL REFERENCES wordbooks(id),
  source_file   text NOT NULL,
  file_sha256   text NOT NULL,
  ran_at        timestamptz NOT NULL DEFAULT now(),
  summary       jsonb NOT NULL
);

CREATE TABLE exams (
  id                  serial PRIMARY KEY,
  slug                text NOT NULL UNIQUE,      -- 학생용 URL 토큰 (/t/<slug>)
  wordbook_id         integer NOT NULL REFERENCES wordbooks(id),
  school              text NOT NULL,
  grade               text NOT NULL,
  textbook            text NOT NULL,
  title               text NOT NULL,
  unit_from           integer NOT NULL,          -- 허용 Unit ordinal (포함)
  unit_to             integer NOT NULL,          -- 허용 Unit ordinal (포함)
  question_count      integer NOT NULL DEFAULT 20 CHECK (question_count BETWEEN 1 AND 200),
  time_limit_ms       integer NOT NULL DEFAULT 10000,
  pass_percent        integer NOT NULL DEFAULT 90 CHECK (pass_percent BETWEEN 1 AND 100),
  quest_starts_at     timestamptz,               -- 포함
  quest_ends_at       timestamptz,               -- 제외
  is_sample           boolean NOT NULL DEFAULT false,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (unit_from <= unit_to),
  CHECK (quest_starts_at IS NULL OR quest_ends_at IS NULL OR quest_starts_at < quest_ends_at)
);

CREATE TABLE students (
  id                  uuid PRIMARY KEY,
  exam_id             integer NOT NULL REFERENCES exams(id),
  display_name        text NOT NULL,
  name_key            text NOT NULL,             -- 정규화 이름 (유일하지 않음: 동명이인 허용)
  recovery_code_hash  text NOT NULL UNIQUE,      -- HMAC-SHA256(APP_SECRET, code). 원문 저장 안 함
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX students_exam_idx ON students (exam_id, name_key);

-- 기기(브라우저) ↔ 학생 연결. 쿠키 원문 대신 해시만 저장.
CREATE TABLE device_students (
  device_hash   text NOT NULL,
  student_id    uuid NOT NULL REFERENCES students(id),
  exam_id       integer NOT NULL REFERENCES exams(id),
  linked_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_hash, student_id)
);
CREATE INDEX device_students_exam_idx ON device_students (device_hash, exam_id, last_used_at DESC);

CREATE TABLE recovery_failures (
  device_hash   text NOT NULL,
  failed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_failures_idx ON recovery_failures (device_hash, failed_at);

CREATE TABLE attempts (
  id                  uuid PRIMARY KEY,
  exam_id             integer NOT NULL REFERENCES exams(id),
  student_id          uuid NOT NULL REFERENCES students(id),
  mode                text NOT NULL CHECK (mode IN ('regular', 'practice')),
  source_attempt_id   uuid REFERENCES attempts(id),       -- practice 의 원본 회차
  client_request_id   text NOT NULL,
  unit_from           integer NOT NULL,
  unit_to             integer NOT NULL,
  unit_from_label     text NOT NULL,
  unit_to_label       text NOT NULL,
  status              text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'quit')),
  total_questions     integer NOT NULL,
  answered_count      integer NOT NULL DEFAULT 0,
  correct_count       integer NOT NULL DEFAULT 0,
  time_limit_ms       integer NOT NULL,
  pass_percent        integer NOT NULL,
  started_at          timestamptz NOT NULL,
  finished_at         timestamptz,
  duration_ms         integer,
  passed              boolean,
  quest_step          integer CHECK (quest_step BETWEEN 1 AND 4),
  quest_note          text,
  mission_seen_at     timestamptz,
  snapshot            jsonb NOT NULL,             -- 응시 당시 시험·학생 정보 (성적표 재현용)
  UNIQUE (student_id, client_request_id)
);
CREATE INDEX attempts_student_idx ON attempts (student_id, mode, started_at DESC);
-- 학생당 진행 중 정규 회차는 하나
CREATE UNIQUE INDEX attempts_one_active_regular ON attempts (student_id) WHERE status = 'in_progress' AND mode = 'regular';
-- 퀘스트 칸은 학생당 한 번씩만 적립
CREATE UNIQUE INDEX attempts_quest_step_once ON attempts (student_id, quest_step) WHERE quest_step IS NOT NULL;

CREATE TABLE attempt_questions (
  attempt_id      uuid NOT NULL REFERENCES attempts(id),
  seq             integer NOT NULL,
  word_id         integer NOT NULL REFERENCES words(id),
  word_key        text NOT NULL,                 -- 오답노트 묶음 키 (english_norm)
  direction       text NOT NULL CHECK (direction IN ('ko2en', 'en2ko')),
  prompt          text NOT NULL,
  pos             text,
  options         jsonb NOT NULL,                -- 보기 4개 (문자열) — 회차 기준 보존
  option_word_ids jsonb NOT NULL,
  correct_index   integer NOT NULL CHECK (correct_index BETWEEN 0 AND 3),
  english         text NOT NULL,                 -- 단어장 변경 후에도 성적표 재현용 스냅샷
  meaning         text NOT NULL,
  unit_label      text NOT NULL,
  presented_at    timestamptz,
  deadline_at     timestamptz,
  answered_at     timestamptz,
  chosen_index    integer CHECK (chosen_index BETWEEN 0 AND 3),
  result          text CHECK (result IN ('correct', 'wrong', 'timeout')),
  PRIMARY KEY (attempt_id, seq)
);
CREATE INDEX attempt_questions_word_idx ON attempt_questions (word_key);
