/**
 * Making Tacho's Codex hooks trusted (verified 2026-09-19 against Codex CLI
 * 0.155.1).
 *
 * Writing `~/.codex/hooks.json` is not enough to make a hook run. Since the
 * hooks feature shipped, Codex gates every hook behind a per-hook trust
 * record in `~/.codex/config.toml`:
 *
 *     [hooks.state."<hooks.json path>:<event>:<group>:<index>"]
 *     trusted_hash = "sha256:<digest of that hook's definition>"
 *
 * A hook whose digest is not recorded there is skipped. The
 * interactive TUI offers to record it; `codex exec` cannot ask, so it simply
 * runs no hooks. That is why enrollment looked complete — the file was on
 * disk, every event was present — while the daemon never saw a single Codex
 * hook event, the chain was opened only by the model proxy and never sealed,
 * and `tacho verify --harness codex` waited out its deadline.
 *
 * The digest is Codex's own and its input is not documented, so this module
 * never computes one. It asks: `hooks/list` reports each hook's `key`, its
 * `currentHash` and its `trustStatus`, and `config/value/write` records the
 * pair. Both go through `codex app-server` (see `codex-app-server.ts`), which
 * means Codex writes its own TOML and a change to the hash input, the key
 * format or the file layout needs no change here.
 *
 * The contract is the other writers': only Tacho's own hooks are touched,
 * matched by their exact installed command and source file; re-running changes nothing once the
 * hooks are trusted; and `untrust` removes only the records `trust` added.
 *
 * Trust is bound to the hook's contents, so a rewrite of `hooks.json` — a new
 * enrollment, a new port, a moved `tacho-hook` — invalidates every record it
 * holds (`trustStatus` becomes `modified`). Every command that writes the
 * file must therefore re-run `trustCodexHooks` afterwards.
 */
import { resolve } from "node:path";
import type { CodexAppServer, CodexRpcAnswer } from "./codex-app-server";
import { CODEX_HOOK_EVENTS } from "./codex-writer";
import { hookMarker } from "./settings-writer";

export type CodexHookTrustStatus =
  | "managed"
  | "untrusted"
  | "trusted"
  | "modified";

/** The fields of Codex's `HookMetadata` this module reads. */
export interface CodexHookMetadata {
  key: string;
  currentHash: string;
  trustStatus: CodexHookTrustStatus;
  isManaged: boolean;
  command?: string;
  eventName?: string;
  enabled?: boolean;
  sourcePath?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const TRUST_STATUSES: readonly string[] = [
  "managed",
  "untrusted",
  "trusted",
  "modified",
];

/**
 * The hooks in a `hooks/list` answer, flattened across the working
 * directories it was asked about and deduplicated by key. Anything missing a
 * key, a hash or a recognised status is dropped rather than guessed at, so a
 * Codex whose reply has grown a shape this does not know degrades to "no
 * hooks to trust" instead of writing a record from a misread field.
 */
export function parseHooksList(result: unknown): CodexHookMetadata[] {
  const data = asRecord(result)?.["data"];
  if (!Array.isArray(data)) return [];
  const byKey = new Map<string, CodexHookMetadata>();
  for (const entry of data) {
    const hooks = asRecord(entry)?.["hooks"];
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      const fields = asRecord(hook);
      if (fields === undefined) continue;
      const key = asString(fields["key"]);
      const currentHash = asString(fields["currentHash"]);
      const trustStatus = asString(fields["trustStatus"]);
      if (
        key === undefined ||
        currentHash === undefined ||
        trustStatus === undefined ||
        !TRUST_STATUSES.includes(trustStatus)
      )
        continue;
      byKey.set(key, {
        key,
        currentHash,
        trustStatus: trustStatus as CodexHookTrustStatus,
        isManaged: fields["isManaged"] === true,
        ...(asString(fields["command"]) !== undefined
          ? { command: asString(fields["command"]) as string }
          : {}),
        ...(asString(fields["eventName"]) !== undefined
          ? { eventName: asString(fields["eventName"]) as string }
          : {}),
        ...(typeof fields["enabled"] === "boolean"
          ? { enabled: fields["enabled"] }
          : {}),
        ...(asString(fields["sourcePath"]) !== undefined
          ? { sourcePath: asString(fields["sourcePath"]) as string }
          : {}),
      });
    }
  }
  return [...byKey.values()];
}

/** Tacho's hooks, by the enrollment marker their command line carries. */
export function oxagenHooks(
  hooks: readonly CodexHookMetadata[],
  enrollmentId: string,
): CodexHookMetadata[] {
  const marker = hookMarker(enrollmentId);
  return hooks.filter((hook) => hook.command?.includes(marker) === true);
}

/**
 * The hooks whose trust must be recorded. A managed hook is trusted by
 * construction (its definition comes from an administrator, not this file),
 * so recording a hash for it would be noise; every other status — never
 * recorded, or recorded against an older definition — needs the write.
 */
