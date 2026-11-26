-- 아이디·비밀번호 계정 (모든 시험 공통). 학생 기록(students)은 시험별로 계정에 연결된다.
CREATE TABLE accounts (
  id                  uuid PRIMARY KEY,
  username            text NOT NULL,
  username_key        text NOT NULL UNIQUE,          -- 정규화(소문자) 아이디, 전체 공통 유일
  password_hash       text NOT NULL,                 -- scrypt$N$r$p$salt$hash (원문 저장 안 함)
  school              text NOT NULL,
  school_key          text NOT NULL,
  display_name        text NOT NULL,
  name_key            text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  password_changed_at timestamptz NOT NULL DEFAULT now()
);

-- 로그인 세션 (쿠키 vq_device 값의 HMAC). 로그인·가입마다 새 토큰으로 회전, 로그아웃·비밀번호 초기화 시 폐기
CREATE TABLE sessions (
  token_hash    text PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES accounts(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX sessions_account_idx ON sessions (account_id);

-- 인증 시도 제한용 기록 (scope: login_user, login_ip, login_device, signup_ip, signup_device). 키는 HMAC
CREATE TABLE auth_events (
  scope     text NOT NULL,
  key_hash  text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_events_idx ON auth_events (scope, key_hash, at);

ALTER TABLE students ADD COLUMN account_id uuid REFERENCES accounts(id);
CREATE UNIQUE INDEX students_exam_account_once ON students (exam_id, account_id) WHERE account_id IS NOT NULL;
