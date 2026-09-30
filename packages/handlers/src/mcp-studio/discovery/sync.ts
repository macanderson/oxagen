// sync.ts: one discovery of one server, from the steering files to the sync
// steering PR (lane M10, #4682; mcp-studio-spec, Sync).
//
// runDiscovery reads server.toml, tools.toml, and tools.lock.json on the
// production branch, and compiles what the gateway serves now. It reads what
// the source offers, writes every tool to mcp.tool_snapshots, and compiles
// the same tools.toml against it with the served lock as the previous one.
// M4's diff compares the two sides. When an imported tool changed, or a
// registry server's catalog moved on, it opens one sync steering PR for the
// server with the new lock, and source.version for a registry server. A tool
// whose input schema changed, and a tool the new lock drops, stay withheld
// until that PR merges.
//
// The row in mcp.server_discoveries always ends succeeded or failed. A
// failure keeps the open PR and the withheld tools, and its message passes
// through the run's scrubber first.
import {
  CompileError,
  canonicalDigest,
  canonicalText,
  compile,
  diff,
  formatJson,
  lock,
  parseLock,
  parseServerToml,
  parseToolsToml,
  toManifestServer,
  type ManifestServer,
  type McpServer,
  type McpTools,
  type McpToolsLock,
  type ReadResult,
  type ToolSurfaceDiff,
  type UpstreamTool,
} from "@oxagen/mcp-studio";
import {
  serverFolderPath,
  serverTomlPath,
  toolsLockPath,
  toolsTomlPath,
} from "@oxagen/oxagen/steering-repo";
import {
  lockedSecuritySchemes,
  lockedUpstreamTools,
} from "@oxagen/steering-bundle";
import { logger } from "../../logger";
import {
  syncBody,
  syncCommitMessage,
  syncTitle,
  type DroppedTool,
  type SyncPullRequestText,
} from "./body";
import { createScrubber, scrubbedMessage, scrubValue, type Scrubber } from "./scrub";
import {
  discoverySeams,
  type DiscoverySeams,
  type SteeringCheckout,
  type ToolsPullRequestFile,
} from "./seams";
import {
  discover,
  NeedsDigest,
  servedDescriptorSet,
  snapshotsOf,
  type Discovered,
} from "./sources";
import {
  postgresDiscoveryStore,
  type DiscoveryFinish,
  type DiscoveryRow,
  type DiscoverySourceFields,
  type DiscoveryStore,
} from "./store";
import {
  DiscoveryRefused,
  RetriableDiscoveryFailure,
  type DiscoveryOutcome,
  type DiscoveryResult,
  type DiscoveryScope,
  type DiscoveryTrigger,
  type SyncSchedule,
  WaitingForMachine,
} from "./types";

/** How long one discovery may read its source before the run stops it. */
export const DISCOVERY_TIMEOUT_MS = 180_000;