export function hooksNeedingTrust(
  hooks: readonly CodexHookMetadata[],
): CodexHookMetadata[] {
  return hooks.filter(
    (hook) => !hook.isManaged && hook.trustStatus !== "trusted",
  );
}

/** The `hooks.state` table to upsert for these hooks. */
export function trustTable(
  hooks: readonly CodexHookMetadata[],
): Record<string, { trusted_hash: string }> {
  const table: Record<string, { trusted_hash: string }> = {};
  for (const hook of hooks)
    table[hook.key] = { trusted_hash: hook.currentHash };
  return table;
}

/**
 * A `hooks.state` key path. The key is a file path with the event and the
 * hook's position appended, so it is quoted; TOML basic strings take JSON's
 * escapes, which is what makes `JSON.stringify` the right quoting here.
 */
export function trustKeyPath(key: string): string {
  return `hooks.state.${JSON.stringify(key)}`;
}

const HOOKS_LIST = "hooks/list";
const CONFIG_WRITE = "config/value/write";

function answerProblem(
  answer: CodexRpcAnswer,
  method: string,
): string | undefined {
  if (answer.error !== undefined)
    return `\`${method}\` failed: ${answer.error.message ?? `error ${answer.error.code ?? "?"}`}`;
  if (answer.result === undefined)
    return `\`${method}\` returned nothing; this Codex may be too old to know it`;
  return undefined;
}

export interface CodexHookListing {
  hooks: CodexHookMetadata[];
  problem?: string;
}

function missingEvents(hooks: readonly CodexHookMetadata[]): string[] {
  const present = new Set(hooks.map((hook) => hook.eventName));
  return CODEX_HOOK_EVENTS.filter(
    (event) => !present.has(event.charAt(0).toLowerCase() + event.slice(1)),
  );
}

/** Ask Codex for its hooks and keep Tacho's. Never throws. */
function ownedHooks(
  result: unknown,
  options: CodexHookTrustOptions,
): CodexHookMetadata[] {
  const command = `${options.hookCommand} ${hookMarker(options.enrollmentId)} --harness codex`;
  return parseHooksList(result).filter(
    (hook) =>
      hook.command === command &&
      hook.sourcePath !== undefined &&
      resolve(hook.sourcePath) === resolve(options.hooksPath),
  );
}

export async function listOxagenHooks(
  options: CodexHookTrustOptions,
): Promise<CodexHookListing> {
  const listed = await options.appServer([
    { method: HOOKS_LIST, params: { cwds: options.cwds ?? [] } },
  ]);
  const answer = listed.answers[0] ?? {};
  const problem = listed.problem ?? answerProblem(answer, HOOKS_LIST);
  if (problem !== undefined) return { hooks: [], problem };
  return {
    hooks: ownedHooks(answer.result, options),
  };
}

/**
 * Why Codex would skip Tacho's hooks, in one sentence an operator can act
 * on, or undefined when it would run them. Read-only: `verify` uses it to
 * name an untrusted machine instead of reporting a turn that proved nothing.
 */
export async function codexTrustProblem(
  options: CodexHookTrustOptions,
): Promise<string | undefined> {
  const listing = await listOxagenHooks(options);
  if (listing.problem !== undefined)
    return `Codex hook trust could not be checked: ${listing.problem}`;
  if (listing.hooks.length === 0)
    return "Codex reports none of Tacho's hooks; it is not reading the hooks file Tacho wrote";
  if (listing.hooks.some((hook) => hook.enabled !== true))
    return "Codex has disabled Tacho hooks; open `/hooks` to review and enable them";
  const missing = missingEvents(listing.hooks);
  if (missing.length > 0)
    return `Codex is missing Tacho hooks for ${missing.join(", ")}; run \`tacho enroll\` again`;
  const untrusted = hooksNeedingTrust(listing.hooks);
  if (untrusted.length === 0) return undefined;
  return `Codex has ${untrusted.length} of Tacho's ${listing.hooks.length} hooks recorded as ${[...new Set(untrusted.map((hook) => hook.trustStatus))].join(" or ")}, and it skips a hook it does not trust. Run \`tacho enroll\` again to record them.`;
}

export interface CodexHookTrustResult {
  /** Every one of Tacho's hooks is trusted now. */
  ok: boolean;
  /** How many of Tacho's hooks Codex reported at all. */
  found: number;
  /** Keys this call recorded trust for. */
  recorded: string[];
  /** Keys still not trusted after the write, if any. */
  pending: string[];
  /** Why the exchange could not be completed. */
  problem?: string;
}

export interface CodexHookTrustOptions {
  appServer: CodexAppServer;
  enrollmentId: string;
  hooksPath: string;
  hookCommand: string;
  /** Working directories to resolve hook layers from; defaults to the cwd. */
  cwds?: readonly string[];
}

/**
 * Record trust for every Tacho hook Codex reports, then read the hooks back
 * to confirm. Never throws: a Codex that cannot be driven comes back as a
 * `problem` the caller reports as a warning, because a machine whose hooks
 * are installed but untrusted is worth enrolling and worth telling the user
 * about, not worth failing the enrollment over.
 */
