#!/usr/bin/env tsx
/**
 * Provision the `oxagen_app` login credential for RLS enforcement (OXA-1552).
 *
 * Migration 0005_oxagen_app_role.sql creates `oxagen_app` NOLOGIN with all the
 * grants it needs but no password — the password is a secret and must never live
 * in a committed migration. This one-shot operator script flips the role to
 * LOGIN and sets its password from `OXAGEN_APP_DB_PASSWORD`, then verifies the
 * role is safe for RLS (NOSUPERUSER, NOBYPASSRLS). Run it ONCE per environment
 * with an ADMIN (superuser) connection, then repoint that environment's
 * DATABASE_URL at oxagen_app and set TENANT_RLS_ENFORCEMENT_ENABLED=true.
 *
 *   ADMIN_DATABASE_URL=postgres://<superuser>:***@host/db \
 *   OXAGEN_APP_DB_PASSWORD='<generated-strong-secret>' \
 *   pnpm tsx tools/scripts/provision-rls-role.ts
 *
 * Idempotent: re-running just re-sets the password and re-verifies. The script
 * never prints the password; it prints a DATABASE_URL template with the password
 * redacted so the operator can assemble the new connection string by hand.
 */
import postgres from "postgres";
import kleur from "kleur";
import { formatError } from "./lib/format-error";

const ROLE = "oxagen_app";

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(
      kleur.red(`[provision-rls-role] missing required env ${name}`),
    );
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  // Admin connection: prefer an explicit ADMIN_DATABASE_URL so this is never
  // accidentally run through the (about-to-be) least-privilege app connection.
  const adminUrl =
    process.env.ADMIN_DATABASE_URL?.trim() ?? process.env.DATABASE_URL?.trim();
  if (!adminUrl) {
    console.error(
      kleur.red(
        "[provision-rls-role] set ADMIN_DATABASE_URL (or DATABASE_URL) to a superuser connection",
      ),
    );
    process.exit(1);
  }
  if (
    !process.env.ADMIN_DATABASE_URL?.trim() &&
    process.env.DATABASE_URL?.trim()
  ) {
    console.warn(
      kleur.yellow(
        "[provision-rls-role] ADMIN_DATABASE_URL not set — falling back to DATABASE_URL. " +
          "If DATABASE_URL has already been repointed to oxagen_app this will fail with permission denied.",
      ),
    );
  }
  const password = requireEnv("OXAGEN_APP_DB_PASSWORD");

  const sql = postgres(adminUrl, { max: 1, prepare: false });
  try {
    // The role must already exist (migration 0005). Fail loudly if not — we do
    // NOT create it here, so grants stay owned by the migration.
    const [exists] = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}) AS ok
    `;
    if (!exists?.ok) {
      console.error(
        kleur.red(
          `[provision-rls-role] role ${ROLE} not found — run \`pnpm db:migrate\` first ` +
            "so 0005_oxagen_app_role.sql creates it.",
        ),
      );
      process.exit(1);
    }

    // Set LOGIN + password. Parameterized values can't be used for DDL, so the
    // password is quoted via the server's own literal-quoting to avoid injection.
    const quoted = await sql<
      { lit: string }[]
    >`SELECT quote_literal(${password}) AS lit`;
    const passwordLiteral = quoted[0]!.lit;
    await sql.unsafe(
      `ALTER ROLE ${ROLE} WITH LOGIN PASSWORD ${passwordLiteral}`,
    );

    // Verify the role can never bypass RLS — the whole point of this exercise.
    const [attrs] = await sql<
      { rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }[]
    >`
      SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ${ROLE}
    `;
    if (!attrs) {
      console.error(
        kleur.red(`[provision-rls-role] could not read attributes for ${ROLE}`),
      );
      process.exit(1);
    }
    if (attrs.rolsuper || attrs.rolbypassrls) {
      console.error(
        kleur.red(
          `[provision-rls-role] REFUSING — ${ROLE} is ${attrs.rolsuper ? "SUPERUSER" : "BYPASSRLS"}; ` +
            "it would ignore RLS. Run `ALTER ROLE oxagen_app NOSUPERUSER NOBYPASSRLS;` and re-run.",
        ),
      );
      process.exit(1);
    }

    console.log(
      kleur.green(
        `[provision-rls-role] ${ROLE} ready: LOGIN=${attrs.rolcanlogin}, SUPERUSER=false, BYPASSRLS=false`,
      ),
    );

    // Show the DATABASE_URL shape for oxagen_app. Reconstruct it from the parsed
    // host/path only — never string-replace the raw adminUrl, which can leak the
    // superuser password for DSN shapes the old regex didn't match (unix socket,
    // ?password= query param, IAM-token URLs). u.username/u.password are dropped;
    // any credential-bearing query params are stripped defensively.
    console.log(
      kleur.cyan(
        "[provision-rls-role] set this environment's DATABASE_URL to:",
      ),
    );
    try {
      const u = new URL(adminUrl);
      const params = new URLSearchParams(u.search);
      for (const k of [...params.keys()]) {
        if (/pass|pwd|token|secret|credential/i.test(k)) params.delete(k);
      }
      const q = params.toString();
      console.log(
        `  ${u.protocol}//${ROLE}:<OXAGEN_APP_DB_PASSWORD>@${u.host}${u.pathname}${q ? `?${q}` : ""}`,
      );
    } catch {
      console.log(
        `  <scheme>://${ROLE}:<OXAGEN_APP_DB_PASSWORD>@<host>:<port>/<database>`,
      );
    }
    console.log(
      kleur.cyan(
        "[provision-rls-role] then set TENANT_RLS_ENFORCEMENT_ENABLED=true and redeploy.",
      ),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error(kleur.red(formatError(err)));
  process.exit(1);
});
