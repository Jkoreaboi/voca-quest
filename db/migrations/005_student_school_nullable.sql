-- 004 의 NOT NULL 을 푼다: 마이그레이션을 먼저 적용해도 아직 배포 전인 이전 코드(학교 없이 학생 생성)가 계속 동작하도록.
-- 비어 있는 학교는 코드에서 시험(링크)의 학교로 읽는다 (identity.ts STUDENT_COLS).
ALTER TABLE students ALTER COLUMN school DROP NOT NULL;
ALTER TABLE students ALTER COLUMN school_key DROP NOT NULL;
