/**
 * planProjection decides every write a steering publish makes to the tool
 * registry. These tests run it against MCP Studio's fixture manifest and
 * hand-built registry rows; project.pg.test.ts runs the writes against
 * Postgres.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toolManifestSchema, type ToolManifest } from "@oxagen/mcp-studio";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import {
  ProjectionConflictError,
  discoveredNames,
  planProjection,
  project,
  serverColumns,
  upstreamName,
  versionFacts,
  type RegistrySnapshot,
  type SnapshotServer,
  type SnapshotTool,
  type SnapshotVersion,
  type ToolStep,
} from "./project";

const manifest: ToolManifest = toolManifestSchema.parse(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../../mcp-studio/fixtures/expected/tool-manifest.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ),
);

const EMPTY: RegistrySnapshot = { servers: [], tools: [], versions: [] };

function hexOf(hash: string): string {
  return hash.replace(/^sha256:/, "");
}

function server(name: string) {
  const found = manifest.servers.find((s) => s.name === name);
  if (!found) throw new Error(`fixture has no server ${name}`);
  return found;
}

/** The manifest with one server's folder replaced. */
function withServer(
  name: string,
  edit: (s: ToolManifest["servers"][number]) => ToolManifest["servers"][number],
): ToolManifest {
  return {
    ...manifest,
    servers: manifest.servers.map((s) => (s.name === name ? edit(s) : s)),
  };
}

let seq = 0;
function uuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

/** The registry rows a projection of `m` leaves behind. */
function snapshotOf(m: ToolManifest): RegistrySnapshot {
  const servers: SnapshotServer[] = [];
  const tools: SnapshotTool[] = [];
  const versions: SnapshotVersion[] = [];
  for (const s of m.servers) {
    const columns = serverColumns(s);
    const serverId = uuid();
    servers.push({
      id: serverId,
      name: columns.name,
      steeringName: s.name,
      origin: "steering",
      transportType: columns.transportType,
      endpointUrl: columns.endpointUrl,
      discoveredTools: columns.discoveredTools,
      enabled: true,
      deletedAt: null,
    });
    for (const entry of Object.values(s.tools)) {
      const facts = versionFacts(entry);
      const toolId = uuid();
      const versionId = uuid();
      tools.push({
        id: toolId,
        slug: entry.name,
        name: entry.name,
        description: entry.definition.description ?? null,
        source: "mcp",
        enabled: true,
        mcpServerId: serverId,
        activeVersionId: versionId,
        deletedAt: null,
      });
      versions.push({
        id: versionId,
        toolId,
        versionNumber: 1,
        checksum: hexOf(entry.definition_hash),
        riskGrade: facts.risk,
        readOnly: facts.readOnly,
        impacts: facts.impacts,
        measures: {},
        manifest: entry,
        classification: facts.classification,
        classifiedRiskGrade: facts.risk,
      });
    }
  }
  return { servers, tools, versions };
}

function toolStep(steps: ToolStep[], name: string): ToolStep {
  const step = steps.find((s) => s.fullName === name);
  if (!step) throw new Error(`no step for ${name}`);
  return step;
}

describe("serverColumns", () => {
  it("maps a definition source to its transport and the sandbox environment's URL", () => {
    const columns = serverColumns(server("billing"));
    expect(columns).toEqual({
      name: "Billing API",
      transportType: "openapi",
      endpointUrl: "https://billing-sandbox.a-intel.com/v2",
      authStrategy: "bearer",
      discoveredTools: ["create_refund", "list_charges"],
    });
  });

  it("maps a remote MCP source to streamable-http and lists its upstream names", () => {
    const columns = serverColumns(server("stripe"));
    expect(columns.transportType).toBe("streamable-http");
    expect(columns.endpointUrl).toBe("https://mcp.stripe.com");
    expect(columns.discoveredTools).toEqual(["create_refund", "list_charges"]);
  });

  it("maps remote, local, and registry sources, and a server with no auth", () => {
    const stripe = server("stripe");
    const remote = serverColumns({
      ...stripe,
      auth: null,
      source: { type: "remote", url: "https://mcp.example.com/mcp", transport: "http", network: "cloud" },
    } as typeof stripe);
    expect(remote.transportType).toBe("streamable-http");
    expect(remote.authStrategy).toBe("none");

    const local = serverColumns({
      ...stripe,
      auth: null,
      environments: { default: { sandbox: true, network: "local" } },
      source: { type: "local", command: "npx", args: ["-y", "some-server"] },
    } as unknown as typeof stripe);
    expect(local.transportType).toBe("stdio");
    expect(local.endpointUrl).toBe("npx");

    const registry = serverColumns({
      ...stripe,
      environments: {},
      source: {
        type: "registry",
        registry: "https://registry.modelcontextprotocol.io",
        server: "io.github/example",
        version: "1.0.0",
      },
    } as unknown as typeof stripe);
    expect(registry.transportType).toBe("streamable-http");
    expect(registry.endpointUrl).toBe("io.github/example");

    const header = serverColumns({
      ...stripe,
      auth: { ...stripe.auth, scheme: "header" },
    } as typeof stripe);
    expect(header.authStrategy).toBe("header");
  });
});

