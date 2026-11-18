CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_hash bytea NOT NULL UNIQUE CHECK(octet_length(credential_hash)=32),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE roles (name text PRIMARY KEY);
CREATE TABLE permissions (name text PRIMARY KEY);
CREATE TABLE user_roles (
  user_id uuid REFERENCES users ON DELETE CASCADE, role text REFERENCES roles,
  PRIMARY KEY(user_id,role)
);
CREATE TABLE role_permissions (
  role text REFERENCES roles, permission text REFERENCES permissions,
  PRIMARY KEY(role,permission)
);
INSERT INTO roles VALUES ('viewer'),('publisher');
INSERT INTO permissions VALUES ('content.create');
INSERT INTO role_permissions VALUES ('publisher','content.create');
CREATE TABLE auth_sessions (
  token_hash bytea PRIMARY KEY CHECK(octet_length(token_hash)=32),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE license_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE NOT NULL,
  max_devices integer NOT NULL CHECK(max_devices>0),
  max_streams integer NOT NULL CHECK(max_streams>0)
);
CREATE TABLE content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users,
  title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 250),
  policy_id uuid REFERENCES license_policies, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_owner ON content(owner_id);
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
  starts_at timestamptz NOT NULL DEFAULT now(), ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
  UNIQUE(id,user_id)
);
CREATE TABLE content_entitlements (
  content_id uuid REFERENCES content ON DELETE CASCADE, user_id uuid REFERENCES users ON DELETE CASCADE,
  subscription_id uuid, ends_at timestamptz, PRIMARY KEY(user_id,content_id),
  FOREIGN KEY(subscription_id,user_id) REFERENCES subscriptions(id,user_id)
);
CREATE TABLE content_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), content_id uuid NOT NULL REFERENCES content,
  storage_path text UNIQUE NOT NULL
);
CREATE TABLE packaging_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), asset_id uuid NOT NULL REFERENCES content_assets,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','failed','completed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE packaging_outputs (
  job_id uuid REFERENCES packaging_jobs, format text CHECK(format IN ('dash','hls')),
  manifest_path text NOT NULL UNIQUE, PRIMARY KEY(job_id,format)
);
CREATE TABLE drm_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE NOT NULL
);
CREATE TABLE encryption_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), content_id uuid NOT NULL REFERENCES content,
  revoked_at timestamptz
);
CREATE TABLE key_versions (
  key_id uuid REFERENCES encryption_keys, version integer CHECK(version>0),
  kid uuid NOT NULL UNIQUE, wrapping_key_ref text NOT NULL,
  wrapped_dek bytea NOT NULL, ciphertext bytea NOT NULL,
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12), tag bytea NOT NULL CHECK(octet_length(tag)=16),
  PRIMARY KEY(key_id,version)
);
CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users, revoked_at timestamptz
);
CREATE INDEX devices_user ON devices(user_id);
CREATE TABLE device_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid NOT NULL REFERENCES devices,
  expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE TABLE playback_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_session_id uuid NOT NULL REFERENCES device_sessions,
  content_id uuid NOT NULL REFERENCES content, expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE TABLE license_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid REFERENCES playback_sessions,
  provider_id uuid REFERENCES drm_providers, granted boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid REFERENCES users,
  event text NOT NULL, resource_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_time ON audit_logs(created_at);
CREATE TABLE security_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, kind text NOT NULL,
  actor_id uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_time ON security_events(created_at);
