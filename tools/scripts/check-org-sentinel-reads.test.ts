/**
 * A guard that cannot fail on the shape it exists for is decoration, so both
 * directions are asserted here against synthetic trees: the four policy classes
 * the sentinel narrows, the one it does not, the two forms the defect takes
 * (co-located scope, and a sentinel ctx handed across an invoke), and the
 * exemptions that keep a correct file from being reported.
 *
 * The fixtures write a miniature repo — a policy manifest, a schema module, a
 * handler register — because the real ones are what the check reads, and a test
 * that stubbed them would only assert that the regexes match themselves.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findSentinelNarrowedReads,
  pinsNullWorkspace,
  stripComments,
  tenantDbRegions,
} from "./check-org-sentinel-reads.mjs";

const SENTINEL = "00000000-0000-0000-0000-000000000000";

const MANIFEST = `export const POLICY_MANIFEST = [
  { table: "org.org_users", policyClass: "org_only" },
  { table: "security.security_events", policyClass: "workspace_nullable" },
  { table: "auth.api_keys", policyClass: "standard" },
  { table: "workspace.workspace_users", policyClass: "workspace_only" },
];
`;

const SCHEMAS = `import { pgSchema } from "drizzle-orm/pg-core";
export const orgSchema = pgSchema("org");
export const securitySchema = pgSchema("security");
export const authSchema = pgSchema("auth");
export const workspaceSchema = pgSchema("workspace");
`;

const TABLES = `import { authSchema, orgSchema, securitySchema, workspaceSchema } from "./_schemas";
export const orgUsers = orgSchema.table("org_users", {});
export const securityEvents = securitySchema.table("security_events", {});
export const apiKeys = authSchema.table("api_keys", {});
export const workspaceUsers = workspaceSchema.table("workspace_users", {});
`;

const roots: string[] = [];

/** A miniature repo the check can read, plus whatever source files are given. */
function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "sentinel-check-"));
  roots.push(root);
  const all: Record<string, string> = {
    "packages/database/src/tenant-policy.manifest.ts": MANIFEST,
    "packages/database/src/schema/_schemas.ts": SCHEMAS,
    "packages/database/src/schema/tables.ts": TABLES,
    "packages/handlers/src/register.ts": "",
    "packages/oxagen/src/contracts/org.member.remove.ts": `export const orgMemberRemove = registerCapability({
  name: "remove_org_member",
});
`,
    ...files,
  };
  for (const [path, contents] of Object.entries(all)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** An app file that scopes to the sentinel and reads `table` tenant-scoped. */
function colocated(table: string, extra = ""): string {
  return `import { schema, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
const ORG_ONLY_WS = "${SENTINEL}";
export async function load(orgId: string) {
  return runInTenantScope({ orgId, workspaceId: ORG_ONLY_WS }, () =>
    withTenantDb((tx) =>
      tx.select().from(schema.${table}).where(eq(schema.${table}.orgId, orgId)${extra}),
    ),
  );
}
`;
}

describe("the classes the sentinel narrows", () => {
  it.each([
    ["securityEvents", "security.security_events", "workspace_nullable"],
    ["apiKeys", "auth.api_keys", "standard"],
    ["workspaceUsers", "workspace.workspace_users", "workspace_only"],
  ])("reports a tenant-scoped read of %s", (table, name, policyClass) => {
    const root = makeTree({ "apps/app/src/page.ts": colocated(table) });
    const { findings } = findSentinelNarrowedReads(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      pass: "co-located",
      file: "apps/app/src/page.ts",
      tables: [{ export: table, table: name, policyClass }],
    });
  });

  it("passes an org_only table, the one class that ignores the workspace GUC", () => {
    const root = makeTree({ "apps/app/src/page.ts": colocated("orgUsers") });
    expect(findSentinelNarrowedReads(root).findings).toEqual([]);
  });

  it("passes a table the manifest does not policy at all", () => {
    const root = makeTree({
      "apps/app/src/page.ts": colocated("plans"),
    });
    expect(findSentinelNarrowedReads(root).findings).toEqual([]);
  });
});

