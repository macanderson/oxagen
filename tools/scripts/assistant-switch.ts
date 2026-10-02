#!/usr/bin/env tsx
/**
 * assistant-switch: stop or restart Oxagen's in-app assistant in one
 * workspace, through `set_assistant_switch`.
 *
 *   pnpm assistant:switch --org acme --workspace default --on \
 *     --reason "Incident 2026-10-01: the assistant quotes stale spend"
 *   pnpm assistant:switch --org acme --workspace default --off \
 *     --reason "Fixed in 3.4.1"
 *
 * `--on` writes an `agent` kill switch on the workspace's managed assistant
 * agent, and every later turn there is refused. `--off` clears it. Customers
 * cannot set or clear this switch (maintainer ruling, 2026-10-01). A person at
 * Oxagen runs this script against the production DATABASE_URL, the way
 * `pnpm billing:terms` runs.
 *
 * It goes through the kernel with a platform-operator binding
 * (lib/platform-operator-run.ts), so the change leaves the kernel's
 * `capability.invoke_*` row and the handler's `tool.kill_switch_flipped` row,
 * both awaited before the process exits.
 *
 * The data-plane resolver is wired before the invoke, as the API and the app
 * wire it at bootstrap. Without it every organization resolves to the shared
 * plane, and an organization on a dedicated plane would get a switch the
 * assistant never reads.
 *
 * Running it twice is safe. A second `--on` finds the switch already on, and an
 * `--off` with no switch on writes nothing.
 */
import kleur from "kleur";
import { and, eq } from "drizzle-orm";
import { requireEnv } from "@oxagen/config/env";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { bootstrapDataPlaneResolver } from "@oxagen/database/data-plane";
import { makeSecurityEventInserter } from "@oxagen/database/security";
import { invoke, setSecurityEventEmitter } from "@oxagen/oxagen/kernel";
import { recordSecurityEventAsync } from "@oxagen/telemetry";
import {
  assistantSwitchSet,
  type AssistantSwitchSetOutput,
} from "@oxagen/oxagen/contracts/assistant.switch.set";
import {
  describeTarget,
  invokeAsPlatformOperator,
  readFlags,
  resolveOrgBySlug,
  type PlatformOperatorRunDeps,
} from "./lib/platform-operator-run";
import { isEntrypoint } from "./lib/is-entrypoint.mjs";

const USAGE =
  "usage: pnpm assistant:switch --org <slug> --workspace <slug> --on|--off --reason <text>";

/** The contract's bound on `reason`. */
const MAX_REASON_LENGTH = 500;

export interface AssistantSwitchFlags {
  orgSlug: string;
  workspaceSlug: string;
  /** True stops the assistant. False lets it answer again. */
  on: boolean;
  reason: string;
}

/**
 * Parse the flags. Every one is required, and exactly one of `--on` and
 * `--off`: the operator reading the command back is the only review it gets.
 */
export function parseAssistantSwitchFlags(
  argv: string[],
): AssistantSwitchFlags {
  const f = readFlags(
    argv,
    {
      values: ["--org", "--workspace", "--reason"],
      switches: ["--on", "--off"],
    },
    USAGE,
  );
  const need = (flag: string): string => {
    const v = f.get(flag);
    if (typeof v !== "string") throw new Error(`${flag} is required\n${USAGE}`);
    return v;
  };
  const on = f.get("--on") === true;
  const off = f.get("--off") === true;
  if (on === off) {
    throw new Error(`give exactly one of --on and --off\n${USAGE}`);
  }
  const reason = need("--reason").trim();
  if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
    throw new Error(
      `--reason must be 1 to ${MAX_REASON_LENGTH} characters\n${USAGE}`,
    );
  }
  return {
    orgSlug: need("--org"),
    workspaceSlug: need("--workspace"),
    on,
    reason,
  };
}

export interface AssistantSwitchRunDeps extends PlatformOperatorRunDeps {
  resolveOrg: (slug: string) => Promise<{ id: string; name: string } | null>;
  resolveWorkspace: (
    orgId: string,
    slug: string,
  ) => Promise<{ id: string; name: string } | null>;
  log: (line: string) => void;
}

