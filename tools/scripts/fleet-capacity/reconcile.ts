import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { validateProfile, type Profile } from "./core";

interface Machine {
  hostEnrollmentId: string; agentKey: string; acceptedEvents: number;
  acceptedSessions: number; acceptedTurns: number; acceptedBodies: number;
}
interface Receipt { profile: Profile; runId: string; finishedAt: string | null; machines: Machine[]; intakePass: boolean }
interface Durable { key: string; events: string; sessions: string; turns: string; bodies: string }
interface Derived { key: string; sessions: string; turns: string; tools: string; input: string; output: string; unpriced: string; cost_micros: string }

export function stagingStore(value: string, trustedHost: string, protocols: string[]): URL {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || url.hostname !== trustedHost ||
      !/(^|[.-])staging([.-]|$)/.test(url.hostname))
    throw new Error("Store connection must match the pinned staging hostname.");
  return url;
}

export function compare(receipt: Receipt, durable: Durable[], derived: Derived[]) {
  const failures: string[] = [];
  if (new Set(durable.map((row) => row.key)).size !== durable.length ||
      new Set(derived.map((row) => row.key)).size !== derived.length) failures.push("duplicate_groups");
  for (const machine of receipt.machines) {
    const raw = durable.find((row) => row.key === machine.hostEnrollmentId);
    const cost = derived.find((row) => row.key === machine.agentKey);
    if (!raw || Number(raw.events) !== machine.acceptedEvents || Number(raw.sessions) !== machine.acceptedSessions ||
        Number(raw.turns) !== machine.acceptedTurns || Number(raw.bodies) !== machine.acceptedBodies)
      failures.push(`durable:${machine.hostEnrollmentId}`);
    if (!cost || Number(cost.sessions) !== machine.acceptedSessions || Number(cost.turns) !== machine.acceptedTurns ||
        Number(cost.tools) !== machine.acceptedTurns || Number(cost.input) !== machine.acceptedTurns * 10 ||
        Number(cost.output) !== machine.acceptedTurns * 5 || Number(cost.unpriced) !== 0)
      failures.push(`derived:${machine.agentKey}`);
  }
  if (durable.some((row) => !receipt.machines.some((machine) => machine.hostEnrollmentId === row.key)) ||
      derived.some((row) => !receipt.machines.some((machine) => machine.agentKey === row.key))) failures.push("unexpected_groups");
  return { countsMatch: failures.length === 0, failures };
}