describe("what makes a read correct", () => {
  it("passes a real workspace id in the scope", () => {
    const root = makeTree({
      "apps/app/src/page.ts": colocated("apiKeys").replace(
        "workspaceId: ORG_ONLY_WS",
        "workspaceId: ws.id",
      ),
    });
    expect(findSentinelNarrowedReads(root).findings).toEqual([]);
  });

  it("passes withSystemDb, the seam the fence belongs to", () => {
    const root = makeTree({
      "apps/app/src/page.ts": `import { schema, withSystemDb } from "@oxagen/database";
const ORG_ONLY_WS = "${SENTINEL}";
export const load = (orgId: string) =>
  withSystemDb((tx) => tx.select().from(schema.apiKeys).where(eq(schema.apiKeys.orgId, orgId)));
`,
    });
    expect(findSentinelNarrowedReads(root).findings).toEqual([]);
  });

  it("passes a workspace_nullable read that already pins workspace_id IS NULL", () => {
    const root = makeTree({
      "apps/app/src/page.ts": colocated(
        "securityEvents",
        ", isNull(schema.securityEvents.workspaceId)",
      ),
    });
    expect(findSentinelNarrowedReads(root).findings).toEqual([]);
  });

  it("does not let one pinned read exempt a second unpinned one", () => {
    const pinned = colocated(
      "securityEvents",
      ", isNull(schema.securityEvents.workspaceId)",
    );
    const root = makeTree({
      "apps/app/src/page.ts":
        pinned +
        `export const also = () =>
  withTenantDb((tx) => tx.select().from(schema.securityEvents));
`,
    });
    expect(findSentinelNarrowedReads(root).findings).toHaveLength(1);
  });
});

describe("the cross-surface form, where the scope and the query are in different packages", () => {
  const register = `registerHandler(
    "remove_org_member",
    async () => (await import("./org.member.remove")).h,
  );
`;
  const handler = `import { schema, withTenantDb } from "@oxagen/database";
export const h = async (input, ctx) =>
  withTenantDb((tx) =>
    tx.update(schema.apiKeys).set({}).where(eq(schema.apiKeys.orgId, ctx.orgId)),
  );
`;
  const action = `import { invoke } from "@oxagen/oxagen";
const ORG_ONLY_WS = "${SENTINEL}";
export async function removeMember(orgId: string, targetUserId: string) {
  const ctx = { orgId, workspaceId: ORG_ONLY_WS, userId: null, surface: "app" };
  return invoke("remove_org_member", { targetUserId }, ctx, { surface: "agent" });
}
`;

  it("follows the capability to its handler and names the table", () => {
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/org.member.remove.ts": handler,
      "apps/app/src/actions.ts": action,
    });
    const { findings } = findSentinelNarrowedReads(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      pass: "cross-surface",
      capability: "remove_org_member",
      handler: "packages/handlers/src/org.member.remove.ts",
      tables: [{ table: "auth.api_keys", policyClass: "standard" }],
    });
  });

  it("passes once the caller overrides workspaceId with a real one", () => {
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/org.member.remove.ts": handler,
      "apps/app/src/actions.ts": action.replace(
        'invoke("remove_org_member", { targetUserId }, ctx, { surface: "agent" })',
        'invoke("remove_org_member", { targetUserId }, { ...ctx, workspaceId }, { surface: "agent" })',
      ),
    });
    expect(findSentinelNarrowedReads(root).findings).toEqual([]);
  });

  it("passes once the handler reads through withSystemDb", () => {
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/org.member.remove.ts": handler.replace(
        /withTenantDb/g,
        "withSystemDb",
      ),
      "apps/app/src/actions.ts": action,
    });
    expect(findSentinelNarrowedReads(root).findings).toEqual([]);
  });

  it("resolves a contract export, which is how a surface usually names one", () => {
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/org.member.remove.ts": handler,
      "apps/app/src/actions.ts": action.replace(
        '"remove_org_member"',
        "orgMemberRemove.name",
      ),
    });
    const { findings } = findSentinelNarrowedReads(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ capability: "remove_org_member" });
  });

  it("falls back to every capability the file names when the invoke is indirect", () => {
    // The shape found on `main`: a readCapability(viewer, name, input) helper
    // holds the sentinel scope and the invoke, and the capability is named at
    // the helper's call sites. Neither a literal nor a contract export reaches
    // the invoke itself.
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/org.member.remove.ts": handler,
      "apps/app/src/actions.ts": `import { invoke } from "@oxagen/oxagen";
const ORG_ONLY_WS = "${SENTINEL}";
function ctxFor(orgId: string) {
  return { orgId, workspaceId: ORG_ONLY_WS, userId: null, surface: "app" };
}
async function read(orgId: string, name: string, input: unknown) {
  return invoke(name, input, ctxFor(orgId), { surface: "agent" });
}
export const removeMember = (orgId: string, targetUserId: string) =>
  read(orgId, orgMemberRemove.name, { targetUserId });
`,
    });
    const { findings } = findSentinelNarrowedReads(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ capability: "remove_org_member" });
  });

  it("merges a file and capability reported more than once into one finding", () => {
    // A handler and one of its relative imports can each name a narrowed table.
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/org.member.remove.ts":
        handler +
        `export { helper } from "./lib/helper";
`,
      "packages/handlers/src/lib/helper.ts": `import { schema, withTenantDb } from "@oxagen/database";
export const helper = () =>
  withTenantDb((tx) => tx.select().from(schema.workspaceUsers));
`,
      "apps/app/src/actions.ts": action,
    });
    const { findings } = findSentinelNarrowedReads(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.tables.map((t: { table: string }) => t.table)).toEqual([
      "auth.api_keys",
      "workspace.workspace_users",
    ]);
  });

  it("reads the shared ORG_ONLY_WORKSPACE_ID, not only a local copy", () => {
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/org.member.remove.ts": handler,
      "apps/app/src/actions.ts": action
        .replace(`const ORG_ONLY_WS = "${SENTINEL}";`, "")
        .replace(
          'import { invoke } from "@oxagen/oxagen";',
          'import { invoke } from "@oxagen/oxagen";\nimport { ORG_ONLY_WORKSPACE_ID } from "@oxagen/tenancy";',
        )
        .replace(
          "workspaceId: ORG_ONLY_WS",
          "workspaceId: ORG_ONLY_WORKSPACE_ID",
        ),
    });
    expect(findSentinelNarrowedReads(root).findings).toHaveLength(1);
  });
});

