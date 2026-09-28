/**
 * Two branches that each add a table and a capability merge to `main` with no
 * conflict in `storage-manifest.json` (#3691, ADR-214).
 *
 * The manifest used to commit a `contentHash` over its body and a
 * `tableCount` per store. Every branch that added a table or a capability
 * rewrote both lines, so any two such branches conflicted by construction,
 * and `main` moving re-conflicted every open branch that carried one. This
 * test runs `git merge` in a real temporary repository over manifests built
 * by the real assembler, so the proof holds at the level git works at. The
 * control keeps the two old fields and shows the same branches conflicting,
 * so the test cannot pass for a reason other than the change it guards.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, contentHashOf } from "./canonical-json";
import { assembleManifest } from "./generate";
import type { ManifestCapability, ManifestTable, StoreKind } from "./types";

function table(id: string): ManifestTable {
  const [store, rest] = id.split(":") as [StoreKind, string];
  const [domain, name] = rest.split(".") as [string, string];
  return {
    id,
    store,
    domain,
    name,
    tenantScoped: true,
    columns: [
      { name: "id", type: "uuid", nullable: false, primaryKey: true },
      { name: "org_id", type: "uuid", nullable: false, primaryKey: false },
    ],
  };
}

function capability(
  name: string,
  domain: string,
  writes: string[] = [],
): ManifestCapability {
  return { name, domain, surfaces: ["api", "mcp"], reads: [], writes };
}

const BASE_TABLES = [
  "clickhouse:telemetry.token_usage",
  "postgres:agent.agents",
  "postgres:agent.runs",
  "postgres:billing.invoices",
  "postgres:billing.plans",
  "postgres:org.members",
  "postgres:org.organizations",
].map(table);

const BASE_CAPABILITIES = [
  capability("get_agent", "agent"),
  capability("get_invoice", "billing"),
  capability("get_org", "org"),
  capability("list_agents", "agent"),
  capability("list_invoices", "billing"),
  capability("list_members", "org"),
];

// Branch A adds one Postgres table and one capability. Branch B adds two
// Postgres tables and one capability, so the old per-store count differs
// between them (7 against 8), as `generatedCount` did in the incident (338
// against 340). Both add to the `postgres` store, the case the old count
// could never merge.
const BRANCH_A = {
  tables: [table("postgres:agent.notes")],
  capabilities: [
    capability("delete_agent", "agent", ["postgres:agent.agents"]),
  ],
};
const BRANCH_B = {
  tables: [
    table("postgres:billing.credits"),
    table("postgres:billing.refunds"),
  ],
  capabilities: [
    capability("issue_refund", "billing", ["postgres:billing.refunds"]),
  ],
};

type Render = (
  tables: readonly ManifestTable[],
  capabilities: readonly ManifestCapability[],
) => string;

/** The committed form this change introduces. */
const render: Render = (tables, capabilities) =>
  canonicalJson(assembleManifest(tables, capabilities));

/**
 * The committed form before ADR-214: the same manifest with `contentHash` and
 * a per-store `tableCount` added back, exactly as the generator wrote them.
 */
const renderLegacy: Render = (tables, capabilities) => {
  const m = assembleManifest(tables, capabilities);
  return canonicalJson({
    contentHash: contentHashOf(m),
    ...m,
    stores: m.stores.map((s) => ({
      ...s,
      tableCount: m.tables.filter((t) => t.store === s.kind).length,
    })),
  });
};

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function commitManifest(cwd: string, contents: string, message: string): void {
  writeFileSync(join(cwd, "storage-manifest.json"), contents);
  git(cwd, ["add", "storage-manifest.json"]);
  git(cwd, ["commit", "-q", "-m", message]);
}

function tryMerge(cwd: string, branch: string): boolean {
  try {
    git(cwd, ["merge", "--no-edit", "-q", branch]);
    return true;
  } catch {
    return false;
  }
}

describe("two branches that each add a table and a capability", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "storage-manifest-merge-"));
    git(repo, ["init", "-q", "-b", "main"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** Commit base, branch A and branch B, merge A then B into main. */
  function mergeBoth(renderWith: Render): boolean {
    commitManifest(repo, renderWith(BASE_TABLES, BASE_CAPABILITIES), "base");
    git(repo, ["checkout", "-q", "-b", "a"]);
    commitManifest(
      repo,
      renderWith(
        [...BASE_TABLES, ...BRANCH_A.tables],
        [...BASE_CAPABILITIES, ...BRANCH_A.capabilities],
      ),
      "a: add agent.notes and delete_agent",
    );
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["checkout", "-q", "-b", "b"]);
    commitManifest(
      repo,
      renderWith(
        [...BASE_TABLES, ...BRANCH_B.tables],
        [...BASE_CAPABILITIES, ...BRANCH_B.capabilities],
      ),
      "b: add billing.credits, billing.refunds and issue_refund",
    );
    git(repo, ["checkout", "-q", "main"]);
    expect(tryMerge(repo, "a")).toBe(true);
    return tryMerge(repo, "b");
  }

  it("merge cleanly, into exactly the manifest the merged sources generate", () => {
    expect(mergeBoth(render)).toBe(true);
    const merged = readFileSync(join(repo, "storage-manifest.json"), "utf8");
    expect(merged).not.toContain("<<<<<<<");
    // Not only conflict-free: byte-equal to regenerating from the merged
    // sources, which is what `pnpm schema:manifest:check` compares.
    expect(merged).toBe(
      render(
        [...BASE_TABLES, ...BRANCH_A.tables, ...BRANCH_B.tables],
        [
          ...BASE_CAPABILITIES,
          ...BRANCH_A.capabilities,
          ...BRANCH_B.capabilities,
        ],
      ),
    );
  });

  it("conflicted under the old shape with contentHash and tableCount (control)", () => {
    expect(mergeBoth(renderLegacy)).toBe(false);
    const conflicted = readFileSync(
      join(repo, "storage-manifest.json"),
      "utf8",
    );
    // The conflicts sit on the two derived lines, not on the content.
    const hunks = [
      ...conflicted.matchAll(/^<<<<<<< [^\n]*\n([\s\S]*?)^>>>>>>> /gm),
    ].map((m) => m[1] ?? "");
    expect(hunks.length).toBeGreaterThan(0);
    expect(hunks.some((hunk) => hunk.includes('"contentHash"'))).toBe(true);
    expect(hunks.some((hunk) => hunk.includes('"tableCount"'))).toBe(true);
    for (const hunk of hunks) {
      expect(hunk).toMatch(/"contentHash"|"tableCount"/);
    }
  });
});
