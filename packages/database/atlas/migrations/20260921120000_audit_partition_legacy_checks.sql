-- Modify "maintain_audit_partitions" function
CREATE OR REPLACE FUNCTION "security"."maintain_audit_partitions" () RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET "search_path" = pg_catalog, pg_temp AS $$
DECLARE month_offset integer; month_start timestamp; month_end timestamp; child_name text; child_table regclass;
  partition_row record; check_row record; default_table regclass; deleted_count integer := 0; cutoff timestamptz;
  created_names text[] := '{}'; dropped_names text[] := '{}'; still_expired boolean := false; saved_bypass text; saved_org text; saved_workspace text;
BEGIN
  saved_bypass := current_setting('app.rls_bypass', true);
  saved_org := current_setting('app.current_org_id', true);
  saved_workspace := current_setting('app.current_workspace_id', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
  PERFORM set_config('app.current_org_id', '', true);
  PERFORM set_config('app.current_workspace_id', '', true);
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
    EXECUTE format('CREATE TABLE security.%I (LIKE security.security_events INCLUDING ALL EXCLUDING CONSTRAINTS)', child_name);
    child_table := to_regclass(format('security.%I', child_name));
    PERFORM security.copy_audit_table_security('security.security_events', child_table, false);
    IF default_table IS NOT NULL THEN
      EXECUTE format('WITH moved AS (DELETE FROM %s WHERE occurred_at >= $1 AND occurred_at < $2 RETURNING *) INSERT INTO %s SELECT * FROM moved', default_table, child_table)
        USING month_start AT TIME ZONE 'UTC', month_end AT TIME ZONE 'UTC';
    END IF;
    -- Preserve historical rows before restoring checks. LIKE would validate
    -- a parent's NOT VALID check on the empty child and reject the row move.
    FOR check_row IN SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
      FROM pg_catalog.pg_constraint WHERE conrelid = 'security.security_events'::regclass AND contype = 'c'
    LOOP
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', child_table, check_row.conname, check_row.definition);
    END LOOP;
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
  PERFORM set_config('app.rls_bypass', coalesce(saved_bypass, ''), true);
  PERFORM set_config('app.current_org_id', coalesce(saved_org, ''), true);
  PERFORM set_config('app.current_workspace_id', coalesce(saved_workspace, ''), true);
  RETURN jsonb_build_object('created', created_names, 'dropped', dropped_names,
    'expiredDefaultRows', deleted_count, 'hasExpiredDefaultRows', still_expired);
END
$$;
