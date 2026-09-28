// lock: a tool's version follows its definition_hash, the files server locks
// to its fixture byte for byte, and a registry server pins its package or its
// remote.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, type CompileInput, type CompiledServer } from "../compile";
import { formatJson } from "../contract/json";
import { LOCK_BYTES_MAX, mcpLockSchema, type McpLock } from "../contract/lock";
import { mcpToolsListResultSchema } from "../contract/mcp-tool";
import { parseLock, parseServerToml, parseToolsToml, type ReadResult } from "../contract/parse";
import { registryEntrySchema, type RegistryEntry } from "../contract/registry-entry";
import { registrySourceSchema, type McpServer } from "../contract/server";
import { mcpToolsSchema } from "../contract/tools";
import { upstreamFromMcpTool } from "../model/from-mcp";
import type { RegistrySource } from "../model/registry-launch";
import { lock, registryLockSource } from "./index";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

function text(path: string): string {
  return readFileSync(join(FIXTURES, path), "utf8");
}

function json(path: string): unknown {
  return JSON.parse(text(path)) as unknown;
}

/** The value of a parse that must succeed. A failure shows its issues. */
function ok<T>(result: ReadResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return result.value;
}

// ── stripe ───────────────────────────────────────────────────────────────────

function stripeLock(): McpLock {
  return mcpLockSchema.parse(json("servers/stripe/tools.lock.json"));
}

/** stripe's compile input, from its tools/list, with these fields changed on each tools.toml entry. */
function stripeInput(changes: Record<string, Record<string, unknown>> = {}): CompileInput {
  const tools = ok(parseToolsToml(text("servers/stripe/tools.toml")));
  const entries: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(tools.tools ?? {})) entries[key] = { ...entry, ...changes[key] };
  return {
    server: ok(parseServerToml(text("servers/stripe/server.toml"))),
    tools: mcpToolsSchema.parse({ ...tools, tools: entries }),
    upstream: mcpToolsListResultSchema.parse(json("sources/stripe/tools-list.json")).tools.map(upstreamFromMcpTool),
    security_schemes: {},
    descriptor_set: undefined,
  };
}

/** stripe's pinned lock with each named tool's version and definition_hash replaced. */
function previousWith(fields: Record<string, { version: number; definition_hash?: string }>): McpLock {
  const pinned = stripeLock();
  const tools = { ...pinned.tools };
  for (const [key, change] of Object.entries(fields)) tools[key] = { ...tools[key]!, ...change };
  return { ...pinned, tools };
}

const OTHER_HASH = `sha256:${"0".repeat(64)}`;

describe("lock versions", () => {
  it("starts every tool at version 1 when there is no previous lock", () => {
    const locked = lock({ compiled: compile(stripeInput()), source: stripeLock().source, previous: undefined });
    expect(locked.tools.create_refund?.version).toBe(1);
    expect(locked.tools.list_charges?.version).toBe(1);
  });

  it("keeps the previous version when definition_hash is unchanged", () => {
    const previous = previousWith({ create_refund: { version: 3 } });
    const locked = lock({ compiled: compile(stripeInput()), source: previous.source, previous });
    expect(locked.tools.create_refund?.version).toBe(3);
  });

  it("raises the version by one when definition_hash changed", () => {
    const previous = previousWith({ create_refund: { version: 5, definition_hash: OTHER_HASH } });
    const locked = lock({ compiled: compile(stripeInput()), source: previous.source, previous });
    expect(locked.tools.create_refund?.version).toBe(6);
    expect(locked.tools.list_charges?.version).toBe(1);
  });

  it("raises the version when a tools.toml description changes the definition", () => {
    const previous = stripeLock();
    const compiled = compile(stripeInput({ create_refund: { description: "Refund a captured charge in cents." } }));
    const locked = lock({ compiled, source: previous.source, previous });
    expect(locked.tools.create_refund?.definition_hash).not.toBe(previous.tools.create_refund?.definition_hash);
    expect(locked.tools.create_refund?.version).toBe(2);
    expect(locked.tools.create_refund?.upstream_hash).toBe(previous.tools.create_refund?.upstream_hash);
  });

  it("starts a tool the previous lock has no entry for at version 1", () => {
    const pinned = stripeLock();
    const { list_charges: _listCharges, ...kept } = pinned.tools;
    const previous = { ...pinned, tools: { create_refund: { ...kept.create_refund!, version: 2 } } };
    const locked = lock({ compiled: compile(stripeInput()), source: pinned.source, previous });
    expect(locked.tools.list_charges?.version).toBe(1);
    expect(locked.tools.create_refund?.version).toBe(2);
  });

  it("keeps both hashes and the version when only the classification changes", () => {
    const previous = previousWith({ create_refund: { version: 4 }, list_charges: { version: 2 } });
    const compiled = compile(
      stripeInput({
        create_refund: { risk: "medium", side_effect: "write", impacts: undefined },
        list_charges: { egress: "org_tenant" },
      }),
    );
    expect(compiled.tools.create_refund?.classification).toMatchObject({ risk: "medium", side_effect: "write", impacts: [] });
    expect(compiled.tools.create_refund?.definition.annotations.destructiveHint).toBe(false);
    expect(compiled.tools.list_charges?.definition.annotations.openWorldHint).toBe(false);

    const locked = lock({ compiled, source: previous.source, previous });
    for (const key of ["create_refund", "list_charges"]) {
      expect(locked.tools[key]?.definition_hash).toBe(previous.tools[key]?.definition_hash);
      expect(locked.tools[key]?.upstream_hash).toBe(previous.tools[key]?.upstream_hash);
      expect(locked.tools[key]?.version).toBe(previous.tools[key]?.version);
    }
  });
});

