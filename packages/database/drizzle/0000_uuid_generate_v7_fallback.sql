-- 0000_uuid_generate_v7_fallback.sql
--
-- Fallback definition of uuid_generate_v7() for Postgres instances WITHOUT the
-- pg_uuidv7 extension (stock images, CI, most managed providers). init-postgres.sql
-- attempts `create extension pg_uuidv7` and, when it is unavailable, defers to
-- this migration (see its comment). The schema (_mixins.ts, billing.ts) defaults
-- id columns to uuid_generate_v7(), so it MUST exist before 0004 runs — hence the
-- 0000 prefix (the migration runner applies *.sql in sorted order).
--
-- Idempotent + extension-safe: only creates the plpgsql fallback when a zero-arg
-- uuid_generate_v7() is not already provided (e.g. by pg_uuidv7), so it never
-- clobbers the extension's C implementation. Depends on pgcrypto's
-- gen_random_bytes() (created in init-postgres.sql).

do $$
begin
  if not exists (
    select 1
    from pg_proc p
    where p.proname = 'uuid_generate_v7'
      and p.pronargs = 0
  ) then
    execute $fn$
      create function public.uuid_generate_v7() returns uuid
      language plpgsql
      volatile
      as $body$
      declare
        unix_ts_ms bytea;
        uuid_bytes bytea;
      begin
        -- 48-bit big-endian unix timestamp (milliseconds) in the first 6 bytes.
        unix_ts_ms := substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);
        -- 10 random bytes fill the remainder.
        uuid_bytes := unix_ts_ms || gen_random_bytes(10);
        -- Version 7 in the high nibble of byte 6.
        uuid_bytes := set_byte(uuid_bytes, 6, (b'0111' || get_byte(uuid_bytes, 6)::bit(4))::bit(8)::int);
        -- RFC 4122 variant (10xx) in the high bits of byte 8.
        uuid_bytes := set_byte(uuid_bytes, 8, (b'10' || get_byte(uuid_bytes, 8)::bit(6))::bit(8)::int);
        return encode(uuid_bytes, 'hex')::uuid;
      end
      $body$;
    $fn$;
  end if;
end$$;
