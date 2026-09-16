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
  callsTo,
  carriesSentinel,
  findSentinelNarrowedReads,
  parse,
  pinsNullWorkspace,
  residualTableForms,
  sentinelNames,
  tableResolver,
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

  it("does not let one pinned read exempt a second unpinned one in the same scope", () => {
    const root = makeTree({
      "apps/app/src/page.ts": `import { schema, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
const ORG_ONLY_WS = "${SENTINEL}";
export async function load(orgId: string) {
  return runInTenantScope({ orgId, workspaceId: ORG_ONLY_WS }, async () => {
    await withTenantDb((tx) =>
      tx.select().from(schema.securityEvents).where(isNull(schema.securityEvents.workspaceId)),
    );
    return withTenantDb((tx) => tx.select().from(schema.securityEvents));
  });
}
`,
    });
    expect(findSentinelNarrowedReads(root).findings).toHaveLength(1);
  });

  it("ignores a tenant read outside the sentinel scope in the same file", () => {
    // conversation-page.tsx: an org_only credit_lots read under the sentinel,
    // everything else under the real workspace. A file-level answer called that
    // a finding; it is not one.
    const root = makeTree({
      "apps/app/src/page.ts": `import { schema, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
const ORG_ONLY_WS = "${SENTINEL}";
export async function load(orgId: string, wsId: string) {
  await runInTenantScope({ orgId, workspaceId: ORG_ONLY_WS }, () =>
    withTenantDb((tx) => tx.select().from(schema.orgUsers)),
  );
  return runInTenantScope({ orgId, workspaceId: wsId }, () =>
    withTenantDb((tx) => tx.select().from(schema.apiKeys)),
  );
}
`,
    });
    expect(findSentinelNarrowedReads(root).findings).toEqual([]);
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

describe("parsing, which replaced the regexes", () => {
  it("does not read a prose mention of withTenantDb as a call", () => {
    // The regex era needed a comment stripper for exactly this. Comments are
    // not nodes, so the parser never saw them in the first place.
    const sf = parse(
      `// WHY withSystemDb AND NOT withTenantDb: …\nconst a = 1;\n`,
    );
    expect(tenantDbRegions(sf)).toHaveLength(0);
  });

  it("does not read a table name inside a string as a table", () => {
    const sf = parse(`const sql = "select * from schema.apiKeys";\n`);
    expect(tenantDbRegions(sf)).toHaveLength(0);
  });

  it("finds the call and not the one beside it", () => {
    const sf = parse(
      `withTenantDb((tx) => tx.select().from(schema.a));\nwithSystemDb((tx) => tx.select().from(schema.b));\n`,
    );
    const regions = tenantDbRegions(sf);
    expect(regions).toHaveLength(1);
    expect(regions[0].getText()).toContain("schema.a");
    expect(regions[0].getText()).not.toContain("schema.b");
  });
});

describe("carriesSentinel", () => {
  const withSentinel = (ctx: string) =>
    parse(
      `const ORG_ONLY_WS = "${SENTINEL}";\nconst x = invoke("c", {}, ${ctx});\n`,
    );

  function ctxArg(src: ReturnType<typeof parse>) {
    const call = callsTo(src, "invoke")[0];
    return carriesSentinel(call.arguments[2], src, sentinelNames(src));
  }

  it("reads an INLINE object literal, the shape the regex could not", () => {
    // Both invoke() calls in org-privacy-actions.ts have this shape, and the
    // regex required the third argument to end in an identifier, so it examined
    // neither — a mandatory check reporting clean on a shape it could not read.
    expect(
      ctxArg(
        withSentinel(
          `{ userId: u, orgId: o, workspaceId: ORG_ONLY_WS, apiKeyId: null }`,
        ),
      ),
    ).toBe(true);
  });

  it("reads the bare literal inline, with no named constant anywhere", () => {
    const src = parse(
      `const x = invoke("c", {}, { orgId: o, workspaceId: "${SENTINEL}" });\n`,
    );
    expect(ctxArg(src)).toBe(true);
  });

  it("resolves a named const to its object", () => {
    const src = parse(
      `const ORG_ONLY_WS = "${SENTINEL}";\nconst ctx = { orgId: o, workspaceId: ORG_ONLY_WS };\nconst x = invoke("c", {}, ctx);\n`,
    );
    expect(ctxArg(src)).toBe(true);
  });

  it("resolves a local factory to the object it returns", () => {
    const src = parse(
      `const ORG_ONLY_WS = "${SENTINEL}";\nfunction buildCtx(o) { return { orgId: o, workspaceId: ORG_ONLY_WS }; }\nconst ctx = buildCtx(org);\nconst x = invoke("c", {}, ctx);\n`,
    );
    expect(ctxArg(src)).toBe(true);
  });

  it("reads an override after a spread as a real workspace", () => {
    const src = parse(
      `const ORG_ONLY_WS = "${SENTINEL}";\nconst base = { workspaceId: ORG_ONLY_WS };\nconst x = invoke("c", {}, { ...base, workspaceId });\n`,
    );
    expect(ctxArg(src)).toBe(false);
  });

  it("reads a real workspace id as a real workspace", () => {
    expect(ctxArg(withSentinel(`{ orgId: o, workspaceId: ws.id }`))).toBe(
      false,
    );
  });

  it("reads the apps/api capabilityContext seam", () => {
    const src = parse(
      `const ctx = capabilityContext(c, { requireWorkspace: false });\nconst x = invoke("c", {}, ctx);\n`,
    );
    expect(ctxArg(src)).toBe(true);
  });

  it("leaves capabilityContext alone when it requires a workspace", () => {
    const src = parse(
      `const ctx = capabilityContext(c);\nconst x = invoke("c", {}, ctx);\n`,
    );
    expect(ctxArg(src)).toBe(false);
  });
});

describe("pinsNullWorkspace", () => {
  it("counts an INSERT that names no workspaceId as already NULL-scoped", () => {
    const sf = parse(
      `withTenantDb((tx) => tx.insert(schema.securityEvents).values({ orgId }));`,
    );
    expect(
      pinsNullWorkspace(
        "securityEvents",
        tenantDbRegions(sf),
        tableResolver(sf),
      ),
    ).toBe(true);
  });

  it("does not exempt an INSERT that names a workspace", () => {
    const sf = parse(
      `withTenantDb((tx) => tx.insert(schema.securityEvents).values({ orgId, workspaceId: ws.id }));`,
    );
    expect(
      pinsNullWorkspace(
        "securityEvents",
        tenantDbRegions(sf),
        tableResolver(sf),
      ),
    ).toBe(false);
  });

  it("does not let one pinned read exempt a second unpinned one", () => {
    const sf = parse(
      `withTenantDb((tx) => {
         tx.select().from(schema.securityEvents).where(isNull(schema.securityEvents.workspaceId));
         return tx.select().from(schema.securityEvents);
       });`,
    );
    expect(
      pinsNullWorkspace(
        "securityEvents",
        tenantDbRegions(sf),
        tableResolver(sf),
      ),
    ).toBe(false);
  });

  it("does not let ONE statement's two predicates cover a second statement", () => {
    // The aggregate bug, exactly: the totals matched — two statements, two
    // isNull predicates — while the second statement was entirely unpinned, so
    // the table was exempted and the check reported clean. Every statement
    // answers for itself now.
    const sf = parse(
      `withTenantDb((tx) => {
         tx.select().from(schema.securityEvents).where(
           and(
             isNull(schema.securityEvents.workspaceId),
             or(isNull(schema.securityEvents.workspaceId), gt(a, b)),
           ),
         );
         return tx.select().from(schema.securityEvents).where(eq(schema.securityEvents.orgId, orgId));
       });`,
    );
    expect(
      pinsNullWorkspace(
        "securityEvents",
        tenantDbRegions(sf),
        tableResolver(sf),
      ),
    ).toBe(false);
  });

  it("still exempts a table when every statement pins it", () => {
    const sf = parse(
      `withTenantDb((tx) => {
         tx.select().from(schema.securityEvents).where(isNull(schema.securityEvents.workspaceId));
         return tx.select().from(schema.securityEvents).where(isNull(schema.securityEvents.workspaceId));
       });`,
    );
    expect(
      pinsNullWorkspace(
        "securityEvents",
        tenantDbRegions(sf),
        tableResolver(sf),
      ),
    ).toBe(true);
  });

  it("does not accept a pin inside an `or`, which is an alternative not a constraint", () => {
    // `where(or(isNull(t.workspaceId), eq(t.workspaceId, requested)))` reads the
    // org-wide rows AND one workspace's on purpose, and the sentinel still
    // truncates the second branch. Presence in the AST is not the same as being
    // true on every path.
    const sf = parse(
      `withTenantDb((tx) =>
         tx.select().from(schema.securityEvents).where(
           or(isNull(schema.securityEvents.workspaceId), eq(schema.securityEvents.workspaceId, requested)),
         ),
       );`,
    );
    expect(
      pinsNullWorkspace(
        "securityEvents",
        tenantDbRegions(sf),
        tableResolver(sf),
      ),
    ).toBe(false);
  });

  it("accepts a pin nested in `and`, which does propagate", () => {
    const sf = parse(
      `withTenantDb((tx) =>
         tx.select().from(schema.securityEvents).where(
           and(eq(schema.securityEvents.orgId, o), and(isNull(schema.securityEvents.workspaceId), gt(a, b))),
         ),
       );`,
    );
    expect(
      pinsNullWorkspace(
        "securityEvents",
        tenantDbRegions(sf),
        tableResolver(sf),
      ),
    ).toBe(true);
  });

  it("does not accept a statement with no where clause at all", () => {
    const sf = parse(
      `withTenantDb((tx) => tx.select().from(schema.securityEvents));`,
    );
    expect(
      pinsNullWorkspace(
        "securityEvents",
        tenantDbRegions(sf),
        tableResolver(sf),
      ),
    ).toBe(false);
  });

  it("does not let a pinned read in one scope exempt an unpinned read in another", () => {
    // Pass A pools the regions of every sentinel-carrying scope in a file, so
    // the same leak ran across scopes until the judgement went per statement.
    const sf = parse(
      `runInTenantScope(a, () =>
         withTenantDb((tx) => tx.select().from(schema.securityEvents).where(isNull(schema.securityEvents.workspaceId))),
       );
       runInTenantScope(b, () =>
         withTenantDb((tx) => tx.select().from(schema.securityEvents)),
       );`,
    );
    expect(
      pinsNullWorkspace(
        "securityEvents",
        tenantDbRegions(sf),
        tableResolver(sf),
      ),
    ).toBe(false);
  });
});

describe("the apps/app kernel seam, where invoke() is in another file", () => {
  const register = `registerHandler(
    "list_api_keys",
    async () => (await import("./api.key.list")).h,
  );
`;
  const handler = `import { schema, withTenantDb } from "@oxagen/database";
export const h = async (input, ctx) =>
  withTenantDb((tx) =>
    tx.select().from(schema.apiKeys).where(eq(schema.apiKeys.orgId, ctx.orgId)),
  );
`;
  const contract = `export const apiKeyList = registerCapability({
  name: "list_api_keys",
});
`;
  /** A live adapter: no invoke(), no sentinel literal, just kernelRead. */
  const adapter = `import { kernelRead } from "@/server/kernel";
import { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
export const org = {
  async apiKeys(ctx) {
    const read = await kernelRead(ctx, {
      contract: apiKeyList,
      input: {},
      page: "organization",
    });
    return read;
  },
};
`;

  function tree(portsLine: string) {
    return makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/api.key.list.ts": handler,
      "packages/oxagen/src/contracts/api.key.list.ts": contract,
      "apps/app/src/data/ports.ts": `export interface DataSource {
  org: {
    ${portsLine}
  };
}
`,
      "apps/app/src/data/live/org.ts": adapter,
    });
  }

  it("follows an OrgCtx port method through kernelRead to the handler", () => {
    // The sentinel appears in NEITHER file: capabilityContext in
    // src/server/kernel.ts converts an OrgCtx, and that file is not this one.
    const { findings } = findSentinelNarrowedReads(
      tree("apiKeys(ctx: OrgCtx): Promise<Read<ApiKey[]>>;"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      pass: "app-kernel-seam",
      file: "apps/app/src/data/live/org.ts (apiKeys)",
      capability: "list_api_keys",
      tables: [{ table: "auth.api_keys", policyClass: "standard" }],
    });
  });

  it("passes the same method once the port takes a WsCtx", () => {
    // ADR-073's fix, and the check recognises it.
    expect(
      findSentinelNarrowedReads(
        tree("apiKeys(ctx: WsCtx): Promise<Read<ApiKey[]>>;"),
      ).findings,
    ).toEqual([]);
  });

  it("drops a method name declared both ways rather than guessing", () => {
    const { findings } = findSentinelNarrowedReads(
      tree(
        "apiKeys(ctx: OrgCtx): Promise<Read<ApiKey[]>>;\n    apiKeys(ctx: WsCtx): Promise<Read<ApiKey[]>>;",
      ),
    );
    expect(findings).toEqual([]);
  });
});