describe("lock refusals", () => {
  it("refuses a source of another type", () => {
    const compiled = compile(stripeInput());
    const source = ok(parseLock(text("servers/files/tools.lock.json"))).source;
    expect(() => lock({ compiled, source, previous: undefined })).toThrow(
      "The lock source is registry, and stripe's source is remote.",
    );
  });

  it("refuses a previous lock for another server", () => {
    const compiled = compile(stripeInput());
    const previous = ok(parseLock(text("servers/billing/tools.lock.json")));
    expect(() => lock({ compiled, source: stripeLock().source, previous })).toThrow(
      "The previous lock is for billing, and the compiled server is stripe.",
    );
  });

  it("refuses a lock over 5 MB", () => {
    const compiled = compile(stripeInput());
    const tool = compiled.tools.create_refund!;
    const huge: CompiledServer = {
      ...compiled,
      tools: {
        ...compiled.tools,
        create_refund: { ...tool, upstream: { ...tool.upstream, description: "x".repeat(LOCK_BYTES_MAX) } },
      },
    };
    expect(() => lock({ compiled: huge, source: stripeLock().source, previous: undefined })).toThrow(
      new RegExp(
        `^The lock for stripe is \\d+ bytes, and a lock file is at most ${LOCK_BYTES_MAX} bytes\\. Take tools out of tools\\.toml, or split the server\\.$`,
      ),
    );
  });
});

// ── Registry sources ─────────────────────────────────────────────────────────

const REGISTRY = "https://registry.modelcontextprotocol.io";
const FILESYSTEM = "io.github.modelcontextprotocol/server-filesystem";
const GITHUB = "io.github.github/github-mcp-server";

function registrySource(server: McpServer): RegistrySource {
  if (server.source.type !== "registry") throw new Error(`${server.name} has a ${server.source.type} source`);
  return server.source;
}

function filesServer(): McpServer {
  return ok(parseServerToml(text("servers/files/server.toml")));
}

/** The digest servers/files/tools.lock.json pins. */
function filesDigest(): string {
  const pinned = ok(parseLock(text("servers/files/tools.lock.json"))).source;
  if (pinned.type !== "registry" || pinned.package === undefined) throw new Error("the files lock pins no package");
  return pinned.package.digest;
}

function packageEntry(): RegistryEntry {
  return registryEntrySchema.parse(json("registry/package-entry.json"));
}

/** remote-entry.json with its remotes replaced when given. */
function remoteEntry(remotes?: Record<string, unknown>[]): RegistryEntry {
  const raw = json("registry/remote-entry.json") as { server: Record<string, unknown> };
  return registryEntrySchema.parse(remotes === undefined ? raw : { ...raw, server: { ...raw.server, remotes } });
}

/** The github entry's source as server.toml writes it, with no machines. */
function githubSource(fields: Record<string, unknown> = {}): RegistrySource {
  return registrySourceSchema.parse({ type: "registry", registry: REGISTRY, server: GITHUB, version: "0.18.0", ...fields });
}

describe("lock with a registry package", () => {
  it("locks package-entry.json to servers/files/tools.lock.json, byte for byte", () => {
    const server = filesServer();
    const compiled = compile({
      server,
      tools: mcpToolsSchema.parse({ schema: "mcp-tools/v1" }),
      upstream: [],
      security_schemes: {},
      descriptor_set: undefined,
    });
    const source = registryLockSource({
      source: registrySource(server),
      entry: packageEntry(),
      digest: filesDigest(),
      server_version: undefined,
    });
    expect(source.args).toContain("${WORK_DIR}");
    expect(formatJson(lock({ compiled, source, previous: undefined }))).toBe(text("servers/files/tools.lock.json"));
  });

  it("needs the package's digest", () => {
    expect(() =>
      registryLockSource({
        source: registrySource(filesServer()),
        entry: packageEntry(),
        digest: undefined,
        server_version: undefined,
      }),
    ).toThrow(`${FILESYSTEM} runs on machines, so its lock needs the package's digest.`);
  });

  it("reports each launch problem on its field", () => {
    const source = registrySourceSchema.parse({ ...registrySource(filesServer()), registry_type: "pypi" });
    expect(() =>
      registryLockSource({ source, entry: packageEntry(), digest: filesDigest(), server_version: undefined }),
    ).toThrow("source.registry_type: the entry lists no pypi package");
  });

  it("refuses an entry with no remote when server.toml names no machines", () => {
    const source = registrySourceSchema.parse({ type: "registry", registry: REGISTRY, server: FILESYSTEM, version: "2026.8.1" });
    expect(() =>
      registryLockSource({ source, entry: packageEntry(), digest: undefined, server_version: undefined }),
    ).toThrow(`${FILESYSTEM} 2026.8.1 lists no streamable-http remote. Name source.machines to run its package.`);
  });
});

