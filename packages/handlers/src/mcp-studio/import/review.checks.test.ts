// review.checks.test.ts: a folder Studio's Review writes passes the steering
// checks its steering PR runs (#5139).
//
// The MCP Studio live test's first run against production opened a Review PR
// for each sample server, and the "Oxagen steering" check failed on each one.
// The owned check refused the tools.lock.json that Review writes, and no test
// had run a Review folder through the real checks. Each case here drafts a
// server the way the live rig does (apps/app/live/mcp-studio-rig.ts), builds
// its folder, adds the folder to the steering repo fixture, and runs the
// checks Oxagen reports on the PR.
//
// The second run got past Review and stopped at the merges. The first Review
// PR merged. The next Review PR, and then the agent file PR that enrollment
// opened, were refused checks_failed. The merge ran the checks on each head
// against the production head, and each branch was cut before the first
// merge, so the owned check read that merge's lock and ledger line as files
// the PR removed and rewrote. The last block here opens the PRs in the live
// order and merges each one through merge_steering_pr with the real checks.
import { readFileSync } from "node:fs";
import type { StudioDraftOp, StudioSource } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { fixtureContext, fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import type { CheckContext } from "@oxagen/steering-check";
import { runChecksWithServers } from "@oxagen/steering-check/servers";
import { describe, expect, it } from "vitest";
import { checkSteeringChange, steeringTreeHost } from "../../context.steering.checks";
import { AUTHOR, REPO, REVIEWER, ctx, harness, type Harness } from "../../context.steering.test-support";
import { AGENT_FILE_PULL_REQUEST, openAgentFilePr } from "../../steering-repo/agent-file";
import { personAuthor } from "../../steering-repo/pr-proposal";
import { createMergeSteeringPrHandler, type MergeSeams } from "../../steering.pr.merge";
import { createSteeringPullRequestOpener, TOOLS_PULL_REQUEST, type ToolsPullRequestDeps } from "../../tools.pr.open";
import { buildFolder, folderCommit } from "./build";
import { importSource } from "./source";

/** A file under packages/mcp-studio/fixtures. */
function fixture(path: string): string {
  return readFileSync(new URL(`../../../../mcp-studio/fixtures/${path}`, import.meta.url), "utf8");
}

/** The workspace credential that holds the sample upstreams' token. */
const CREDENTIAL = "mcp-live-upstream";
/** Where the live rig's tunnel serves the sample upstreams. */
const UPSTREAM = "https://sample-upstreams.example";
const RELAY = "mcp-live-5139-1";

type Classification = Omit<Extract<StudioDraftOp, { kind: "classify" }>, "kind" | "tool">;

interface LiveServer {
  folder: string;
  kind: "mcp" | "openapi" | "graphql" | "grpc";
  source: StudioSource;
  tools: { name: string; classification: Classification; description?: string }[];
}

const toml = (value: string): string => JSON.stringify(value);

/** server.toml as the live rig writes it. */
function serverToml(server: LiveServer): string {
  const head = [
    "#:schema https://oxagen.sh/schemas/mcp-server/v1.json",
    'schema = "mcp-server/v1"',
    `name = ${toml(server.folder)}`,
    `label = ${toml(`Live ${server.kind} sample`)}`,
    `description = ${toml(`The sample ${server.kind} server the MCP Studio live test imports.`)}`,
    "",
  ];
  const bearer = ["[auth]", 'mode = "service"', 'scheme = "bearer"', `credential = ${toml(`oxagen:credential/${CREDENTIAL}`)}`, ""];
  const tail = ["[exposure]", 'mode = "direct"', "", "[sync]", 'schedule = "manual"', ""];
  switch (server.kind) {
    case "mcp":
      return [...head, "[source]", 'type = "remote"', `url = ${toml(`${UPSTREAM}/mcp`)}`, 'transport = "http"', "", ...bearer, ...tail].join("\n");
    case "openapi":
    case "graphql":
      return [
        ...head,
        "[source]",
        `type = ${toml(server.kind)}`,
        'from = "upload"',
        "",
        ...bearer,
        "[environments.sandbox]",
        `url = ${toml(`${UPSTREAM}/${server.kind}`)}`,
        "",
        ...tail,
      ].join("\n");
    case "grpc":
      return [
        ...head,
        "[source]",
        'type = "grpc"',
        'from = "upload"',
        "",
        "[auth]",
        'mode = "none"',
        "",
        "[environments.sandbox]",
        'url = "http://127.0.0.1:50051"',
        `network = ${toml(`relay:${RELAY}`)}`,
        "",
        ...tail,
      ].join("\n");
  }
}

/** The draft's edits, as the live rig's draftOps makes them. */
function draftOps(server: LiveServer): StudioDraftOp[] {
  return server.tools.flatMap((tool): StudioDraftOp[] => [
    { kind: "import", tool: tool.name },
    { kind: "classify", tool: tool.name, ...tool.classification },
    ...(tool.description === undefined ? [] : [{ kind: "describe" as const, tool: tool.name, description: tool.description }]),
  ]);
}

const READ_THIRD_PARTY: Classification = { risk: "low", sideEffect: "read", egress: "third_party", impacts: [] };
const WRITE_THIRD_PARTY: Classification = { risk: "medium", sideEffect: "write", egress: "third_party", impacts: [] };

/** The four sample servers the live suite imports, with the same tools and classifications. */
const SERVERS: readonly LiveServer[] = [
  {
    folder: "live_mcp",
    kind: "mcp",
    source: {
      type: "mcp",
      lockSource: { type: "remote", url: `${UPSTREAM}/mcp`, server_version: "1" },
      tools: (JSON.parse(fixture("mcp/tools-list.json")) as { tools: Record<string, unknown>[] }).tools,
    },
    tools: [
      { name: "list_repositories", classification: READ_THIRD_PARTY },
      { name: "create_issue", classification: WRITE_THIRD_PARTY },
    ],
  },
  {
    folder: "live_payments",
    kind: "openapi",
    source: {
      type: "openapi",
      files: [{ path: "openapi.yaml", text: fixture("openapi/openapi-3.1.yaml") }],
      entry: "openapi.yaml",
    },
    tools: [
      { name: "get_payment", classification: READ_THIRD_PARTY },
      {
        name: "create_payment",
        classification: { risk: "high", sideEffect: "irreversible", egress: "third_party", impacts: ["moves_money"] },
      },
    ],
  },
  {
    folder: "live_desk",
    kind: "graphql",
    source: { type: "graphql", sdl: fixture("graphql/schema.graphql") },
    tools: [
      { name: "issue", classification: READ_THIRD_PARTY },
      {
        name: "create_issue",
        classification: WRITE_THIRD_PARTY,
        description: "Open an issue in the support desk. Give it a title, and optionally a body, a priority, an assignee, and labels.",
      },
    ],
  },
  {
    folder: "live_ledger",
    kind: "grpc",
    source: { type: "grpc", files: [{ path: "proto/ledger.proto", text: fixture("grpc/ledger.proto") }] },
    tools: [
      { name: "get_entry", classification: { risk: "low", sideEffect: "read", egress: "org_tenant", impacts: [] } },
      { name: "post_entry", classification: { risk: "medium", sideEffect: "write", egress: "org_tenant", impacts: [] } },
    ],
  },
];

/** The folder Review writes for a server production does not have yet. */
async function reviewed(server: LiveServer) {
  return buildFolder({
    draft: { server: server.folder, ops: draftOps(server), serverToml: serverToml(server), source: server.source },
    imported: await importSource(server.source),
    production: new Map(),
    credentials: new Set([`oxagen:credential/${CREDENTIAL}`]),
  });
}

/** The steering checks on a PR that adds the folder to the fixture repo. */
async function checksOn(server: LiveServer, files: ReadonlyMap<string, string>) {
  const head = new Map(fixtureRepo());
  for (const [path, text] of files) head.set(`tools/servers/${server.folder}/${path}`, text);
  const { runtimes, members, teams, groups, credentials } = fixtureContext();
  return runChecksWithServers({
    files: head,
    base: fixtureRepo(),
    index: null,
    context: { runtimes, members, teams, groups, credentials: [...credentials, CREDENTIAL] },
    health: null,
  });
}

describe("a folder Studio's Review writes", () => {
  it.each(SERVERS.map((server): [string, LiveServer] => [server.folder, server]))(
    "%s passes the tool checks and the steering checks",
    async (_folder, server) => {
      const folder = await reviewed(server);
      expect([...folder.imported].sort()).toEqual(server.tools.map((tool) => tool.name).sort());
      expect(folder.findings.filter((finding) => finding.level === "error")).toEqual([]);
      expect([...folder.files.keys()]).toContain("tools.lock.json");

      const report = await checksOn(server, folder.files);
      expect(report.findings.filter((finding) => finding.severity === "error")).toEqual([]);
      expect(report.passed).toBe(true);
    },
  );

  it("fails the owned check when a person raises a version in the lock Review wrote", async () => {
    const server = SERVERS[0] as LiveServer;
    const folder = await reviewed(server);
    const lock = folder.files.get("tools.lock.json") ?? "";
    const files = new Map(folder.files).set("tools.lock.json", lock.replace('"version": 1', '"version": 2'));

    const report = await checksOn(server, files);
    expect(report.passed).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        check: "owned",
        rule: "oxagen-writes",
        path: "tools/servers/live_mcp/tools.lock.json",
      }),
    );
  });

  it("fails the tool checks on a GraphQL mutation the source left undescribed", async () => {
    const desk = SERVERS[2] as LiveServer;
    const undescribed = { ...desk, tools: desk.tools.map(({ name, classification }) => ({ name, classification })) };
    const folder = await reviewed(undescribed);
    expect(folder.findings).toContainEqual(
      expect.objectContaining({ rule: "no_description", level: "error", tool: "create_issue" }),
    );
  });
});