/** One line on what the call did, from what the database holds afterwards. */
export function describeOutcome(
  on: boolean,
  stored: AssistantSwitchSetOutput,
): string {
  if (on) {
    return stored.changed
      ? `Stopped: switch ${stored.switchId} is on. The assistant refuses every turn in this workspace.`
      : `Already stopped: switch ${stored.switchId} was on. Nothing written.`;
  }
  return stored.changed
    ? `Restarted: switch ${stored.switchId} is off. The assistant answers again.`
    : "No switch was on. Nothing written.";
}

/**
 * Resolve both slugs, print what is about to change, and invoke
 * `set_assistant_switch`. Returns what the database holds afterwards.
 */
export async function runAssistantSwitch(
  flags: AssistantSwitchFlags,
  deps: AssistantSwitchRunDeps,
): Promise<AssistantSwitchSetOutput> {
  const org = await deps.resolveOrg(flags.orgSlug);
  if (!org) throw new Error(`no organization with slug "${flags.orgSlug}"`);
  const workspace = await deps.resolveWorkspace(org.id, flags.workspaceSlug);
  if (!workspace) {
    throw new Error(
      `no workspace with slug "${flags.workspaceSlug}" in organization "${flags.orgSlug}"`,
    );
  }

  deps.log(`  Organization : ${org.name} (${flags.orgSlug})`);
  deps.log(`  Workspace    : ${workspace.name} (${flags.workspaceSlug})`);
  deps.log(
    `  Assistant    : ${flags.on ? "stop (switch on)" : "restart (switch off)"}`,
  );
  deps.log(`  Reason       : ${flags.reason}`);

  const { output } = await invokeAsPlatformOperator(
    {
      capability: assistantSwitchSet.name,
      orgId: org.id,
      input: {
        orgId: org.id,
        workspaceId: workspace.id,
        on: flags.on,
        reason: flags.reason,
      },
    },
    deps,
  );
  const stored = assistantSwitchSet.output.parse(output);
  deps.log(`\n  ${describeOutcome(flags.on, stored)}`);
  return stored;
}

/** The workspace a slug names inside one organization, or null. */
async function resolveWorkspaceBySlug(
  orgId: string,
  slug: string,
): Promise<{ id: string; name: string } | null> {
  // tenancy: platform-operator lookup with no tenant scope, filtered by the orgId
  // the run resolved and the workspace slug the operator typed. It returns only
  // the workspaceId and name the run then acts on.
  const row = await withSystemDb((tx) =>
    tx.query.workspaces.findFirst({
      where: and(
        eq(schema.workspaces.orgId, orgId),
        eq(schema.workspaces.slug, slug),
      ),
      columns: { id: true, name: true },
    }),
  );
  return row ?? null;
}

async function main(): Promise<void> {
  const flags = parseAssistantSwitchFlags(process.argv.slice(2));
  const env = requireEnv(["DATABASE_URL"]);
  // Echo the target first: this runs against production by hand, and a shell
  // DATABASE_URL beats --env-file.
  console.log(
    `  Target database: ${kleur.yellow(describeTarget(env.DATABASE_URL))}`,
  );
  bootstrapDataPlaneResolver();
  // The kernel dispatches through the handler registry. Without this import
  // the capability has a contract and no handler.
  await import("@oxagen/handlers/register");
  const insert = makeSecurityEventInserter();
  await runAssistantSwitch(flags, {
    resolveOrg: resolveOrgBySlug,
    resolveWorkspace: resolveWorkspaceBySlug,
    invoke: (name, input, ctx) => invoke(name, input, ctx),
    setSecurityEventEmitter,
    recordSecurityEvent: (event) => recordSecurityEventAsync(insert, event),
    log: (line) => console.log(line),
  });
}

if (isEntrypoint(import.meta.url)) {
  main()
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch(async (err: unknown) => {
      console.error(
        kleur.red("\nassistant-switch failed:"),
        err instanceof Error ? err.message : err,
      );
      await closeDatabase().catch(() => {});
      process.exit(1);
    });
}
