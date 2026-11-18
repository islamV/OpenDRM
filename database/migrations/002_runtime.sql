-- Operators can provision this restricted role through their own secrets manager.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='shield_api') THEN
    GRANT SELECT ON users,auth_sessions,content,user_roles,role_permissions,subscriptions,content_entitlements TO shield_api;
    GRANT INSERT ON auth_sessions,content,audit_logs TO shield_api;
    GRANT UPDATE(revoked_at) ON auth_sessions TO shield_api;
    GRANT USAGE ON SEQUENCE audit_logs_id_seq TO shield_api;
  END IF;
END $$;
