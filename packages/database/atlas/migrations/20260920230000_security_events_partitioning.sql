-- Migrations must run as a trusted owner that the application cannot assume.
DO $owner$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'oxagen_app') THEN
    IF pg_has_role('oxagen_app', current_user, 'MEMBER')
       OR has_schema_privilege('oxagen_app', 'security', 'CREATE')
       OR pg_has_role('oxagen_app', (SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'security.security_events'::regclass), 'MEMBER') THEN
      RAISE EXCEPTION 'Audit maintenance requires a migration owner unavailable to oxagen_app';
    END IF;
  END IF;
END
$owner$;

-- ADR-125: preserve the existing heap as DEFAULT and restore calendar partitions.
-- The private helper copies policies and grants, including direct-child protection.
CREATE FUNCTION security.copy_audit_table_security(source_table regclass, target_table regclass, copy_grants boolean)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $function$
DECLARE policy_row record; grant_row record; roles_sql text; role_sql text; command_sql text;
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target_table);
  FOR policy_row IN SELECT * FROM pg_catalog.pg_policy WHERE polrelid = source_table LOOP
    SELECT string_agg(CASE WHEN role_id = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(role_id)) END, ', ')
      INTO roles_sql FROM unnest(policy_row.polroles) role_id;
    command_sql := CASE policy_row.polcmd WHEN '*' THEN 'ALL' WHEN 'r' THEN 'SELECT'
      WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' END;
    EXECUTE format('CREATE POLICY %I ON %s AS %s FOR %s TO %s%s%s', policy_row.polname, target_table,
      CASE WHEN policy_row.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END, command_sql, roles_sql,
      CASE WHEN policy_row.polqual IS NULL THEN '' ELSE ' USING (' || pg_get_expr(policy_row.polqual, source_table) || ')' END,
      CASE WHEN policy_row.polwithcheck IS NULL THEN '' ELSE ' WITH CHECK (' || pg_get_expr(policy_row.polwithcheck, source_table) || ')' END);
  END LOOP;
  -- New tables can inherit default grants. Remove those before copying the source ACL.
  FOR grant_row IN SELECT DISTINCT acl.grantee FROM pg_catalog.pg_class c,
    LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl WHERE c.oid = target_table AND acl.grantee <> c.relowner LOOP
    role_sql := CASE WHEN grant_row.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(grant_row.grantee)) END;
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM %s', target_table, role_sql);
  END LOOP;
  IF copy_grants THEN
  FOR grant_row IN SELECT acl.* FROM pg_catalog.pg_class c,
    LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl WHERE c.oid = source_table LOOP
    role_sql := CASE WHEN grant_row.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(grant_row.grantee)) END;
    EXECUTE format('GRANT %s ON TABLE %s TO %s%s', grant_row.privilege_type, target_table, role_sql,
      CASE WHEN grant_row.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  END IF;
END
$function$;
REVOKE ALL ON FUNCTION security.copy_audit_table_security(regclass, regclass, boolean) FROM PUBLIC;

DO $migration$
DECLARE original_oid oid := 'security.security_events'::regclass; original_owner text; acl_row record; relation_kind "char";
BEGIN
  SELECT relkind, pg_get_userbyid(relowner) INTO relation_kind, original_owner FROM pg_catalog.pg_class WHERE oid = original_oid;
  IF relation_kind <> 'r' THEN RAISE EXCEPTION 'security_events must match the Atlas heap baseline before conversion'; END IF;
  LOCK TABLE security.security_events IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid = original_oid)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_depend WHERE refobjid = original_oid AND classid = 'pg_catalog.pg_rewrite'::regclass)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = original_oid AND NOT tgisinternal)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = original_oid AND attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'security_events has dependencies, triggers, or column grants requiring an explicit migration';
  END IF;
  ALTER TABLE security.security_events RENAME TO security_events_default;
  ALTER TABLE security.security_events_default RENAME CONSTRAINT security_events_id_occurred_at_pk TO security_events_default_id_occurred_at_pk;
  ALTER INDEX security.security_events_org_occurred_idx RENAME TO security_events_default_org_occurred_idx;
  ALTER INDEX security.security_events_type_occurred_idx RENAME TO security_events_default_type_occurred_idx;
  ALTER INDEX security.security_events_request_id_idx RENAME TO security_events_default_request_id_idx;
  CREATE TABLE security.security_events (LIKE security.security_events_default
    INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED INCLUDING STORAGE INCLUDING COMMENTS)
    PARTITION BY RANGE (occurred_at);
  ALTER TABLE security.security_events ADD CONSTRAINT security_events_id_occurred_at_pk PRIMARY KEY (id, occurred_at);
  CREATE INDEX security_events_org_occurred_idx ON security.security_events (org_id, occurred_at);
  CREATE INDEX security_events_type_occurred_idx ON security.security_events (event_type, occurred_at);
  CREATE INDEX security_events_request_id_idx ON security.security_events (request_id);
  PERFORM security.copy_audit_table_security('security.security_events_default', 'security.security_events', true);
  EXECUTE format('ALTER TABLE security.security_events OWNER TO %I', original_owner);
  FOR acl_row IN SELECT DISTINCT acl.grantee FROM pg_catalog.pg_class c,
    LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    WHERE c.oid = original_oid AND acl.grantee <> c.relowner LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON security.security_events_default FROM %s',
      CASE WHEN acl_row.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(acl_row.grantee)) END);
  END LOOP;
  ALTER TABLE security.security_events ATTACH PARTITION security.security_events_default DEFAULT;
  CREATE INDEX security_events_default_retention_idx ON security.security_events_default (occurred_at);