describe("a steering PR that merges after another one merged (#5139)", () => {
  /** The runtime the live rig's host enrolls, which the agent file names. */
  const RUNTIME = "mcp-live-1";
  /** The member who enrolls the host: the author of every PR here. */
  const OPERATOR = { userId: AUTHOR, publicId: "usr_01k5qk7d0000000000000000" };
  const SCOPE = { orgId: ctx().orgId, workspaceId: ctx().workspaceId };

  /** What Oxagen knows outside the repository: the fixture's, plus the run's runtime, operator, and credential. */
  function context(): CheckContext {
    const known = fixtureContext();
    return {
      runtimes: [...known.runtimes, RUNTIME],
      members: [...known.members, OPERATOR.publicId],
      teams: known.teams,
      groups: known.groups,
      credentials: [...known.credentials, CREDENTIAL],
    };
  }

  /** The fixture steering repo on main, with a clock after its ledger. */
  function steeringHarness(): Harness {
    const seed: Record<string, string> = {};
    for (const [path, text] of fixtureRepo()) seed[`main:${path}`] = text;
    const h = harness(seed);
    let t = Date.parse("2026-09-26T12:00:00.000Z");
    const clock = () => new Date((t += 1000));
    h.github.clock = clock;
    h.now = clock;
    return h;
  }

  function openerDeps(h: Harness): ToolsPullRequestDeps {
    return {
      host: () => h.github,
      readIndex: async () => null,
      readContext: async () => context(),
      proposals: h.store,
      now: h.now,
    };
  }

  /** One run of the steering checks during a merge: the head, and the commit it was compared with. */
  interface Checked {
    head: string;
    base: string;
  }

  /** Merge seams that run the real steering checks, as production does, and record each run. */
  function realChecks(checked: Checked[]): MergeSeams {
    return {
      readHealth: async () => "healthy",
      steeringCheck: async (_scope, host, repo, head, base) => {
        checked.push({ head, base });
        return checkSteeringChange({
          host: steeringTreeHost(host, repo),
          head,
          base,
          index: null,
          context: context(),
          health: null,
        });
      },
    };
  }

  /** The proposal row the opener wrote for PR `number`. */
  function proposalFor(h: Harness, number: number): string {
    const row = h.store.proposals.find((p) => p.prNumber === number);
    if (!row) throw new Error(`no proposal row for #${String(number)}`);
    return row.publicId;
  }

  /** The "Oxagen steering" check the opener reported on `head`, which must have passed. */
  function expectOpenedGreen(h: Harness, head: string): void {
    const run = h.github.checkRuns.find((r) => r.name === "Oxagen steering" && r.headSha === head);
    expect(run?.conclusion, run?.summary ?? `no check on ${head}`).toBe("success");
  }

  /** Opens the Review PR for a server on tools/<folder>, as Studio's Review does. */
  async function openReview(h: Harness, server: LiveServer, edit?: (files: Map<string, string>) => void) {
    const folder = await reviewed(server);
    const files = new Map(folder.files);
    edit?.(files);
    const opened = await createSteeringPullRequestOpener(openerDeps(h), TOOLS_PULL_REQUEST).open(SCOPE, {
      branch: `tools/${server.folder}`,
      title: `Import the ${server.folder} server`,
      body: "",
      commitMessage: `Import the ${server.folder} server`,
      files: folderCommit(server.folder, files, new Map()),
      author: personAuthor(OPERATOR.userId),
    });
    return { ...opened, proposalId: proposalFor(h, opened.number) };
  }

  function merge(h: Harness, checked: Checked[], proposalId: string) {
    return createMergeSteeringPrHandler(h, realChecks(checked))({ proposalId }, ctx({ userId: REVIEWER }));
  }

  it("merges the second Review PR after the first, checking it against the commit both branches started from", async () => {
    const h = steeringHarness();
    const start = h.github.heads.get(REPO.defaultBranch) as string;
    const first = await openReview(h, SERVERS[0] as LiveServer);
    const second = await openReview(h, SERVERS[1] as LiveServer);
    expectOpenedGreen(h, first.headSha);
    expectOpenedGreen(h, second.headSha);

    const checked: Checked[] = [];
    await merge(h, checked, first.proposalId);
    const afterFirst = h.github.heads.get(REPO.defaultBranch) as string;
    expect(checked).toEqual([{ head: first.headSha, base: start }]);

    // What the merge did before the fix: the second head against the
    // production head. The branch lacks the first server's lock and the
    // ledger line the first merge's stamp wrote.
    const stale = await checkSteeringChange({
      host: steeringTreeHost(h.github, REPO),
      head: second.headSha,
      base: afterFirst,
      index: null,
      context: context(),
      health: null,
    });
    expect(stale.passed).toBe(false);
    expect(stale.findings).toContainEqual(
      expect.objectContaining({
        check: "owned",
        rule: "oxagen-writes",
        path: "tools/servers/live_mcp/tools.lock.json",
        message: expect.stringContaining("This steering PR removes"),
      }),
    );
    expect(stale.findings).toContainEqual(
      expect.objectContaining({ check: "owned", path: expect.stringMatching(/^steering\/promotions\//) }),
    );

    checked.length = 0;
    const out = await merge(h, checked, second.proposalId);

    expect(out).toMatchObject({ status: "merged", kind: "tools", pullRequest: { number: second.number } });
    // Once against the commit the branch started from, then, after the queue
    // brought the branch up to date, against the production head it now holds.
    const update = h.github.updates.find((u) => u.branch === "tools/live_payments");
    expect(update).toBeDefined();
    expect(checked).toEqual([
      { head: second.headSha, base: start },
      { head: update?.to, base: afterFirst },
    ]);
    for (const server of [SERVERS[0], SERVERS[1]] as LiveServer[]) {
      expect(await h.github.readFile(REPO, `tools/servers/${server.folder}/tools.lock.json`, "main")).not.toBeNull();
    }
  });

  it("merges the agent file PR enrollment opened after a Review PR merged", async () => {
    const h = steeringHarness();
    const agent = await openAgentFilePr(
      {
        opener: createSteeringPullRequestOpener(openerDeps(h), AGENT_FILE_PULL_REQUEST),
        host: () => h.github,
        proposals: h.store,
      },
      {
        scope: SCOPE,
        operator: OPERATOR,
        runtime: { slug: RUNTIME, name: RUNTIME },
        hostname: RUNTIME,
        harnesses: ["claude-code"],
      },
    );
    if (agent.status !== "opened") throw new Error(`enrollment opened no agent file PR: ${agent.reason}`);
    expectOpenedGreen(h, agent.pullRequest.headSha);
    const review = await openReview(h, SERVERS[0] as LiveServer);

    const checked: Checked[] = [];
    await merge(h, checked, review.proposalId);
    const out = await merge(h, checked, proposalFor(h, agent.pullRequest.number));

    expect(out).toMatchObject({ status: "merged", kind: "agent_file" });
    expect(await h.github.readFile(REPO, `agents/${RUNTIME}.toml`, "main")).toContain(`runtime = "${RUNTIME}"`);
    expect(await h.github.readFile(REPO, "tools/servers/live_mcp/tools.lock.json", "main")).not.toBeNull();
  });

  it("names the failed check and its first error when the checks refuse the merge", async () => {
    const h = steeringHarness();
    // A person raised a version in the lock Review wrote, which the owned check refuses.
    const tampered = await openReview(h, SERVERS[0] as LiveServer, (files) => {
      const lock = files.get("tools.lock.json") ?? "";
      files.set("tools.lock.json", lock.replace('"version": 1', '"version": 2'));
    });

    const refusal = merge(h, [], tampered.proposalId);

    await expect(refusal).rejects.toMatchObject({ code: "conflict", reason: "checks_failed" });
    await expect(refusal).rejects.toThrow(/The [a-z, ]*owned[a-z ]* checks? found \d+ errors?\. The first error/);
    await expect(refusal).rejects.toThrow(/The "Oxagen steering" check on .+ holds the full report\./);
    expect(h.github.merges).toEqual([]);
  });
});