export interface RunDiscoveryInput {
  scope: DiscoveryScope;
  /** The folder name under tools/servers/. */
  server: string;
  trigger: DiscoveryTrigger;
  /** The person who asked. A queued row keeps the last one who did. */
  requestedBy?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface RunDiscoveryDeps {
  store?: DiscoveryStore;
  seams?: DiscoverySeams;
}

type PullRequestRef = NonNullable<DiscoveryRow["pr"]>;

/** What the row keeps from the last run until this run learns better. */
interface Kept {
  pr: PullRequestRef | null;
  withheld: string[];
  digest: string | null;
  latestVersion: string | null;
  toolCount: number | null;
  machine: string | null;
  /** Set once the source is read: the upstream names it offered. */
  offered?: string[];
  /** Set once the surface is compared: withheld, by upstream name. */
  withheldUpstream?: string[];
}

interface Run {
  scope: DiscoveryScope;
  server: string;
  trigger: DiscoveryTrigger;
  requestedBy: string | undefined;
  prior: DiscoveryRow | null;
  seams: DiscoverySeams;
  store: DiscoveryStore;
  scrubber: Scrubber;
  signal: AbortSignal;
  kept: Kept;
}

/** The three files of a server folder, parsed. */
export interface ServerFiles {
  parsed: McpServer;
  serverText: string;
  tools: McpTools;
  lock: McpToolsLock;
}

/** What the steering PR proposes. */
interface Proposed {
  lock: McpToolsLock;
  server: ManifestServer;
  dropped: DroppedTool[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── The schedule ─────────────────────────────────────────────────────────────

/**
 * Whether a trigger runs for a server's sync.schedule:
 *
 * - schedule: a daily server, and any server but a manual one that has
 *   never finished a discovery with its mcp.servers row live, so a new
 *   server's tools are found and snapshotted once.
 * - push: an on-change server.
 * - list_changed and registry_version: any server but a manual one.
 * - manual and lock_merged: always.
 */
export function scheduleAllows(
  trigger: DiscoveryTrigger,
  schedule: SyncSchedule,
  everFinished: boolean,
): boolean {
  switch (trigger) {
    case "manual":
    case "lock_merged":
      return true;
    case "push":
      return schedule === "on-change";
    case "list_changed":
    case "registry_version":
      return schedule !== "manual";
    case "schedule":
      return schedule === "daily" || (schedule !== "manual" && !everFinished);
  }
}

/**
 * Whether a discovery of this server ever finished, which is what decides
 * whether an on-change server has already spent the one scheduled discovery it
 * gets before its first push.
 *
 * A failed attempt discovered nothing, so it does not count. runDiscovery
 * records a retriable failure on the row, finishedAt and all, before it throws
 * RetriableDiscoveryFailure, so counting that row would make the Inngest retry
 * read its own failure as the discovery it is retrying: scheduleAllows would
 * answer false, the retry would record skipped without contacting the source,
 * and the row would be neither stalled nor picked up by the daily sweep.
 *
 * A run that finished before the server's mcp.servers row existed does not
 * count either. It recorded the offered names, but it had no mcpServerId to
 * write tool snapshots under, so list_studio_tools has no tools to show. The
 * hourly sweep sends such a server a scheduled discovery once its row is live,
 * and this answer lets that discovery run.
 */
export function everFinished(
  prior: Pick<DiscoveryRow, "status" | "finishedAt" | "mcpServerId"> | null,
): boolean {
  if (prior === null || prior.status === "failed") return false;
  if (prior.mcpServerId === null) return false;
  return prior.finishedAt !== null;
}

// ── Steering files ───────────────────────────────────────────────────────────

function parsedFile<T>(path: string, result: ReadResult<T>): T {
  if (!result.ok) {
    const issues = result.issues.map((issue) => issue.message).join("; ");
    throw new DiscoveryRefused("server_file", `${path} does not parse: ${issues}`);
  }
  return result.value;
}

/**
 * server.toml, tools.toml, and tools.lock.json for one server at the
 * checkout's commit, parsed. Refuses a folder that lacks one or does not
 * parse.
 */
export async function readServerFiles(
  checkout: SteeringCheckout,
  server: string,
): Promise<ServerFiles> {
  const paths = {
    server: serverTomlPath(server),
    tools: toolsTomlPath(server),
    lock: toolsLockPath(server),
  };
  const [serverText, toolsText, lockText] = await Promise.all([
    checkout.read(paths.server),
    checkout.read(paths.tools),
    checkout.read(paths.lock),
  ]);
  if (serverText === null) {
    throw new DiscoveryRefused(
      "no_server",
      `${paths.server} is not on the production branch.`,
    );
  }
  for (const [path, text] of [
    [paths.tools, toolsText],
    [paths.lock, lockText],
  ] as const) {
    if (text === null) {
      throw new DiscoveryRefused(
        "server_file",
        `${path} is not on the production branch. Import the server in Studio to write it.`,
      );
    }
  }
  const parsed = parsedFile(paths.server, parseServerToml(serverText));
  if (parsed.name !== server) {
    throw new DiscoveryRefused(
      "server_file",
      `${paths.server} names the server ${parsed.name}, and its folder is ${server}.`,
    );
  }
  return {
    parsed,
    serverText,
    tools: parsedFile(paths.tools, parseToolsToml(toolsText ?? "")),
    lock: parsedFile(paths.lock, parseLock(lockText ?? "")),
  };
}

/**
 * The source fields the push webhook matches on, and the registry name and
 * version the hourly sweep compares with the synced catalog.
 */
export function sourceFields(
  parsed: McpServer,
  mcpServerId: string | null,
): DiscoverySourceFields {
  const source = parsed.source;
  const linked =
    (source.type === "openapi" ||
      source.type === "graphql" ||
      source.type === "grpc") &&
    source.from === "repository";
  const registry = source.type === "registry" ? source : null;
  return {
    kind: source.type,
    repo: linked ? (source.repo?.toLowerCase() ?? null) : null,
    path: linked ? (source.path ?? null) : null,
    ref: linked ? (source.ref ?? null) : null,
    schedule: parsed.sync.schedule,
    mcpServerId,
    registryName: registry?.server ?? null,
    version: registry?.version ?? null,
  };
}

// ── The sync PR ──────────────────────────────────────────────────────────────

/**
 * Where the open sync PR stands. A merged one clears what it carried, and
 * the checkout is read again so the run compares against the merged lock. A
 * closed one keeps its digest, so the same change is not proposed again
 * until a person asks.
 */
async function resolvePullRequest(
  run: Run,
  checkout: SteeringCheckout,
): Promise<{
  open: PullRequestRef | null;
  /** The head of the open PR's branch, which a commit onto it is pinned to. */
  head: string | null;
  checkout: SteeringCheckout;
}> {
  const pr = run.kept.pr;
  if (pr === null) return { open: null, head: null, checkout };
  const state = await checkout.pullRequest(pr.number);
  if (state.open) return { open: pr, head: state.headSha, checkout };
  run.kept.pr = null;
  if (!state.merged) return { open: null, head: null, checkout };
  run.kept.digest = null;
  run.kept.withheld = [];
  run.kept.withheldUpstream = [];
  return {
    open: null,
    head: null,
    checkout: await run.seams.steering.open(run.scope),
  };
}

/** "20260928t150012", for a branch name. */
function branchStamp(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}t${iso.slice(11, 19).replaceAll(":", "")}`;
}

const SOURCE_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;
const VERSION_LINE =
  /^(\s*version\s*=\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*')(\s*(?:#.*)?)$/;

/**
 * server.toml with source.version moved to `to`. It edits one line of the
 * [source] table and parses the result back, so a file it cannot edit that
 * way is refused rather than rewritten.
 */
export function moveSourceVersion(
  server: string,
  text: string,
  parsed: McpServer,
  to: string,
): string {
  const refused = new DiscoveryRefused(
    "server_file",
    `Discovery could not move source.version in ${serverTomlPath(server)} to ${to}. Import the new version in Studio.`,
  );
  if (parsed.source.type !== "registry") throw refused;
  const from = parsed.source.version;
  const lines = text.split("\n");
  let table: string | undefined;
  let at = -1;
  for (const [index, line] of lines.entries()) {
    const header = SOURCE_HEADER.exec(line);
    if (header !== null) {
      table = header[1];
      continue;
    }
    if (table === "source" && VERSION_LINE.test(line)) {
      at = index;
      break;
    }
  }
  if (at < 0) throw refused;
  lines[at] = (lines[at] ?? "").replace(
    VERSION_LINE,
    (_match, head: string, tail: string) => `${head}${JSON.stringify(to)}${tail}`,
  );
  const next = lines.join("\n");
  const reread = parseServerToml(next);
  if (
    !reread.ok ||
    reread.value.source.type !== "registry" ||
    reread.value.source.version !== to ||
    canonicalText({
      ...reread.value,
      source: { ...reread.value.source, version: from },
    }) !== canonicalText(parsed)
  ) {
    throw refused;
  }
  return next;
}

// ── Compiling ────────────────────────────────────────────────────────────────

/**
 * What the gateway serves now, compiled from the production branch. A gRPC
 * server passes the descriptor set its proto/ files give.
 */
function compileServed(
  server: string,
  files: ServerFiles,
  descriptorSet: Uint8Array | undefined,
): ManifestServer {
  try {
    const compiled = compile({
      server: files.parsed,
      tools: files.tools,
      upstream: lockedUpstreamTools(files.lock),
      security_schemes: lockedSecuritySchemes(files.lock),
      descriptor_set: descriptorSet,
    });
    return toManifestServer(compiled, files.lock);
  } catch (error) {
    throw new DiscoveryRefused(
      "server_file",
      `${serverFolderPath(server)} does not compile on the production branch: ${messageOf(error)}`,
    );
  }
}

/** The tools.toml keys a CompileError blames, or null when it blames the server. */
function blamedKeys(
  error: unknown,
  tools: McpTools,
): Map<string, string[]> | null {
  if (!(error instanceof CompileError)) return null;
  const entries = tools.tools ?? {};
  const out = new Map<string, string[]>();
  for (const issue of error.issues) {
    if (issue.tool === undefined || !Object.hasOwn(entries, issue.tool)) {
      return null;
    }
    const prefix = `${issue.tool}: `;
    const reason = issue.message.startsWith(prefix)
      ? issue.message.slice(prefix.length)
      : issue.message;
    out.set(issue.tool, [...(out.get(issue.tool) ?? []), reason]);
  }
  return out.size > 0 ? out : null;
}

function withoutTools(tools: McpTools, keys: ReadonlySet<string>): McpTools {
  const entries = Object.entries(tools.tools ?? {}).filter(
    ([key]) => !keys.has(key),
  );
  return { ...tools, tools: Object.fromEntries(entries) };
}

/**
 * The lock and manifest entry the steering PR proposes: the same tools.toml
 * compiled against what the source offers now. An entry that no longer
 * compiles is left out and reported, and the diff lists it as removed.
 */
function propose(
  server: string,
  files: ServerFiles,
  parsed: McpServer,
  offered: readonly UpstreamTool[],
  discovered: Discovered,
): Proposed {
  let tools = files.tools;
  const dropped: DroppedTool[] = [];
  for (;;) {
    let compiled: ReturnType<typeof compile>;
    try {
      compiled = compile({
        server: parsed,
        tools,
        upstream: offered,
        security_schemes: discovered.securitySchemes,
        descriptor_set: discovered.descriptorSet,
      });
    } catch (error) {
      const blamed = blamedKeys(error, tools);
      if (blamed === null) {
        throw new DiscoveryRefused(
          "source",
          `The tools the source of ${server} offers now do not compile: ${messageOf(error)}`,
        );
      }
      for (const [key, reasons] of blamed) dropped.push({ key, reasons });
      tools = withoutTools(tools, new Set(blamed.keys()));
      continue;
    }
    try {
      const next = lock({
        compiled,
        source: discovered.lockSource,
        previous: files.lock,
      });
      return { lock: next, server: toManifestServer(compiled, next), dropped };
    } catch (error) {
      throw new DiscoveryRefused(
        "source",
        `The new lock for ${server} could not be written: ${messageOf(error)}`,
      );
    }
  }
}

/**
 * The full names the gateway withholds: an imported tool whose input schema
 * changed or that M4 marks breaking, and one the new lock drops.
 */
export function withheldTools(
  surface: ToolSurfaceDiff,
  served: ManifestServer,
  proposed: ManifestServer,
): string[] {
  const out = new Set<string>();
  for (const entry of surface.entries) {
    if (entry.change === "removed") out.add(entry.tool);
    if (entry.change !== "changed") continue;
    const before = served.tools[entry.key]?.definition.inputSchema ?? {};
    const after = proposed.tools[entry.key]?.definition.inputSchema ?? {};
    if (
      entry.breaking.length > 0 ||
      canonicalDigest(before) !== canonicalDigest(after)
    ) {
      out.add(entry.tool);
    }
  }
  return [...out].sort();
}

/**
 * The upstream names behind the withheld full names, as mcp.tool_snapshots
 * names them. A key maps to its upstream name through the served lock, the
 * proposed lock, or both when the upstream renamed the tool.
 */
export function withheldUpstream(
  surface: ToolSurfaceDiff,
  withheld: readonly string[],
  served: McpToolsLock,
  proposed: McpToolsLock,
): string[] {
  const held = new Set(withheld);
  const out = new Set<string>();
  for (const entry of surface.entries) {
    if (entry.change === "offered" || !held.has(entry.tool)) continue;
    for (const lock of [served, proposed]) {
      const name = lock.tools[entry.key]?.upstream.name;
      if (name !== undefined) out.add(name);
    }
  }
  return [...out].sort();
}

// ── One run ──────────────────────────────────────────────────────────────────

function finished(kept: Kept, outcome: DiscoveryOutcome): DiscoveryFinish {
  return {
    status: "succeeded",
    outcome,
    error: null,
    toolCount: kept.toolCount,
    machine: kept.machine,
    upstreamDigest: kept.digest,
    latestVersion: kept.latestVersion,
    pr: kept.pr,
    withheld: kept.withheld,
    ...(kept.offered === undefined ? {} : { offered: kept.offered }),
    ...(kept.withheldUpstream === undefined
      ? {}
      : { withheldUpstream: kept.withheldUpstream }),
  };
}

async function openPullRequest(
  run: Run,
  input: {
    text: SyncPullRequestText;
    files: ToolsPullRequestFile[];
    open: PullRequestRef | null;
    /** The production commit every file was built from. */
    commit: string;
    /** The head of the open PR's branch, when there is one and the host told us. */
    head: string | null;
  },
): Promise<PullRequestRef> {
  const scrub = (text: string) => run.scrubber.scrub(text);
  const at = run.seams.now();
  // Each write is pinned to the commit its own guard is about. A new branch
  // starts at the production commit the files were read from, so a commit that
  // merged since is not reverted by a whole-file write. A commit onto an open
  // PR is pinned to that branch's head, so the opener refuses it when the
  // branch moved. A host that did not tell us the head sends no pin, which is
  // what every call did before.
  const pin = input.open === null ? input.commit : input.head;
  try {
    const pr = await run.seams.opener.open(run.scope, {
      branch: input.open?.branch ?? `tools/sync-${run.server}-${branchStamp(at)}`,
      title: scrub(syncTitle(input.text)),
      body: scrub(syncBody(input.text)),
      commitMessage: scrub(syncCommitMessage(input.text)),
      files: input.files.map((file) => ({
        path: file.path,
        content: file.content === null ? null : scrub(file.content),
      })),
      ...(input.open === null ? {} : { existing: { number: input.open.number } }),
      ...(pin === null ? {} : { at: pin }),
    });
    return { number: pr.number, url: pr.url, branch: pr.branch };
  } catch (error) {
    if (error instanceof DiscoveryRefused) throw error;
    // The code host may be down, so a retry can open it.
    throw new DiscoveryRefused(
      "opener",
      `The sync steering PR for ${run.server} did not open: ${messageOf(error)}`,
      { retriable: true },
    );
  }
}

async function sync(run: Run): Promise<DiscoveryFinish> {
  const { scope, server, seams, store, kept } = run;

  const resolved = await resolvePullRequest(
    run,
    await seams.steering.open(scope),
  );
  if (resolved.open !== null && run.trigger === "lock_merged") {
    return finished(kept, "skipped");
  }
  const checkout = resolved.checkout;

  const files = await readServerFiles(checkout, server);
  const mcpServerId = await store.steeringServerId(scope, server);
  await store.recordSource(
    scope,
    server,
    sourceFields(files.parsed, mcpServerId),
    seams.now(),
  );
  if (
    !scheduleAllows(
      run.trigger,
      files.parsed.sync.schedule,
      everFinished(run.prior ?? null),
    )
  ) {
    return finished(kept, "skipped");
  }

  // compile() refuses a gRPC server without its descriptor set, which the
  // folder's proto/ files give through lane M3's importer.
  const servedDescriptors =
    files.parsed.source.type === "grpc"
      ? await servedDescriptorSet(checkout, server, seams.grpc)
      : undefined;
  const served = compileServed(server, files, servedDescriptors);

  const discovered = await discover({
    scope,
    server,
    trigger: run.trigger,
    requestedBy: run.requestedBy,
    parsed: files.parsed,
    served,
    servedLock: files.lock,
    checkout,
    seams,
    scrubber: run.scrubber,
    signal: run.signal,
  });
  const offered = scrubValue(run.scrubber, discovered.offered);
  kept.toolCount = offered.length;
  kept.offered = offered.map((tool) => tool.name);
  kept.machine = discovered.machine;
  kept.latestVersion = discovered.latestVersion ?? kept.latestVersion;
  if (mcpServerId !== null) {
    await store.captureSnapshots(scope, mcpServerId, snapshotsOf(offered));
  }

  const source = files.parsed.source;
  const version =
    discovered.version !== undefined && source.type === "registry"
      ? { from: source.version, to: discovered.version }
      : undefined;
  const parsed: McpServer =
    version === undefined || source.type !== "registry"
      ? files.parsed
      : { ...files.parsed, source: { ...source, version: version.to } };
  const proposed = propose(server, files, parsed, offered, discovered);
  const surface = diff({
    served: { lock: files.lock, server: served },
    proposed: { lock: proposed.lock, server: proposed.server },
    offered,
  });
  kept.withheld = withheldTools(surface, served, proposed.server);
  kept.withheldUpstream = withheldUpstream(
    surface,
    kept.withheld,
    files.lock,
    proposed.lock,
  );

  const changed =
    version !== undefined ||
    surface.entries.some((entry) => entry.change !== "offered");
  if (!changed) return finished(kept, "unchanged");

  const digest = canonicalDigest({
    tools: proposed.lock.tools,
    version: version?.to ?? null,
  });
  if (
    digest === kept.digest &&
    (resolved.open !== null || run.trigger !== "manual")
  ) {
    return finished(kept, "skipped");
  }

  const folder = serverFolderPath(server);
  const writes: ToolsPullRequestFile[] = [
    { path: toolsLockPath(server), content: formatJson(proposed.lock) },
  ];
  if (version !== undefined) {
    writes.push({
      path: serverTomlPath(server),
      content: moveSourceVersion(server, files.serverText, files.parsed, version.to),
    });
  }
  for (const file of discovered.files) {
    writes.push({ path: `${folder}/${file.path}`, content: file.text });
  }

  kept.pr = await openPullRequest(run, {
    text: {
      server,
      label: files.parsed.label,
      sourceType: source.type,
      origin: discovered.origin,
      diff: surface,
      withheld: kept.withheld,
      dropped: proposed.dropped,
      version,
      trigger: run.trigger,
      at: seams.now(),
      machine: discovered.machine,
    },
    files: writes,
    open: resolved.open,
    commit: checkout.commit,
    head: resolved.head,
  });
  kept.digest = digest;
  return finished(kept, resolved.open === null ? "pr_opened" : "pr_updated");
}

function failure(run: Run, error: unknown): DiscoveryFinish {
  if (error instanceof NeedsDigest) {
    return { ...finished(run.kept, "needs_digest"), latestVersion: error.latestVersion };
  }
  // No failure: the MCP process a machine in these groups polls runs it.
  if (error instanceof WaitingForMachine) {
    return {
      ...finished(run.kept, "skipped"),
      status: "waiting_for_machine",
      outcome: null,
      machineGroups: error.groups,
    };
  }
  return {
    ...finished(run.kept, "skipped"),
    status: "failed",
    outcome: null,
    error: scrubbedMessage(run.scrubber, error),
  };
}

/**
 * An error that can pass: one discovery did not expect, or a refusal marked
 * retriable, such as an outage at the source or at the code host.
 */
function retriable(error: unknown): boolean {
  return !(error instanceof DiscoveryRefused) || error.retriable;
}

/**
 * Discover one server's tools, record them, and open or update its sync
 * steering PR when an imported tool changed. A refusal that retrying cannot
 * fix resolves: the row and the result say what happened. Any other failure
 * is recorded on the row, then thrown as a RetriableDiscoveryFailure, so the
 * durable function retries it.
 */
export async function runDiscovery(
  input: RunDiscoveryInput,
  deps: RunDiscoveryDeps = {},
): Promise<DiscoveryResult> {
  const seams = deps.seams ?? (await discoverySeams());
  const store = deps.store ?? postgresDiscoveryStore;
  const { scope, server, trigger } = input;
  const prior = await store.begin(
    scope,
    server,
    trigger,
    input.requestedBy ?? null,
    seams.now(),
  );
  const run: Run = {
    scope,
    server,
    trigger,
    requestedBy: input.requestedBy ?? prior?.requestedBy ?? undefined,
    prior,
    seams,
    store,
    scrubber: createScrubber(),
    signal: input.signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    kept: {
      pr: prior?.pr ?? null,
      withheld: prior?.withheld ?? [],
      digest: prior?.upstreamDigest ?? null,
      latestVersion: prior?.latestVersion ?? null,
      toolCount: prior?.toolCount ?? null,
      machine: prior?.machine ?? null,
    },
  };

  let finish: DiscoveryFinish;
  let retry = false;
  try {
    finish = await sync(run);
  } catch (error) {
    finish = failure(run, error);
    retry = retriable(error);
    const fields = {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      server,
      trigger,
      error: finish.error,
    };
    if (error instanceof DiscoveryRefused) {
      logger.warn({ ...fields, code: error.code }, "MCP discovery refused");
    } else {
      logger.error(fields, "MCP discovery failed");
    }
  }
  await store.finish(scope, server, finish, seams.now());
  if (retry) {
    throw new RetriableDiscoveryFailure(
      `MCP discovery of ${server} failed: ${finish.error ?? "no reason given"}`,
    );
  }
  return {
    server,
    status: finish.status,
    outcome: finish.outcome,
    toolCount: finish.toolCount,
    withheld: finish.withheld,
    pr: finish.pr,
    error: finish.error,
  };
}
