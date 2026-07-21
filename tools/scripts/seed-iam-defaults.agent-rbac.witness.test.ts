import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const seedSource = readFileSync(
  join(import.meta.dirname, "seed-iam-defaults.ts"),
  "utf8",
);

describe("Agent RBAC IAM defaults seed", () => {
  it("seeds exactly the three system workspace role ceilings from capability metadata", () => {
    const agentRoleNames = [
      ...seedSource.matchAll(/["'`](Agent [^"'`]+)["'`]/g),
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
});
