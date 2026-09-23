import { describe, expect, it } from "vitest";
import { tachoGithubTokenIssue } from "./tacho.github_token.issue";
const input = {
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
  owner: "Acme",
  name: "repo",
  run_token_id: "rt_0123456789abcdef0123",
};
describe("create_github_token contract", () => {
  it("is a scoped, default-deny machine API capability", () => {
    expect(tachoGithubTokenIssue).toMatchObject({
      surfaces: ["api"],
      scoped: true,
      noBillingGate: true,
      sensitivity: "high",
      defaultEffect: "deny",
    });
    expect(tachoGithubTokenIssue.input.parse(input)).toEqual(input);
  });
  it.each([".", "..", "../repo", "repo/other", "a".repeat(101)])(
    "refuses repository path %s",
    (name) => {
      expect(
        tachoGithubTokenIssue.input.safeParse({ ...input, name }).success,
      ).toBe(false);
    },
  );
  it("does not accept a caller-selected installation or permission grant", () => {
    expect(
      tachoGithubTokenIssue.input.safeParse({ ...input, installation_id: "1" })
        .success,
    ).toBe(false);
    expect(
      tachoGithubTokenIssue.input.safeParse({
        ...input,
        permissions: { admin: "write" },
      }).success,
    ).toBe(false);
    expect(
      tachoGithubTokenIssue.input.safeParse({
        ...input,
        run_token_id: "arbitrary",
      }).success,
    ).toBe(false);
  });
});
