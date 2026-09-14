import { describe, expect, it } from "vitest";
import { apiLayerSatisfied, buildApiRouteIndex } from "./check_manifest.mjs";

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
