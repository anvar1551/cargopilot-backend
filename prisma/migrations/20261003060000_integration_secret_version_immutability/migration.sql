-- Credential versions are append-only. Rotation must insert a new version and
-- atomically journal/publish its pointer; never rewrite an existing version.
-- No historical rows are modified or certified by installing these guards.
CREATE FUNCTION cp_protect_integration_secret_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Integration secret versions are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'IntegrationProviderSecret_immutable';
END;
$$;
CREATE TRIGGER "IntegrationProviderSecret_immutable"
  BEFORE UPDATE OR DELETE ON "IntegrationProviderSecret"
  FOR EACH ROW EXECUTE FUNCTION cp_protect_integration_secret_version();
CREATE TRIGGER "IntegrationProviderSecret_no_truncate"
  BEFORE TRUNCATE ON "IntegrationProviderSecret"
  FOR EACH STATEMENT EXECUTE FUNCTION cp_protect_integration_secret_version();
