-- 동의·유사 그룹(설정 파일)에서 온 '함께 보기로 내면 안 되는' 영어 키 목록
ALTER TABLE words ADD COLUMN conflicts jsonb NOT NULL DEFAULT '[]';
