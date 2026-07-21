import { describe, expect, it } from "vitest";
import { agentRoleEffect } from "./lib/seed-iam-defaults";

describe("Agent Operator security capability grants", () => {
  it("keeps high-risk security-sensitive capabilities behind approval", () => {
    // The capability registry has no "security" category — the closest
    // security-sensitive category is "secret" (secret.key.*, secret.value.*,
    // secret.export, secret.import_env), which is what
    // OPERATOR_RESTRICTED_CATEGORIES actually restricts (see
    // tools/scripts/lib/seed-iam-defaults.ts).
    expect(agentRoleEffect("Agent Operator", "secret", "high", false)).toBe(
      "require_approval",
    );
  });
});
