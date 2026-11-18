ALTER TABLE playback_sessions
  ALTER COLUMN device_session_id DROP NOT NULL,
  ADD COLUMN auth_session_hash bytea REFERENCES auth_sessions(token_hash) ON DELETE CASCADE,
  ADD COLUMN token_hash bytea UNIQUE CHECK(octet_length(token_hash)=32),
  ADD COLUMN job_id uuid REFERENCES packaging_jobs,
  ADD COLUMN kid uuid REFERENCES key_versions(kid),
  ADD CHECK ((auth_session_hash IS NOT NULL AND token_hash IS NOT NULL AND job_id IS NOT NULL AND kid IS NOT NULL)
    OR (device_session_id IS NOT NULL AND auth_session_hash IS NULL AND token_hash IS NULL AND job_id IS NULL AND kid IS NULL));
CREATE INDEX playback_auth_session ON playback_sessions(auth_session_hash);
CREATE TABLE studio_demo (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  job_id uuid NOT NULL REFERENCES packaging_jobs,
  viewer_id uuid NOT NULL REFERENCES users
);
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='shield_api') THEN
    GRANT SELECT ON studio_demo TO shield_api;
    GRANT SELECT(id,content_id,revoked_at) ON encryption_keys TO shield_api;
    GRANT SELECT(key_id,version,kid) ON key_versions TO shield_api;
    GRANT SELECT ON playback_sessions TO shield_api;
    GRANT INSERT(content_id,expires_at,auth_session_hash,token_hash,job_id,kid),
      UPDATE(revoked_at) ON playback_sessions TO shield_api;
  END IF;
END $$;