describe("stripComments", () => {
  it("blanks a prose mention so it does not read as a call", () => {
    const src = `// WHY withSystemDb AND NOT withTenantDb: …\nconst a = 1;\n`;
    expect(stripComments(src)).not.toMatch(/withTenantDb/);
    expect(stripComments(src)).toContain("const a = 1;");
  });

  it("keeps a URL in code intact — '//' after a colon is not a comment", () => {
    expect(stripComments('const u = "https://x/y";\n')).toContain(
      "https://x/y",
    );
  });

  it("preserves line numbering so a finding still points at the right place", () => {
    const src = "/* one\ntwo */\nconst a = 1;\n";
    expect(stripComments(src).split("\n")).toHaveLength(src.split("\n").length);
  });
});

describe("tenantDbRegions", () => {
  it("brace-matches the call rather than running to the end of the file", () => {
    const src =
      "withTenantDb((tx) => tx.select().from(schema.a));\nwithSystemDb((tx) => tx.select().from(schema.b));\n";
    const regions = tenantDbRegions(src);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toContain("schema.a");
    expect(regions[0]).not.toContain("schema.b");
  });
});

describe("pinsNullWorkspace", () => {
  it("counts an INSERT that names no workspaceId as already NULL-scoped", () => {
    const region =
      ".insert(schema.securityEvents).values({ orgId, eventType });";
    expect(pinsNullWorkspace("securityEvents", [region])).toBe(true);
  });

  it("does not exempt an INSERT that names a workspace", () => {
    const region =
      ".insert(schema.securityEvents).values({ orgId, workspaceId: ws.id });";
    expect(pinsNullWorkspace("securityEvents", [region])).toBe(false);
  });
});