describe("upstreamName and discoveredNames", () => {
  it("reads an MCP request's upstream tool and falls back to the key", () => {
    const stripe = server("stripe");
    const billing = server("billing");
    const refund = stripe.tools.create_refund;
    const list = billing.tools.list_charges;
    if (!refund || !list) throw new Error("fixture changed");
    expect(upstreamName("create_refund", refund)).toBe("create_refund");
    expect(upstreamName("list_charges", list)).toBe("list_charges");
  });

  it("reads names from strings and from descriptor objects", () => {
    expect([...discoveredNames(["a", { name: "b" }, 3, null])]).toEqual([
      "a",
      "b",
    ]);
    expect(discoveredNames(null).size).toBe(0);
  });
});

describe("planProjection", () => {
  it("inserts every server and publishes every tool into an empty registry", () => {
    const plan = planProjection(manifest, EMPTY);
    expect(plan.servers.map((s) => [s.name, s.action])).toEqual([
      ["billing", "insert"],
      ["stripe", "insert"],
    ]);
    expect(plan.tools.map((t) => [t.fullName, t.kind])).toEqual([
      ["billing__create_refund", "publish"],
      ["billing__list_charges", "publish"],
      ["stripe__create_refund", "publish"],
      ["stripe__list_charges", "publish"],
    ]);
    expect(plan.disable).toEqual([]);
    expect(plan.retire).toEqual([]);
    const refund = toolStep(plan.tools, "stripe__create_refund");
    expect(refund.facts).toMatchObject({
      risk: "high",
      readOnly: false,
      impacts: ["moves_money"],
    });
    expect(refund.facts.classification).toMatchObject({
      sideEffect: "irreversible",
      egress: "third_party",
    });
    expect(toolStep(plan.tools, "stripe__list_charges").facts.readOnly).toBe(
      true,
    );
  });

  it("plans no write when the registry already matches the version", () => {
    const plan = planProjection(manifest, snapshotOf(manifest));
    expect(plan.servers.every((s) => s.action === "keep")).toBe(true);
    for (const step of plan.tools) {
      expect(step.kind).toBe("align");
      if (step.kind !== "align") continue;
      expect(step.activate).toBe(false);
      expect(step.reclassify).toBe(false);
      expect(step.refreshManifest).toBe(false);
      expect(step.enable).toBe(false);
      expect(step.revive).toBe(false);
    }
    expect(plan.disable).toEqual([]);
    expect(plan.retire).toEqual([]);
  });

  it("reclassifies the version in place when only tools.toml's classification changed", () => {
    const before = snapshotOf(manifest);
    const next = withServer("stripe", (s) => {
      const list = s.tools.list_charges;
      if (!list) throw new Error("fixture changed");
      return {
        ...s,
        tools: {
          ...s.tools,
          list_charges: {
            ...list,
            classification: {
              ...list.classification,
              impacts: ["exports_data"],
              data_classes: ["pii"],
            },
          },
        },
      };
    });
    const plan = planProjection(next, before);
    const step = toolStep(plan.tools, "stripe__list_charges");
    expect(step.kind).toBe("align");
    if (step.kind !== "align") return;
    expect(step.reclassify).toBe(true);
    expect(step.activate).toBe(false);
    expect(step.refreshManifest).toBe(true);
    expect(step.facts.impacts).toEqual(["exports_data"]);
    const other = toolStep(plan.tools, "stripe__create_refund");
    expect(other.kind === "align" && other.reclassify).toBe(false);
  });

  it("reclassifies a version whose risk alone changed", () => {
    const before = snapshotOf(manifest);
    const next = withServer("billing", (s) => {
      const list = s.tools.list_charges;
      if (!list) throw new Error("fixture changed");
      return {
        ...s,
        tools: {
          ...s.tools,
          list_charges: {
            ...list,
            classification: { ...list.classification, risk: "medium" },
          },
        },
      };
    });
    const step = toolStep(
      planProjection(next, before).tools,
      "billing__list_charges",
    );
    expect(step.kind === "align" && step.reclassify).toBe(true);
    expect(step.facts.risk).toBe("medium");
  });

  it("publishes a new version when the definition_hash is new", () => {
    const before = snapshotOf(manifest);
    const next = withServer("stripe", (s) => {
      const refund = s.tools.create_refund;
      if (!refund) throw new Error("fixture changed");
      return {
        ...s,
        tools: {
          ...s.tools,
          create_refund: {
            ...refund,
            definition_hash: `sha256:${"a".repeat(64)}`,
          },
        },
      };
    });
    const step = toolStep(
      planProjection(next, before).tools,
      "stripe__create_refund",
    );
    expect(step.kind).toBe("publish");
    expect(step.tool?.slug).toBe("stripe__create_refund");
    expect(step.enable).toBe(false);
  });

  it("activates an earlier version when the hash is one the tool already carried", () => {
    const before = snapshotOf(manifest);
    const tool = before.tools.find((t) => t.slug === "stripe__create_refund");
    const v1 = before.versions.find((v) => v.toolId === tool?.id);
    if (!tool || !v1) throw new Error("snapshot changed");
    const v2: SnapshotVersion = {
      ...v1,
      id: uuid(),
      versionNumber: 2,
      checksum: "b".repeat(64),
    };
    const rolledForward: RegistrySnapshot = {
      ...before,
      tools: before.tools.map((t) =>
        t.id === tool.id ? { ...t, activeVersionId: v2.id } : t,
      ),
      versions: [...before.versions, v2],
    };
    const step = toolStep(
      planProjection(manifest, rolledForward).tools,
      "stripe__create_refund",
    );
    expect(step.kind).toBe("align");
    if (step.kind !== "align") return;
    expect(step.activate).toBe(true);
    expect(step.version.id).toBe(v1.id);
    expect(step.previousActive?.id).toBe(v2.id);
    expect(step.reclassify).toBe(false);
  });

  it("disables a tool its folder no longer lists", () => {
    const before = snapshotOf(manifest);
    const next = withServer("billing", (s) => {
      const { list_charges: _dropped, ...rest } = s.tools;
      return { ...s, tools: rest };
    });
    const plan = planProjection(next, before);
    expect(plan.disable.map((t) => t.slug)).toEqual(["billing__list_charges"]);
    expect(plan.retire).toEqual([]);
  });

  it("retires a steering server whose folder is gone and disables its tools", () => {
    const before = snapshotOf(manifest);
    const next: ToolManifest = {
      ...manifest,
      servers: manifest.servers.filter((s) => s.name !== "stripe"),
    };
    const plan = planProjection(next, before);
    expect(plan.retire.map((s) => s.name)).toEqual(["stripe"]);
    expect(plan.disable.map((t) => t.slug).sort()).toEqual([
      "stripe__create_refund",
      "stripe__list_charges",
    ]);
  });

  it("leaves a server alone when its folder is still there but did not compile", () => {
    const before = snapshotOf(manifest);
    const next: ToolManifest = {
      ...manifest,
      servers: manifest.servers.filter((s) => s.name !== "stripe"),
    };
    const plan = planProjection(next, before, {
      folders: ["billing", "stripe"],
    });
    expect(plan.retire).toEqual([]);
    expect(plan.disable).toEqual([]);
  });

  it("never retires a legacy row, even one a migration PR named", () => {
    const before = snapshotOf(manifest);
    const legacy: RegistrySnapshot = {
      ...before,
      servers: before.servers.map((s) =>
        s.steeringName === "stripe" ? { ...s, origin: "legacy" } : s,
      ),
    };
    const next: ToolManifest = {
      ...manifest,
      servers: manifest.servers.filter((s) => s.name !== "stripe"),
    };
    expect(planProjection(next, legacy).retire).toEqual([]);
  });

  it("takes over a legacy row, renaming each legacy slug and keeping its enabled flag", () => {
    const serverId = uuid();
    const refundId = uuid();
    const listId = uuid();
    const legacy: RegistrySnapshot = {
      servers: [
        {
          id: serverId,
          name: "Stripe (connected)",
          steeringName: "stripe",
          origin: "legacy",
          transportType: "streamable-http",
          endpointUrl: "https://mcp.stripe.com",
          discoveredTools: [{ name: "create_refund" }, { name: "list_charges" }, { name: "old_tool" }],
          enabled: true,
          deletedAt: null,
        },
      ],
      tools: [
        {
          id: refundId,
          slug: `mcp.${serverId}.create_refund`,
          name: "create_refund",
          description: null,
          source: "mcp",
          enabled: true,
          mcpServerId: serverId,
          activeVersionId: null,
          deletedAt: null,
        },
        {
          id: listId,
          slug: `mcp.${serverId}.list_charges`,
          name: "list_charges",
          description: null,
          source: "mcp",
          enabled: false,
          mcpServerId: serverId,
          activeVersionId: null,
          deletedAt: null,
        },
        {
          id: uuid(),
          slug: `mcp.${serverId}.old_tool`,
          name: "old_tool",
          description: null,
          source: "mcp",
          enabled: true,
          mcpServerId: serverId,
          activeVersionId: null,
          deletedAt: null,
        },
      ],
      versions: [],
    };
    const only: ToolManifest = {
      ...manifest,
      servers: [server("stripe")],
    };
    const plan = planProjection(only, legacy);
    expect(plan.servers).toMatchObject([
      { name: "stripe", action: "takeover", id: serverId },
    ]);
    const refund = toolStep(plan.tools, "stripe__create_refund");
    expect(refund).toMatchObject({
      kind: "publish",
      renameFrom: `mcp.${serverId}.create_refund`,
      enable: false,
      revive: false,
    });
    expect(refund.tool?.id).toBe(refundId);
    const list = toolStep(plan.tools, "stripe__list_charges");
    expect(list.tool?.id).toBe(listId);
    expect(list.enable).toBe(false);
    expect(plan.disable.map((t) => t.slug)).toEqual([
      `mcp.${serverId}.old_tool`,
    ]);
    expect(plan.servers[0]?.enable).toBe(false);
  });

  it("takes over a proposed row and turns it on", () => {
    const serverId = uuid();
    const proposed: RegistrySnapshot = {
      servers: [
        {
          id: serverId,
          name: "Stripe",
          steeringName: "stripe",
          origin: "proposed",
          transportType: "streamable-http",
          endpointUrl: "https://mcp.stripe.com",
          discoveredTools: [{ name: "create_refund" }],
          enabled: false,
          deletedAt: null,
        },
      ],
      tools: [],
      versions: [],
    };
    const plan = planProjection({ ...manifest, servers: [server("stripe")] }, proposed);
    expect(plan.servers).toMatchObject([
      { name: "stripe", action: "takeover", id: serverId, enable: true },
    ]);
    expect(toolStep(plan.tools, "stripe__create_refund")).toMatchObject({
      tool: null,
      enable: true,
    });
  });

  it("never retires a proposed row whose steering PR has not merged", () => {
    const before = snapshotOf(manifest);
    const proposed: RegistrySnapshot = {
      ...before,
      servers: before.servers.map((s) =>
        s.steeringName === "stripe" ? { ...s, origin: "proposed", enabled: false } : s,
      ),
    };
    const next: ToolManifest = {
      ...manifest,
      servers: manifest.servers.filter((s) => s.name !== "stripe"),
    };
    expect(planProjection(next, proposed).retire).toEqual([]);
  });

  it("refuses a tool name a non-MCP tool already holds", () => {
    const conflict: RegistrySnapshot = {
      servers: [],
      tools: [
        {
          id: uuid(),
          slug: "Stripe__Create_Refund",
          name: "stripe__create_refund",
          description: null,
          source: "custom",
          enabled: true,
          mcpServerId: null,
          activeVersionId: null,
          deletedAt: null,
        },
      ],
      versions: [],
    };
    expect(() => planProjection(manifest, conflict)).toThrow(
      ProjectionConflictError,
    );
  });

  it("revives a soft-deleted server and its soft-deleted tools, and enables them", () => {
    const before = snapshotOf(manifest);
    const deletedAt = new Date("2026-09-01T00:00:00Z");
    const stripeId = before.servers.find((s) => s.steeringName === "stripe")?.id;
    const dead: RegistrySnapshot = {
      ...before,
      servers: before.servers.map((s) =>
        s.id === stripeId ? { ...s, deletedAt } : s,
      ),
      tools: before.tools.map((t) =>
        t.mcpServerId === stripeId ? { ...t, deletedAt, enabled: false } : t,
      ),
    };
    const plan = planProjection(manifest, dead);
    expect(plan.servers.find((s) => s.name === "stripe")?.action).toBe(
      "revive",
    );
    const refund = toolStep(plan.tools, "stripe__create_refund");
    expect(refund.revive).toBe(true);
    expect(refund.enable).toBe(true);
  });

  it("revives the most recently deleted row when a folder came back more than once", () => {
    const before = snapshotOf(manifest);
    const stripe = before.servers.find((s) => s.steeringName === "stripe");
    if (!stripe) throw new Error("snapshot changed");
    const older = { ...stripe, id: uuid(), deletedAt: new Date("2026-08-01T00:00:00Z") };
    const newer = { ...stripe, deletedAt: new Date("2026-09-01T00:00:00Z") };
    const plan = planProjection(manifest, {
      ...before,
      servers: [
        ...before.servers.filter((s) => s.id !== stripe.id),
        older,
        newer,
      ],
    });
    expect(plan.servers.find((s) => s.name === "stripe")).toMatchObject({
      action: "revive",
      id: stripe.id,
    });
  });

  it("enables a tool the folder lists again, and keeps a tool a person disabled", () => {
    const before = snapshotOf(manifest);
    // list_charges was disabled while the folder still listed it, so the
    // server's discovered tools include it: it stays disabled.
    const kept: RegistrySnapshot = {
      ...before,
      tools: before.tools.map((t) =>
        t.slug === "stripe__list_charges" ? { ...t, enabled: false } : t,
      ),
    };
    expect(
      toolStep(planProjection(manifest, kept).tools, "stripe__list_charges")
        .enable,
    ).toBe(false);

    // The previous version dropped list_charges from the folder, so the
    // server's discovered tools leave it out: listing it again enables it.
    const dropped: RegistrySnapshot = {
      ...kept,
      servers: kept.servers.map((s) =>
        s.steeringName === "stripe"
          ? { ...s, discoveredTools: ["create_refund"] }
          : s,
      ),
    };
    const plan = planProjection(manifest, dropped);
    expect(plan.servers.find((s) => s.name === "stripe")?.action).toBe(
      "update",
    );
    expect(toolStep(plan.tools, "stripe__list_charges").enable).toBe(true);
  });

  it("updates a server row whose columns drifted from its folder", () => {
    const before = snapshotOf(manifest);
    const drifted: RegistrySnapshot = {
      ...before,
      servers: before.servers.map((s) =>
        s.steeringName === "billing" ? { ...s, name: "Old label" } : s,
      ),
    };
    const plan = planProjection(manifest, drifted);
    expect(plan.servers.find((s) => s.name === "billing")?.action).toBe(
      "update",
    );
  });
});

describe("project", () => {
  // Both return before project() reads the database.
  it("projects nothing for an organization's bundle", async () => {
    const bundle = {
      schema: "bundle/v1",
      scope: "organization",
      organization: "acme",
      version: 1,
      tools: manifest,
    } as unknown as Bundle;
    expect(await project(bundle)).toBeNull();
  });

  it("projects nothing when the tools did not compile and no folders came", async () => {
    const bundle = {
      schema: "bundle/v1",
      scope: "workspace",
      organization: "acme",
      workspace: "tools",
      version: 1,
      tools: null,
    } as unknown as Bundle;
    expect(await project(bundle)).toBeNull();
  });
});