describe("the baseline, which ratchets down", () => {
  const register = `registerHandler(
    "remove_org_member",
    async () => (await import("./org.member.remove")).h,
  );
`;
  const handler = `import { schema, withTenantDb } from "@oxagen/database";
export const h = async (input, ctx) =>
  withTenantDb((tx) => tx.select().from(schema.apiKeys));
`;
  const action = `import { invoke } from "@oxagen/oxagen";
const ORG_ONLY_WS = "${SENTINEL}";
export async function removeMember(orgId: string, targetUserId: string) {
  const ctx = { orgId, workspaceId: ORG_ONLY_WS, userId: null, surface: "app" };
  return invoke("remove_org_member", { targetUserId }, ctx, { surface: "agent" });
}
`;
  const waiver = (file: string) =>
    JSON.stringify({
      waived: [
        {
          file,
          capability: "remove_org_member",
          tables: ["auth.api_keys"],
          reason: "x",
          fixedBy: "#1",
        },
      ],
    });

  it("waives a finding it names, and says how many", () => {
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/org.member.remove.ts": handler,
      "apps/app/src/actions.ts": action,
      "tools/scripts/org-sentinel-reads-baseline.json": waiver(
        "apps/app/src/actions.ts",
      ),
    });
    const out = findSentinelNarrowedReads(root);
    expect(out.findings).toEqual([]);
    expect(out.waived).toBe(1);
    expect(out.staleWaivers).toEqual([]);
  });

  it("reports an entry that matches nothing, so a waiver cannot outlive its defect", () => {
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/org.member.remove.ts": handler.replace(
        /withTenantDb/g,
        "withSystemDb",
      ),
      "apps/app/src/actions.ts": action,
      "tools/scripts/org-sentinel-reads-baseline.json": waiver(
        "apps/app/src/actions.ts",
      ),
    });
    const out = findSentinelNarrowedReads(root);
    expect(out.findings).toEqual([]);
    expect(out.staleWaivers).toHaveLength(1);
  });

  it("does not waive a new table at the same site", () => {
    // The rot this key shape exists to prevent: a waiver keyed on site and
    // capability alone would keep matching after the handler grew a SECOND
    // narrowed table, suppressing a new defect while still reading as live.
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/org.member.remove.ts": `import { schema, withTenantDb } from "@oxagen/database";
export const h = async (input, ctx) =>
  withTenantDb((tx) => {
    tx.select().from(schema.apiKeys);
    return tx.select().from(schema.workspaceUsers);
  });
`,
      "apps/app/src/actions.ts": action,
      "tools/scripts/org-sentinel-reads-baseline.json": JSON.stringify({
        waived: [
          {
            file: "apps/app/src/actions.ts",
            capability: "remove_org_member",
            tables: ["auth.api_keys"],
            reason: "x",
            fixedBy: "#1",
          },
        ],
      }),
    });
    const out = findSentinelNarrowedReads(root);
    // Reported twice, and both are true: a finding whose table set the waiver
    // does not cover, and a waiver that now matches nothing.
    expect(out.findings).toHaveLength(1);
    expect(
      out.findings[0]?.tables.map((t: { table: string }) => t.table),
    ).toEqual(["auth.api_keys", "workspace.workspace_users"]);
    expect(out.staleWaivers).toHaveLength(1);
  });

  it("does not waive a different site with the same capability", () => {
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/org.member.remove.ts": handler,
      "apps/app/src/actions.ts": action,
      "tools/scripts/org-sentinel-reads-baseline.json": waiver(
        "apps/app/src/somewhere-else.ts",
      ),
    });
    const out = findSentinelNarrowedReads(root);
    expect(out.findings).toHaveLength(1);
    expect(out.staleWaivers).toHaveLength(1);
  });
});

describe("the other two wrappers around invoke()", () => {
  const register = `registerHandler(
    "create_workspace",
    async () => (await import("./workspace.create")).h,
  );
`;
  const handler = `import { schema, withTenantDb } from "@oxagen/database";
export const h = async (input, ctx) =>
  withTenantDb((tx) => tx.select().from(schema.workspaceUsers));
`;

  it("sees an apps/api route whose sentinel is inside capabilityContext", () => {
    // The route names neither the constant nor the literal — the sentinel is
    // introduced by capabilityContext(c, { requireWorkspace: false }).
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/workspace.create.ts": handler,
      "apps/api/src/routes/v1/workspace.create.ts": `import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
route.post("/", async (c) => {
  const ctx = capabilityContext(c, { requireWorkspace: false });
  const out = await invoke("create_workspace", body, ctx, { surface: "api" });
  return c.json(out);
});
`,
    });
    const { findings } = findSentinelNarrowedReads(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ capability: "create_workspace" });
  });

  it("leaves a route that requires a workspace alone", () => {
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/workspace.create.ts": handler,
      "apps/api/src/routes/v1/workspace.create.ts": `import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
route.post("/", async (c) => {
  const ctx = capabilityContext(c);
  const out = await invoke("create_workspace", body, ctx, { surface: "api" });
  return c.json(out);
});
`,
    });
    expect(findSentinelNarrowedReads(root).findings).toEqual([]);
  });

  it("sees invokeOrgCapability, which builds the ctx and calls invoke itself", () => {
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/workspace.create.ts": handler,
      "apps/app/src/app/governance/page.tsx": `import { invokeOrgCapability } from "../_lib/invoke-org";
export default async function Page() {
  return invokeOrgCapability<Out>(tenant.id, session.user.id, "create_workspace", {
    limit: 1000,
  });
}
`,
    });
    const { findings } = findSentinelNarrowedReads(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ capability: "create_workspace" });
  });
});

describe("how a read names its table", () => {
  const tablesOf = (src: string) => {
    const sf = parse(src);
    const r = tableResolver(sf);
    return [...r.tablesIn(sf)];
  };

  it("reads the plain form", () => {
    expect(tablesOf(`tx.select().from(schema.apiKeys);`)).toContain("apiKeys");
  });

  it("follows an import alias — `import { schema as db }`", () => {
    // schema.relationship.delete.ts does this today.
    expect(
      tablesOf(
        `import { schema as db, withTenantDb } from "@oxagen/database";\ntx.select().from(db.apiKeys);`,
      ),
    ).toContain("apiKeys");
  });

  it("follows a local binding — `const se = schema.securityEvents`", () => {
    // audit.shared.ts and run.list.ts do this today, five bindings between them.
    expect(
      tablesOf(
        `const se = schema.securityEvents;\ntx.select().from(se).where(eq(se.orgId, o));`,
      ),
    ).toContain("securityEvents");
  });

  it("follows a destructured binding, including a rename", () => {
    expect(
      tablesOf(`const { apiKeys, users: u } = schema;\ntx.select().from(u);`),
    ).toEqual(expect.arrayContaining(["apiKeys", "users"]));
  });

  it("follows an alias and a binding together", () => {
    expect(
      tablesOf(
        `import { schema as db } from "@oxagen/database";\nconst t = db.workspaceUsers;\ntx.select().from(t);`,
      ),
    ).toContain("workspaceUsers");
  });

  it("still reads tx.query.<table>", () => {
    expect(tablesOf(`tx.query.routingPolicy.findFirst({});`)).toContain(
      "routingPolicy",
    );
  });

  // The limit, asserted rather than described. Each of these is a real way to
  // name a table that this check cannot resolve, and ADR-074 says so. They are
  // tests so the boundary moves deliberately rather than by accident.
  it("does NOT resolve a table imported straight from a schema module", () => {
    expect(
      tablesOf(
        `import { apiKeys } from "@oxagen/database/schema/auth";\ntx.select().from(apiKeys);`,
      ),
    ).not.toContain("apiKeys");
  });

  it("does NOT resolve a table passed in as a parameter", () => {
    expect(
      tablesOf(`function read(tx, table) { return tx.select().from(table); }`),
    ).toEqual([]);
  });

  it("over-approximates a table chosen at runtime, rather than missing it", () => {
    // Both candidates are spelled in the file, so both are reported. That is
    // the safe direction — a false positive, not a miss — and it is why this
    // form is listed as over-approximated rather than as a gap.
    expect(
      tablesOf(
        `const t = cond ? schema.apiKeys : schema.users;\ntx.select().from(t);`,
      ),
    ).toEqual(expect.arrayContaining(["apiKeys", "users"]));
  });

  it("publishes the residual forms so the limit is readable, not folklore", () => {
    expect(residualTableForms).toHaveLength(3);
    expect(residualTableForms.join(" ")).toMatch(/parameter/);
    expect(residualTableForms.join(" ")).toMatch(/module resolution/);
  });
});

describe("a handler that delegates its queries", () => {
  const register = `registerHandler(
    "add_plugin_registry",
    async () => (await import("./plugin.registry.add")).h,
  );
`;
  /** Opens the transaction, hands `tx` to a helper. Touches no table itself. */
  const entry = `import { withTenantDb } from "@oxagen/database";
import { addRegistry } from "./registry-default";
export const h = async (input, ctx) =>
  withTenantDb((tx) => addRegistry(tx, { orgId: ctx.orgId }));
`;
  const helper = `import { schema } from "@oxagen/database";
export const addRegistry = (tx, args) =>
  tx.insert(schema.apiKeys).values({ orgId: args.orgId, workspaceId: args.ws });
`;
  const action = `import { invoke } from "@oxagen/oxagen";
const ORG_ONLY_WS = "${SENTINEL}";
export const add = (orgId: string) =>
  invoke("add_plugin_registry", {}, { orgId, workspaceId: ORG_ONLY_WS });
`;

  it("follows the tables into the helper the transaction was handed to", () => {
    // The helper has no withTenantDb of its own BECAUSE the caller opened one.
    // Discarding it for that was backwards, and left the call site out of the
    // inventory entirely.
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/plugin.registry.add.ts": entry,
      "packages/handlers/src/registry-default.ts": helper,
      "apps/app/src/actions.ts": action,
    });
    const { findings } = findSentinelNarrowedReads(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.tables.map((t: { table: string }) => t.table)).toEqual([
      "auth.api_keys",
    ]);
  });

  it("leaves the helper alone when the handler opens no transaction", () => {
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/plugin.registry.add.ts": entry.replace(
        /withTenantDb/g,
        "withSystemDb",
      ),
      "packages/handlers/src/registry-default.ts": helper,
      "apps/app/src/actions.ts": action,
    });
    expect(findSentinelNarrowedReads(root).findings).toEqual([]);
  });
});

describe("ADR-068's transaction re-entry", () => {
  const tablesOf = (src: string) => {
    const sf = parse(src);
    return [...tableResolver(sf).tablesIn(sf)];
  };

  it("skips a write after setTransactionWorkspaceScope, which is at a real workspace", () => {
    // workspace-bootstrap: the workspace does not exist until the transaction
    // is under way, so ADR-068 §5 allows re-pointing the GUC onto the new row
    // before writing anything workspace-scoped.
    expect(
      tablesOf(
        `await setTransactionWorkspaceScope(tx, ws.id);\nawait tx.insert(schema.workspaceUsers).values({ workspaceId: ws.id });`,
      ),
    ).toEqual([]);
  });

  it("still judges a statement BEFORE the re-entry", () => {
    expect(
      tablesOf(
        `await tx.select().from(schema.apiKeys);\nawait setTransactionWorkspaceScope(tx, ws.id);\nawait tx.insert(schema.workspaceUsers).values({});`,
      ),
    ).toEqual(["apiKeys"]);
  });
});

describe("invokeOrgCapability through a local wrapper", () => {
  const register = `registerHandler(
    "list_capability_registry",
    async () => (await import("./capability.registry.list")).h,
  );
`;
  const handler = `import { schema, withTenantDb } from "@oxagen/database";
export const h = async () => withTenantDb((tx) => tx.select().from(schema.apiKeys));
`;

  it("scans the file's capability names when the wrapper forwards its parameter", () => {
    // governance/page.tsx: safeInvoke(orgId, userId, name, input) forwards
    // `name`, so the capability strings are at the WRAPPER's call sites. The
    // direct invoke() path already had this branch; this one never got it.
    const root = makeTree({
      "packages/handlers/src/register.ts": register,
      "packages/handlers/src/capability.registry.list.ts": handler,
      "apps/app/src/page.tsx": `import { invokeOrgCapability } from "./_lib/invoke-org";
async function safeInvoke<T>(orgId: string, userId: string, name: string, input: unknown) {
  return invokeOrgCapability<T>(orgId, userId, name, input);
}
export default async function Page() {
  return safeInvoke(tenant.id, userId, "list_capability_registry", { limit: 10 });
}
`,
    });
    const { findings } = findSentinelNarrowedReads(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      capability: "list_capability_registry",
    });
  });
});
