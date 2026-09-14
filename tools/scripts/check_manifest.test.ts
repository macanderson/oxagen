import { describe, expect, it } from "vitest";
import {
  apiLayerSatisfied,
  buildApiRouteIndex,
  manifestContentChanged,
} from "./check_manifest.mjs";

describe("buildApiRouteIndex", () => {
  it("collects contract stems imported by any route file", () => {
    const files = [
      {
        name: "schema.ts",
        content: `
          import { schemaList } from "@oxagen/oxagen/contracts/schema.list";
          import { schemaToggle } from "@oxagen/oxagen/contracts/schema.toggle";
          import { invoke } from "@oxagen/oxagen/kernel";
        `,
      },
      {
        name: "connection.ts",
        content: `import { connectionCreate } from "@oxagen/oxagen/contracts/connection.create";`,
      },
    ];
    const { importedStems } = buildApiRouteIndex(files);
    expect(importedStems.has("schema.list")).toBe(true);
    expect(importedStems.has("schema.toggle")).toBe(true);
    expect(importedStems.has("connection.create")).toBe(true);
    expect(importedStems.has("connection.delete")).toBe(false);
  });

  it("concatenates raw source for the literal-name fallback scan", () => {
    const files = [
      {
        name: "workflow.ts",
        content: `await invoke(workflowRun.name, body, ctx);`,
      },
    ];
    const { content } = buildApiRouteIndex(files);
    expect(content).toContain("invoke(workflowRun.name, body, ctx);");
  });
});

describe("apiLayerSatisfied", () => {
  it("passes via the dedicated per-capability filename path (unchanged behavior)", () => {
    const routeIndex = { importedStems: new Set<string>(), content: "" };
    const ok = apiLayerSatisfied({
      stems: ["create_org", "org.create"],
      capName: "create_org",
      hasDirectFile: true,
      routeIndex,
    });
    expect(ok).toBe(true);
  });

  it("passes a capability satisfied only via a combined route file's contract import", () => {
    // Mirrors schema.ts: no dedicated apps/api/src/routes/v1/schema.list.ts
    // file exists, but schema.ts imports @oxagen/oxagen/contracts/schema.list
    // and dispatches it — that IS live api wiring and must not be a gap.
    const routeIndex = buildApiRouteIndex([
      {
        name: "schema.ts",
        content: `
          import { schemaList } from "@oxagen/oxagen/contracts/schema.list";
          import { invoke } from "@oxagen/oxagen/kernel";
          app.post("/schema/list", async (c) => {
            const out = await invoke(schemaList.name, body, ctx, { surface: "api" });
          });
        `,
      },
    ]);
    const ok = apiLayerSatisfied({
      stems: ["list_schemas", "schema.list"],
      capName: "list_schemas",
      hasDirectFile: false,
      routeIndex,
    });
    expect(ok).toBe(true);
  });

  it("passes via the exact quoted capability-name fallback when no stem import matches", () => {
    const routeIndex = buildApiRouteIndex([
      {
        name: "misc.ts",
        content: `await invoke("edit_repo_file", body, ctx);`,
      },
    ]);
    const ok = apiLayerSatisfied({
      stems: ["edit_repo_file", "agent.repo.edit"],
      capName: "edit_repo_file",
      hasDirectFile: false,
      routeIndex,
    });
    expect(ok).toBe(true);
  });

  it("still fails a capability with no evidence anywhere (no blanket suppression)", () => {
    const routeIndex = buildApiRouteIndex([
      {
        name: "schema.ts",
        content: `import { schemaList } from "@oxagen/oxagen/contracts/schema.list";`,
      },
    ]);
    const ok = apiLayerSatisfied({
      stems: ["delete_everything", "danger.delete_everything"],
      capName: "delete_everything",
      hasDirectFile: false,
      routeIndex,
    });
    expect(ok).toBe(false);
  });
});

describe("manifestContentChanged", () => {
  const manifest = {
    capabilities: [
      {
        name: "list_members",
        file: "workspace.member.list.ts",
        domain: "org",
        mode: "sync",
        surfaces: ["api", "mcp"],
        layers: { schema: true, api: true },
      },
    ],
  };

  it("treats a formatting-only difference as unchanged", () => {
    // The committed file is Biome-formatted: arrays inline, and the script's
    // own JSON.stringify(…, 2) layout must compare equal to it.
    const biomeLayout = `{
  "capabilities": [
    {
      "name": "list_members",
      "file": "workspace.member.list.ts",
      "domain": "org",
      "mode": "sync",
      "surfaces": ["api", "mcp"],
      "layers": { "schema": true, "api": true }
    }
  ]
}
`;
    expect(manifestContentChanged(biomeLayout, manifest)).toBe(false);
    expect(
      manifestContentChanged(JSON.stringify(manifest, null, 2), manifest),
    ).toBe(false);
  });

  it("reports a content difference", () => {
    const changed = {
      capabilities: [
        { ...manifest.capabilities[0], layers: { schema: true, api: false } },
      ],
    };
    expect(manifestContentChanged(JSON.stringify(manifest), changed)).toBe(
      true,
    );
  });

  it("reports a missing or unparseable file as changed", () => {
    expect(manifestContentChanged("", manifest)).toBe(true);
    expect(manifestContentChanged("{ not json", manifest)).toBe(true);
  });
});
