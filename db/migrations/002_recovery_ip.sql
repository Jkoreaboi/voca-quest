-- 복구 코드 시도 제한을 기기 쿠키 + IP 해시 두 기준으로 (쿠키를 지우고 재시도하는 경우 대비)
ALTER TABLE recovery_failures ADD COLUMN ip_hash text;
CREATE INDEX recovery_failures_ip_idx ON recovery_failures (ip_hash, failed_at);