END
$migration$;

-- Only maintenance can select a cutoff. Callers cannot choose dates or identifiers.
CREATE FUNCTION security.maintain_audit_partitions()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET "app.rls_bypass" = 'on'
SET "app.current_org_id" = ''
SET "app.current_workspace_id" = ''
AS $function$
DECLARE month_offset integer; month_start timestamp; month_end timestamp; child_name text; child_table regclass;
  partition_row record; default_table regclass; deleted_count integer := 0; cutoff timestamptz;
  created_names text[] := '{}'; dropped_names text[] := '{}'; still_expired boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(1869768558, 2840);
  IF (SELECT relkind FROM pg_catalog.pg_class WHERE oid = 'security.security_events'::regclass) <> 'p' THEN
    RAISE EXCEPTION 'security_events partitioning is unavailable';
  END IF;
  LOCK TABLE security.security_events IN ACCESS EXCLUSIVE MODE;
  SELECT c.oid INTO default_table FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'security.security_events'::regclass AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT';
  FOR month_offset IN 0..2 LOOP
    month_start := date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + make_interval(months => month_offset);
    month_end := month_start + interval '1 month';
    child_name := 'security_events_' || to_char(month_start, 'YYYY_MM');
    child_table := to_regclass(format('security.%I', child_name));
    IF child_table IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid = child_table AND inhparent = 'security.security_events'::regclass) THEN
        RAISE EXCEPTION 'Audit partition name % belongs to a different table', child_name;
      END IF;
      CONTINUE;
    END IF;
    EXECUTE format('CREATE TABLE security.%I (LIKE security.security_events INCLUDING ALL)', child_name);
    child_table := to_regclass(format('security.%I', child_name));
    PERFORM security.copy_audit_table_security('security.security_events', child_table, false);
    IF default_table IS NOT NULL THEN
      EXECUTE format('WITH moved AS (DELETE FROM %s WHERE occurred_at >= $1 AND occurred_at < $2 RETURNING *) INSERT INTO %s SELECT * FROM moved', default_table, child_table)
        USING month_start AT TIME ZONE 'UTC', month_end AT TIME ZONE 'UTC';
    END IF;
    EXECUTE format('ALTER TABLE security.security_events ATTACH PARTITION %s FOR VALUES FROM (%L) TO (%L)', child_table,
      month_start AT TIME ZONE 'UTC', month_end AT TIME ZONE 'UTC');
    created_names := array_append(created_names, child_name);
  END LOOP;
  cutoff := ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '7 years') AT TIME ZONE 'UTC';
  FOR partition_row IN SELECT c.oid, c.relname, pg_get_expr(c.relpartbound, c.oid) AS bounds
    FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = 'security.security_events'::regclass AND n.nspname = 'security'
      AND c.relname ~ '^security_events_[0-9]{4}_(0[1-9]|1[0-2])$'
  LOOP
    -- Compare the catalog's upper bound, not a table name that can be renamed.
    IF partition_row.bounds ~ '^FOR VALUES FROM .* TO \(''[^'']+''\)$' THEN
      IF substring(partition_row.bounds FROM ' TO \(''([^'']+)''\)$')::timestamptz <= cutoff THEN
        EXECUTE format('DROP TABLE %s', partition_row.oid::regclass);
        dropped_names := array_append(dropped_names, partition_row.relname);
      END IF;
    END IF;
  END LOOP;
  IF default_table IS NOT NULL THEN
    EXECUTE format('WITH expired AS (SELECT ctid FROM %s WHERE occurred_at < $1 ORDER BY occurred_at LIMIT 10000) DELETE FROM %s d USING expired e WHERE d.ctid = e.ctid', default_table, default_table) USING cutoff;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE occurred_at < $1)', default_table) INTO still_expired USING cutoff;
  END IF;
  RETURN jsonb_build_object('created', created_names, 'dropped', dropped_names,
    'expiredDefaultRows', deleted_count, 'hasExpiredDefaultRows', still_expired);
END
$function$;
REVOKE ALL ON FUNCTION security.maintain_audit_partitions() FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'oxagen_app') THEN
    REVOKE ALL ON FUNCTION security.copy_audit_table_security(regclass, regclass, boolean) FROM oxagen_app;
    GRANT EXECUTE ON FUNCTION security.maintain_audit_partitions() TO oxagen_app;
  END IF;
END
$grant$;
