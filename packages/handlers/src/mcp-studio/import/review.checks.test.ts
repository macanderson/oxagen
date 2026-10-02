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
import { readFileSync } from "node:fs";
import type { StudioDraftOp, StudioSource } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { fixtureContext, fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import { runChecksWithServers } from "@oxagen/steering-check/servers";
import { describe, expect, it } from "vitest";
import { buildFolder } from "./build";
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
