import { describe, expect, it } from "vitest";
import {
  enrollCommandFor,
  hashEnrollmentToken,
  parseRepositoryRemote,
} from "./onboarding";

describe("parseRepositoryRemote", () => {
  it("reads the repository from every remote form GitHub issues", () => {
    for (const remote of [
      "git@github.com:acme/widgets.git",
      "git@github.com:acme/widgets",
      "ssh://git@github.com/acme/widgets.git",
      "https://github.com/acme/widgets",
      "https://github.com/acme/widgets.git",
      "https://github.com/acme/widgets/",
      "https://user@github.com/acme/widgets.git",
      "  https://github.com/acme/widgets.git\n",
    ]) {
      expect(parseRepositoryRemote(remote), remote).toEqual({
        provider: "github",
        owner: "acme",
        name: "widgets",
      });
    }
    expect(
      parseRepositoryRemote("git@github.com:my-org/my.repo_v2.git"),
    ).toEqual({ provider: "github", owner: "my-org", name: "my.repo_v2" });
  });

  it("records nothing for a remote that does not name one GitHub repository", () => {
    for (const remote of [
      "",
      "git@gitlab.com:acme/widgets.git",
      "https://github.com/acme",
      "https://github.com/acme/widgets/extra",
      "https://evil.example/github.com/acme/widgets",
      "https://github.com.evil.example/acme/widgets",
      "git@github.com:-acme/widgets.git",
      "https://github.com/acme/wid gets",
    ]) {
      expect(parseRepositoryRemote(remote), remote).toBeNull();
    }
  });
});

describe("hashEnrollmentToken", () => {
  it("is the token's SHA-256 in the store's sha256:<hex> form, and never the token", () => {
    const token = "oxe_1time_0123456789abcdefghjkmnpqrs";
    const hash = hashEnrollmentToken(token);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashEnrollmentToken(token)).toBe(hash);
    expect(hashEnrollmentToken(`${token}x`)).not.toBe(hash);
  });
});

describe("enrollCommandFor", () => {
  const token = "oxe_1time_0123456789abcdefghjkmnpqrs";

  it("names a hook-based harness so tacho hooks that one, not Claude Code", () => {
    for (const harness of ["claude-code", "codex", "cursor", "stella"]) {
      expect(enrollCommandFor(token, harness)).toBe(
        `oxagen agent enroll --token ${token} --harness ${harness}`,
      );
    }
  });

  it("prints the bare command for a harness with no host hooks", () => {
    for (const harness of ["claude-agent-sdk", "custom"]) {
      expect(enrollCommandFor(token, harness)).toBe(
        `oxagen agent enroll --token ${token}`,
      );
    }
  });
});
