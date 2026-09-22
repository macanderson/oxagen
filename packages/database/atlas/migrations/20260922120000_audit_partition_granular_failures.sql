-- Modify "maintain_audit_partitions" function
CREATE OR REPLACE FUNCTION "security"."maintain_audit_partitions" () RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET "search_path" = pg_catalog, pg_temp AS $$
DECLARE month_offset integer; month_start timestamp; month_end timestamp; child_name text; child_table regclass;
  partition_row record; check_row record; default_table regclass; deleted_count integer := 0; cutoff timestamptz;
  created_names text[] := '{}'; dropped_names text[] := '{}'; skipped jsonb := '[]'::jsonb;
  pending_rows bigint; failure_state text; failure_message text;
  still_expired boolean := false; saved_bypass text; saved_org text; saved_workspace text;
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
    -- One month is one subtransaction. A month that cannot be prepared rolls
    -- back alone, leaves its rows readable in DEFAULT, and reports itself in
    -- 'skipped'. The remaining months, retention, and the DEFAULT drain run.
    BEGIN
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
      FOR check_row IN SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_catalog.pg_constraint WHERE conrelid = 'security.security_events'::regclass AND contype = 'c'
      LOOP
        EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', child_table, check_row.conname, check_row.definition);
      END LOOP;
      EXECUTE format('ALTER TABLE security.security_events ATTACH PARTITION %s FOR VALUES FROM (%L) TO (%L)', child_table,
        month_start AT TIME ZONE 'UTC', month_end AT TIME ZONE 'UTC');
      created_names := array_append(created_names, child_name);
    EXCEPTION WHEN others THEN
      GET STACKED DIAGNOSTICS failure_state = RETURNED_SQLSTATE, failure_message = MESSAGE_TEXT;
      pending_rows := 0;
      IF default_table IS NOT NULL THEN
        EXECUTE format('SELECT count(*) FROM %s WHERE occurred_at >= $1 AND occurred_at < $2', default_table)
          INTO pending_rows USING month_start AT TIME ZONE 'UTC', month_end AT TIME ZONE 'UTC';
      END IF;
      skipped := skipped || jsonb_build_object('partition', child_name, 'phase', 'create',
        'sqlstate', failure_state, 'reason', failure_message, 'pendingRows', pending_rows);
    END;
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
        -- One expired partition is one subtransaction, for the same reason.
        BEGIN
          EXECUTE format('DROP TABLE %s', partition_row.oid::regclass);
          dropped_names := array_append(dropped_names, partition_row.relname);
        EXCEPTION WHEN others THEN
          GET STACKED DIAGNOSTICS failure_state = RETURNED_SQLSTATE, failure_message = MESSAGE_TEXT;
          skipped := skipped || jsonb_build_object('partition', partition_row.relname, 'phase', 'drop',
            'sqlstate', failure_state, 'reason', failure_message, 'pendingRows', 0);
        END;
      END IF;
    END IF;
  END LOOP;
  IF default_table IS NOT NULL THEN
    -- A failed drain keeps the created partitions and reports the backlog as unresolved.
    BEGIN
      EXECUTE format('WITH expired AS (SELECT ctid FROM %s WHERE occurred_at < $1 ORDER BY occurred_at LIMIT 10000) DELETE FROM %s d USING expired e WHERE d.ctid = e.ctid', default_table, default_table) USING cutoff;
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE occurred_at < $1)', default_table) INTO still_expired USING cutoff;
    EXCEPTION WHEN others THEN
      GET STACKED DIAGNOSTICS failure_state = RETURNED_SQLSTATE, failure_message = MESSAGE_TEXT;
      deleted_count := 0;
      still_expired := true;
      EXECUTE format('SELECT count(*) FROM %s WHERE occurred_at < $1', default_table) INTO pending_rows USING cutoff;
      skipped := skipped || jsonb_build_object('partition', default_table::text, 'phase', 'drain',
        'sqlstate', failure_state, 'reason', failure_message, 'pendingRows', pending_rows);
    END;
  END IF;
  PERFORM set_config('app.rls_bypass', coalesce(saved_bypass, ''), true);
  PERFORM set_config('app.current_org_id', coalesce(saved_org, ''), true);
  PERFORM set_config('app.current_workspace_id', coalesce(saved_workspace, ''), true);
  RETURN jsonb_build_object('created', created_names, 'dropped', dropped_names,
    'expiredDefaultRows', deleted_count, 'hasExpiredDefaultRows', still_expired,
    'skipped', skipped, 'hasSkippedPartitions', jsonb_array_length(skipped) > 0);
END
$$;
