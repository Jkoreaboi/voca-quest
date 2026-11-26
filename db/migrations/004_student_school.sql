-- 학생별 학교 (첫 화면에서 학교·이름으로 입장). 기존 학생은 시험(링크)의 학교로 채워 기록을 그대로 잇는다.
ALTER TABLE students ADD COLUMN school text;
ALTER TABLE students ADD COLUMN school_key text;
UPDATE students s SET school = e.school FROM exams e WHERE e.id = s.exam_id AND s.school IS NULL;
UPDATE students SET school_key = lower(regexp_replace(school, '\s+', '', 'g')) WHERE school_key IS NULL;
ALTER TABLE students ALTER COLUMN school SET NOT NULL;
ALTER TABLE students ALTER COLUMN school_key SET NOT NULL;
CREATE INDEX students_exam_school_name_idx ON students (exam_id, school_key, name_key);
