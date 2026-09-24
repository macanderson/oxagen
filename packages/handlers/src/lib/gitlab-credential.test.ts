import { describe, expect, it } from "vitest";
import {
  decryptGitLabCredential,
  gitlabNotConnected,
  parseGitLabCredential,
} from "./gitlab-credential";

describe("parseGitLabCredential", () => {
  it("answers both secrets from a well-formed payload", () => {
    expect(
      parseGitLabCredential('{"token":"glpat-x","webhookSecret":"whsec"}'),
    ).toEqual({ token: "glpat-x", webhookSecret: "whsec" });
  });

  it("treats a malformed or partial payload as no credential", () => {
    for (const bad of [
      "not json",
      "null",
      "{}",
      '{"token":"glpat-x"}',
      '{"token":"","webhookSecret":"whsec"}',
      '{"token":"glpat-x","webhookSecret":""}',
      '{"token":1,"webhookSecret":"whsec"}',
    ])
      expect(parseGitLabCredential(bad)).toBeNull();
  });
});

describe("decryptGitLabCredential", () => {
  it("answers null for an envelope without a key id or ciphertext", async () => {
    await expect(decryptGitLabCredential(null)).resolves.toBeNull();
    await expect(decryptGitLabCredential({ keyId: "k" })).resolves.toBeNull();
    await expect(
      decryptGitLabCredential({ ciphertext: "abc" }),
    ).resolves.toBeNull();
  });
});

describe("gitlabNotConnected", () => {
  it("is a conflict that names the repair and no secret", () => {
    const err = gitlabNotConnected();
    expect(err).toMatchObject({
      code: "conflict",
      reason: "gitlab_not_connected",
    });
    expect(err.message).toContain("project access token");
  });
});