export async function trustCodexHooks(
  options: CodexHookTrustOptions,
): Promise<CodexHookTrustResult> {
  const listParams = { cwds: options.cwds ?? [] };
  const listing = await listOxagenHooks(options);
  if (listing.problem !== undefined)
    return {
      ok: false,
      found: 0,
      recorded: [],
      pending: [],
      problem: listing.problem,
    };

  const ours = listing.hooks;
  if (ours.length === 0)
    return {
      ok: false,
      found: 0,
      recorded: [],
      pending: [],
      problem:
        "Codex reported none of Tacho's hooks; check that it is reading the hooks file Tacho wrote",
    };
  const missing = missingEvents(ours);
  if (missing.length > 0)
    return {
      ok: false,
      found: ours.length,
      recorded: [],
      pending: [],
      problem: `Codex is missing Tacho hooks for ${missing.join(", ")}`,
    };
  const needed = hooksNeedingTrust(ours);
  if (needed.length === 0) {
    const pending = ours
      .filter((hook) => hook.enabled !== true)
      .map((hook) => hook.key);
    return {
      ok: pending.length === 0,
      found: ours.length,
      recorded: [],
      pending,
      ...(pending.length === 0
        ? {}
        : {
            problem:
              "Codex has disabled Tacho hooks; open `/hooks` to review them",
          }),
    };
  }

  const wrote = await options.appServer([
    ...needed.map((hook) => ({
      method: CONFIG_WRITE,
      params: {
        keyPath: trustKeyPath(hook.key),
        mergeStrategy: "upsert",
        value: { trusted_hash: hook.currentHash },
      },
    })),
    { method: HOOKS_LIST, params: listParams },
  ]);
  const writeProblem =
    wrote.problem ??
    needed
      .map((_, index) =>
        answerProblem(wrote.answers[index] ?? {}, CONFIG_WRITE),
      )
      .find((problem) => problem !== undefined);
  if (writeProblem !== undefined)
    return {
      ok: false,
      found: ours.length,
      recorded: [],
      pending: needed.map((hook) => hook.key),
      problem: writeProblem,
    };

  // The re-read is the proof. A write Codex accepted but did not apply the
  // way this module expected would otherwise be reported as success, and the
  // symptom — hooks that never fire — is exactly the one being fixed.
  const rereadProblem = answerProblem(
    wrote.answers[needed.length] ?? {},
    HOOKS_LIST,
  );
  const after = ownedHooks(wrote.answers[needed.length]?.result, options);
  const byKey = new Map(after.map((hook) => [hook.key, hook]));
  const pending = ours
    .filter((before) => {
      const hook = byKey.get(before.key);
      return (
        hook === undefined ||
        hook.currentHash !== before.currentHash ||
        hook.enabled !== true ||
        (!hook.isManaged && hook.trustStatus !== "trusted")
      );
    })
    .map((hook) => hook.key);
  const recorded = needed
    .map((hook) => hook.key)
    .filter((key) => !pending.includes(key));
  if (rereadProblem !== undefined)
    return {
      ok: false,
      found: ours.length,
      recorded: [],
      pending: ours.map((hook) => hook.key),
      problem: rereadProblem,
    };
  return {
    ok: pending.length === 0,
    found: ours.length,
    recorded,
    pending,
    ...(pending.length === 0
      ? {}
      : {
          problem: `Codex still reports ${pending.length} of Tacho's hooks as untrusted after recording their hashes`,
        }),
  };
}

export interface CodexHookUntrustResult {
  /** Keys whose trust record was removed. */
  removed: string[];
  problem?: string;
}

/**
 * Remove the trust records `trustCodexHooks` wrote. Must run before the hooks
 * themselves are stripped from `hooks.json`: the keys come from Codex, and
 * Codex stops reporting a hook the moment its definition is gone.
 */
export async function untrustCodexHooks(
  options: CodexHookTrustOptions,
): Promise<CodexHookUntrustResult> {
  const listing = await listOxagenHooks(options);
  if (listing.problem !== undefined)
    return { removed: [], problem: listing.problem };

  const ours = listing.hooks.filter(
    (hook) => !hook.isManaged && hook.trustStatus !== "untrusted",
  );
  if (ours.length === 0) return { removed: [] };

  // `replace` with a null value deletes that one table and leaves every other
  // hook's record alone, which a `replace` of the whole `hooks.state` table
  // would not.
  const wrote = await options.appServer(
    ours.map((hook) => ({
      method: CONFIG_WRITE,
      params: {
        keyPath: trustKeyPath(hook.key),
        mergeStrategy: "replace",
        value: null,
      },
    })),
  );
  if (wrote.problem !== undefined)
    return { removed: [], problem: wrote.problem };
  const removed: string[] = [];
  let problem: string | undefined;
  ours.forEach((hook, index) => {
    const answer = wrote.answers[index] ?? {};
    const failed = answerProblem(answer, CONFIG_WRITE);
    if (failed === undefined) removed.push(hook.key);
    else problem ??= failed;
  });
  return problem === undefined ? { removed } : { removed, problem };
}