/** Tenant predicates and run-specific host identities restrict both store reads. */
export async function reconcileStores(reportPath: string, outputPath: string): Promise<boolean> {
  if (statSync(reportPath).size > 16 * 1024 * 1024) throw new Error("Fleet report exceeds 16 MiB.");
  const receipt = JSON.parse(readFileSync(reportPath, "utf8")) as Receipt;
  validateProfile(receipt.profile, process.env["FLEET_STAGING_ORIGIN"] ?? "", true);
  if (!receipt.finishedAt || receipt.machines.length !== receipt.profile.machines ||
      receipt.machines.some((machine) => !/^tch_[a-z0-9]+$/.test(machine.hostEnrollmentId)))
    throw new Error("Reconciliation requires a finished fleet report with enrolled host identities.");
  const ch = stagingStore(process.env["FLEET_CLICKHOUSE_URL"] ?? "", process.env["FLEET_CLICKHOUSE_HOST"] ?? "", ["https:"]);
  if (ch.username || ch.password || ch.search || ch.hash) throw new Error("Use separate ClickHouse credential variables.");
  const pgUrl = stagingStore(process.env["FLEET_DATABASE_URL"] ?? "", process.env["FLEET_DATABASE_HOST"] ?? "", ["postgres:", "postgresql:"]);
  const hostIds = receipt.machines.map((machine) => machine.hostEnrollmentId);
  ch.searchParams.set("param_org", receipt.profile.orgId);
  ch.searchParams.set("param_workspace", receipt.profile.workspaceId);
  ch.searchParams.set("param_hosts", JSON.stringify(hostIds));
  ch.searchParams.set("max_execution_time", "30");
  ch.searchParams.set("max_memory_usage", "134217728");
  ch.searchParams.set("max_bytes_before_external_group_by", "16777216");
  ch.searchParams.set("max_threads", "2");
  const response = await fetch(ch, { method: "POST", redirect: "error", signal: AbortSignal.timeout(35000),
    headers: { "X-ClickHouse-User": process.env["FLEET_CLICKHOUSE_USER"] ?? "default",
      "X-ClickHouse-Key": process.env["FLEET_CLICKHOUSE_PASSWORD"] ?? "" },
    body: `SELECT host_enrollment_id AS key, toString(count()) AS events,
      toString(countIf(kind = 'agent_start')) AS sessions,
      toString(countIf(kind = 'llm_call')) AS turns,
      toString(countIf(bytes_ref != '')) AS bodies
      FROM tacho_events FINAL
      WHERE org_id = {org:UUID} AND workspace_id = {workspace:UUID}
        AND host_enrollment_id IN {hosts:Array(String)}
      GROUP BY host_enrollment_id LIMIT 501 FORMAT JSONEachRow` });
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error("Staging ClickHouse reconciliation failed."); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("ClickHouse response has no body.");
  const buffer = Buffer.alloc(1024 * 1024);
  let used = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (used + part.value.length > buffer.length) throw new Error("ClickHouse reconciliation exceeds 1 MiB.");
      buffer.set(part.value, used); used += part.value.length;
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  const durable = buffer.subarray(0, used).toString().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Durable);
  const pg = postgres(pgUrl.href, { max: 1, connect_timeout: 10, idle_timeout: 10, prepare: false,
    connection: { statement_timeout: 30000, default_transaction_read_only: true } });
  let derived: Derived[];
  try {
    derived = await pg.begin(async (tx) => {
      await tx`SELECT set_config('app.current_org_id', ${receipt.profile.orgId}, true),
        set_config('app.current_workspace_id', ${receipt.profile.workspaceId}, true),
        set_config('app.org_wide', 'off', true), set_config('app.rls_bypass', 'off', true)`;
      return tx<Derived[]>`SELECT agent_key AS key, count(*)::text AS sessions,
      coalesce(sum(model_calls), 0)::text AS turns, coalesce(sum(tool_calls), 0)::text AS tools,
      coalesce(sum((tokens->>'input_uncached')::bigint), 0)::text AS input,
      coalesce(sum((tokens->>'output')::bigint), 0)::text AS output,
      count(*) FILTER (WHERE cost_micros IS NULL)::text AS unpriced,
      coalesce(sum(cost_micros), 0)::text AS cost_micros
      FROM cost.run_totals
      WHERE org_id = ${receipt.profile.orgId} AND workspace_id = ${receipt.profile.workspaceId}
        AND agent_key = ANY(${receipt.machines.map((machine) => machine.agentKey)})
      GROUP BY agent_key LIMIT 501`;
    });
  } finally { await pg.end({ timeout: 5 }); }
  const result = compare(receipt, durable, derived);
  writeFileSync(outputPath, JSON.stringify({ schema: "fleet-store-reconciliation/v1", runId: receipt.runId,
    observedAt: new Date().toISOString(), ...result, durable, derived, capacityPass: false,
    unverified: ["Stored body digest validation and unchanged monetary totals after replay require an independent audit.",
      "Completed enrichment jobs, oldest pending job age, tenant isolation, and service memory remain unverified."] }, null, 2), { mode: 0o600 });
  return receipt.intakePass && result.countsMatch;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [report, output] = process.argv.slice(2);
  if (!report || !output) throw new Error("Usage: reconcile.ts report.json reconciliation.json");
  reconcileStores(report, output).then((ok) => { if (!ok) process.exitCode = 1; }).catch(() => {
    process.stderr.write("Staging store reconciliation failed. No capacity acceptance was recorded.\n");
    process.exitCode = 1;
  });
}