describe("lock with a registry remote", () => {
  it("pins a streamable-http remote as http", () => {
    expect(
      registryLockSource({ source: githubSource(), entry: remoteEntry(), digest: undefined, server_version: undefined }),
    ).toEqual({
      type: "registry",
      registry: REGISTRY,
      server: GITHUB,
      version: "0.18.0",
      url: "https://api.githubcopilot.com/mcp/",
      transport: "http",
    });
  });

  it("skips an sse remote and any other type the gateway cannot use, and pins the streamable-http remote", () => {
    const entry = remoteEntry([
      { type: "sse", url: "https://api.githubcopilot.com/sse/" },
      { type: "websocket", url: "https://api.githubcopilot.com/ws/" },
      { type: "streamable-http", url: "https://api.githubcopilot.com/mcp/" },
    ]);
    const source = registryLockSource({ source: githubSource(), entry, digest: undefined, server_version: undefined });
    expect(source).toMatchObject({ url: "https://api.githubcopilot.com/mcp/", transport: "http" });
  });

  it("refuses an entry whose only remote is sse, and names streamable-http", () => {
    const entry = remoteEntry([{ type: "sse", url: "https://api.githubcopilot.com/sse/" }]);
    expect(() =>
      registryLockSource({ source: githubSource(), entry, digest: undefined, server_version: undefined }),
    ).toThrow(
      `${GITHUB} 0.18.0 lists an sse remote and no streamable-http remote, and the gateway calls streamable-http only. Name source.machines to run its package.`,
    );
  });

  it("refuses an entry whose only remote the gateway cannot use", () => {
    const entry = remoteEntry([{ type: "websocket", url: "https://api.githubcopilot.com/ws/" }]);
    expect(() =>
      registryLockSource({ source: githubSource(), entry, digest: undefined, server_version: undefined }),
    ).toThrow(`${GITHUB} 0.18.0 lists no streamable-http remote. Name source.machines to run its package.`);
  });

  it("records the version the server reported", () => {
    const source = registryLockSource({
      source: githubSource(),
      entry: remoteEntry(),
      digest: undefined,
      server_version: "0.18.0+build.7",
    });
    expect(source.server_version).toBe("0.18.0+build.7");
  });

  it.each([
    { label: "another server", fields: { server: "io.github.acme/tracker-mcp" }, names: "io.github.acme/tracker-mcp 0.18.0" },
    { label: "another version", fields: { version: "0.17.2" }, names: `${GITHUB} 0.17.2` },
  ])("refuses an entry for $label", ({ fields, names }) => {
    expect(() =>
      registryLockSource({
        source: githubSource(fields),
        entry: remoteEntry(),
        digest: undefined,
        server_version: undefined,
      }),
    ).toThrow(`The catalog entry is ${GITHUB} 0.18.0, and server.toml names ${names}.`);
  });

  it("locks a compiled registry remote with its pinned url", () => {
    const server = ok(
      parseServerToml(
        [
          "#:schema https://oxagen.sh/schemas/mcp-server/v1.json",
          'schema = "mcp-server/v1"',
          'name = "github"',
          'label = "GitHub"',
          'description = "Issues and pull requests in GitHub."',
          "[source]",
          'type = "registry"',
          `registry = "${REGISTRY}"`,
          `server = "${GITHUB}"`,
          'version = "0.18.0"',
          "[auth]",
          'mode = "operator-oauth"',
          'scheme = "oauth"',
          'credential = "oxagen:credential/github-app"',
          "[exposure]",
          'mode = "direct"',
          "[sync]",
          'schedule = "daily"',
          "",
        ].join("\n"),
      ),
    );
    const compiled = compile({
      server,
      tools: mcpToolsSchema.parse({ schema: "mcp-tools/v1" }),
      upstream: [],
      security_schemes: {},
      descriptor_set: undefined,
    });
    const source = registryLockSource({
      source: registrySource(server),
      entry: remoteEntry(),
      digest: undefined,
      server_version: undefined,
    });
    const locked = lock({ compiled, source, previous: undefined });
    expect(locked.source).toEqual(source);
    expect(locked.tools).toEqual({});
  });
});
