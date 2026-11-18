CREATE TABLE media_wrapping_keys (
  ref text PRIMARY KEY, fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32)
);
ALTER TABLE packaging_jobs ADD COLUMN error_code text,
  ADD COLUMN key_id uuid REFERENCES encryption_keys,
  ADD COLUMN key_version integer,
  ADD FOREIGN KEY(key_id,key_version) REFERENCES key_versions(key_id,version);
CREATE UNIQUE INDEX one_content_key ON encryption_keys(content_id);
CREATE UNIQUE INDEX one_pending_job ON packaging_jobs(asset_id) WHERE state IN ('queued','running');
CREATE INDEX packaging_ready ON packaging_jobs(created_at) WHERE state IN ('queued','running');
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='shield_api') THEN
    GRANT SELECT ON content_assets,packaging_jobs,packaging_outputs TO shield_api;
    GRANT INSERT(id,content_id,storage_path) ON content_assets TO shield_api;
    GRANT INSERT(asset_id) ON packaging_jobs TO shield_api;
  END IF;
END $$;
