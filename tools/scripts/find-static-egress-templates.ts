#!/usr/bin/env tsx
/**
 * find-static-egress-templates.ts — #1410
 *
 * Lists every sandbox template that declares `network.mode = "static_egress"`.
 *
 * That mode never pinned an address. It mapped to the driver's `allow` flag,
 * identical to `public`, so a template asking for a locked-down network got
 * unrestricted public egress and nothing said so. `driverNetworkForMode` now
 * refuses the run instead, which stops the silent degradation — but it does not
 * tell anyone that a template they already own was never enforced.
 *
 * That is what this is for, and it is the half that matters most: a customer who
 * allowlisted a pinned address on their database, VPN or partner API has been
 * running with a control they believed they had. Each row here is somebody who
 * needs telling.
 *
 * It is READ-ONLY. There is no `--apply`. Rewriting a template's declared mode
 * would erase the record that its owner asked for egress pinning, which is the
 * one fact worth keeping — the follow-up (#2724) needs to know who wanted it.
 *
 * Usage:
 *   tsx tools/scripts/find-static-egress-templates.ts
 *   tsx tools/scripts/find-static-egress-templates.ts --json
 *
 * Env:
 *   DATABASE_URL — required. The printed target host is worth reading before
 *   you believe the answer: an empty result against a local database says
 *   nothing about production.
 */
import kleur from "kleur";
import postgres from "postgres";

export interface StaticEgressRow {
  id: string;
  publicId: string;
  orgId: string;
  workspaceId: string;
  environmentId: string;
  name: string;
  slug: string;
  isActive: boolean;
  isDefault: boolean;
  network: unknown;
}

/**
 * Whether a row still needs its owner told.
 *
 * An inactive template cannot start a run, so it is reported but does not count
 * toward the number that needs action. A default template counts double in
 * practice — every run in that workspace that names no template resolves to it —
 * so it is called out rather than left for the reader to notice.
 */
export function classify(row: StaticEgressRow): {
  urgent: boolean;
  note: string;
} {
  if (!row.isActive)
    return { urgent: false, note: "inactive — cannot start a run" };
  if (row.isDefault)
    return {
      urgent: true,
      note: "DEFAULT for its environment — every run naming no template used it",
    };
  return { urgent: true, note: "active" };
}

/** Render the report. Separated from the query so it can be tested without a database. */
export function render(rows: StaticEgressRow[]): string {
  if (rows.length === 0) {
    return "[static-egress] no template declares static_egress on this database.";
  }
  const lines = [
    `[static-egress] ${rows.length} template(s) declare a mode that was never enforced:`,
    "",
  ];
  let urgent = 0;
  for (const row of rows) {
    const { urgent: isUrgent, note } = classify(row);
    if (isUrgent) urgent++;
    lines.push(
      `  ${row.publicId}  ${row.name} (${row.slug})`,
      `    org=${row.orgId} workspace=${row.workspaceId} environment=${row.environmentId}`,
      `    ${note}`,
    );
  }
  lines.push(
    "",
    `${urgent} of ${rows.length} can still start a run and need their owner told.`,
    "Tell them the mode was accepted and never enforced, so an allowlist built",
    "around a pinned address was never being honoured. Egress pinning is #2724.",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(kleur.red("[static-egress] DATABASE_URL is not set."));
    process.exit(1);
  }
  const host = new URL(url).host;
  console.log(kleur.cyan(`[static-egress] querying ${host}`));

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const rows = (await sql`
      select id, public_id as "publicId", org_id as "orgId",
             workspace_id as "workspaceId", environment_id as "environmentId",
             name, slug, is_active as "isActive", is_default as "isDefault",
             network
      from environments.sandbox_templates
      where network ->> 'mode' = 'static_egress'
        and deleted_at is null
      order by is_active desc, is_default desc, name
    `) as unknown as StaticEgressRow[];

    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      console.log(render(rows));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error(kleur.red(`[static-egress] ${String(err)}`));
    process.exit(1);
  });
}
