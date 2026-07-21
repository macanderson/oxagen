import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const seedSource = readFileSync(
  join(import.meta.dirname, "seed-iam-defaults.ts"),
  "utf8",
);

describe("Agent RBAC IAM defaults seed", () => {
  it("seeds exactly the three system workspace role ceilings from capability metadata", () => {
    // Scope to the AGENT_ROLE_NAMES array literal — the authoritative list of
    // role names this script actually seeds — rather than every quoted
    // "Agent ..." string in the file (which also matches the legacy-role
    // cleanup query/comments referencing "Agent Legacy*" as something to
    // actively DELETE, not seed).
    const roleNamesArrayMatch = /AGENT_ROLE_NAMES\s*=\s*\[([\s\S]*?)\]/.exec(
      seedSource,
    );
    expect(roleNamesArrayMatch).not.toBeNull();
    const agentRoleNames = [
      ...(roleNamesArrayMatch?.[1] ?? "").matchAll(
        /["'`](Agent [^"'`]+)["'`]/g,
      ),
    ].map((match) => match[1]);

    expect(new Set(agentRoleNames)).toEqual(
      new Set(["Agent Observer", "Agent Contributor", "Agent Operator"]),
    );

    // Roles are persisted as read-only system workspace defaults and re-runs
    // update existing rows rather than leaving stale policy behind.
    expect(seedSource).toMatch(/INSERT\s+INTO\s+iam\.roles/i);
    expect(seedSource).toMatch(/scope_kind[\s\S]*workspace/i);
    expect(seedSource).toMatch(/is_system_default[\s\S]*true/i);
    expect(seedSource).toMatch(
      /(?:ON\s+CONFLICT[\s\S]*DO\s+UPDATE|UPDATE\s+iam\.roles)/i,
    );

    // Grant effects must be derived from registry agent category/risk metadata,
    // and every grant carries one of the typed resourceScope ceilings.
    expect(seedSource).toMatch(/category/);
    expect(seedSource).toMatch(/riskLevel/);
    expect(seedSource).toMatch(/conditions_jsonb/i);
    expect(seedSource).toMatch(/resourceScope/);

    expect(seedSource).toMatch(/graph[\s\S]*mode[\s\S]*read/);
    expect(seedSource).toMatch(/graph[\s\S]*mode[\s\S]*extend/);
    for (const effect of ["deny", "ask", "allow"]) {
      expect(seedSource).toMatch(
        new RegExp(
          `mcp[\\s\\S]*pattern[\\s\\S]*\\*[\\s\\S]*effect[\\s\\S]*${effect}`,
        ),
      );
    }
  });

  it("actively deletes any stray 'Agent Legacy*' role and its role_grants rather than coexisting with it", () => {
    // §6 open question 1: pre-launch, reset instead of migrate — no
    // backwards-compatibility role is ever seeded. This asserts the seed
    // script goes further than just "never creates one": it finds and
    // removes any legacy role (e.g. left by an earlier draft or a manual
    // fixture) before seeding the three canonical roles.
    expect(seedSource).toMatch(/Agent Legacy/);
    expect(seedSource).toMatch(/DELETE\s+FROM\s+iam\.role_grants/i);
    expect(seedSource).toMatch(/DELETE\s+FROM\s+iam\.roles/i);
    expect(seedSource).toMatch(/ILIKE\s*['"`]Agent Legacy/i);
  });
});
