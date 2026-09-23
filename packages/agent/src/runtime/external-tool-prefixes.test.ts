/**
 * The prefixes that mark a tool as externally contributed are one decision
 * written in two packages that cannot import each other: the run ledger's
 * spec schema (`@oxagen/run-ledger`) and the decision-rules matcher
 * (`@oxagen/rules`). `@oxagen/agent` depends on both, so this is where they
 * are held equal, the way `tool-identity-bounds.test.ts` holds the registry
 * and the spec to one length.
 *
 * Why it matters: a prefix the ledger admits and the rules do not lower-case
 * is a tool a rule author cannot match, so a deny written against it never
 * fires; a prefix the rules know and the ledger refuses is a tool no run spec
 * can carry.
 */
import { describe, expect, it } from "vitest";
import {
  EXTERNAL_TOOL_PREFIXES as LEDGER_PREFIXES,
  isExternalToolIdentity,
} from "@oxagen/run-ledger";
import {
  EXTERNAL_TOOL_PREFIXES as RULES_PREFIXES,
  canonicalToolIdentity,
} from "@oxagen/rules";

describe("external tool prefixes", () => {
  it("are the same list in the ledger and in the rules", () => {
    expect([...RULES_PREFIXES]).toEqual([...LEDGER_PREFIXES]);
  });

  it("mark the same names external in both packages", () => {
    for (const prefix of LEDGER_PREFIXES) {
      const name = `${prefix}.Server_1.List_PRs`;
      expect(isExternalToolIdentity(name)).toBe(true);
      // The rules lower-case an external identity and leave a platform
      // capability alone, so a changed case is the external test.
      expect(canonicalToolIdentity(name)).toBe(name.toLowerCase());
    }
    expect(isExternalToolIdentity("send_message")).toBe(false);
    expect(canonicalToolIdentity("send_message")).toBe("send_message");
  });
});
