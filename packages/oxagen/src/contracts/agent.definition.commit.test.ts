import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import {
  AGENT_DEFINITION_DIR,
  AGENT_DEFINITION_SCHEMA,
  agentDefinitionCommit,
  branchNameSchema,
} from "./agent.definition.commit";

const input = {
  agentId: "release-bot",
  branch: "agents/release-bot",
  source: `schema = "${AGENT_DEFINITION_SCHEMA}"\nslug = "release-bot"\n`,
};

describe("commit_agent_definition contract", () => {
  it("is a definition write: mutates, unmetered, Owner/Admin/Member and workspace Owner/Member", () => {
    expect(getCapability("commit_agent_definition")).toBe(
      agentDefinitionCommit,
    );
    expect(agentDefinitionCommit.mutates).toBe(true);
    expect(agentDefinitionCommit.noBillingGate).toBe(true);
    expect(agentDefinitionCommit.surfaces).toEqual(["api"]);
    expect(agentDefinitionCommit.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow", Member: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
    expect(AGENT_DEFINITION_DIR).toBe(".oxagen/agents");
  });

  it("names the branch the file goes to and the file text; the repository is optional", () => {
    expect(agentDefinitionCommit.input.parse(input)).toEqual(input);
    expect(
      agentDefinitionCommit.input.parse({
        ...input,
        repositoryId: "rpb_0123456789abcdefghjkmn",
        message: "Agent definition: release-bot",
      }).repositoryId,
    ).toBe("rpb_0123456789abcdefghjkmn");
    expect(
      agentDefinitionCommit.input.safeParse({
        ...input,
        repositoryId: "repo-1",
      }).success,
    ).toBe(false);
    expect(
      agentDefinitionCommit.input.safeParse({ ...input, source: "" }).success,
    ).toBe(false);
    expect(
      agentDefinitionCommit.input.safeParse({
        ...input,
        source: "x".repeat(64 * 1024 + 1),
      }).success,
    ).toBe(false);
  });

  it("accepts git branch names and refuses the forms git refuses", () => {
    for (const ok of ["main-next", "agents/release-bot", "feat/a.b_c"]) {
      expect(branchNameSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of [
      "",
      "-lead",
      "a..b",
      "a//b",
      "trailing/",
      "x.lock",
      "has space",
      "~tilde",
      "refs/heads/main",
      "heads/main",
      "refs/tags/v1",
    ]) {
      expect(branchNameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("answers with the cached version, the digest, the commit and the pull request", () => {
    const out = agentDefinitionCommit.output.parse({
      agentId: "agt_0123456789abcdefghjkmn",
      version: 3,
      path: ".oxagen/agents/release-bot.toml",
      generatedPath: null,
      digest: "f".repeat(64),
      commitSha: "abc123",
      branch: "agents/release-bot",
      pullRequest: { number: 12, url: "https://github.com/acme/core/pull/12" },
    });
    expect(out.pullRequest.number).toBe(12);
    expect(
      agentDefinitionCommit.output.safeParse({ ...out, version: 0 }).success,
    ).toBe(false);
  });
});
