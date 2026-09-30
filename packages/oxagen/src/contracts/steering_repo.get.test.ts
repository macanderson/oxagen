import { describe, expect, it } from "vitest";
import { REPO_HEALTH_STATES } from "../steering-repo/health";
import { STEERING_REPO_STEP_NAMES, steeringRepoGet } from "./steering_repo.get";

const VIEW = {
  status: "ready",
  step: "bind_repository",
  failedStep: null,
  error: null,
  provider: "github",
  repository: {
    fullName: "acme/oxagen-platform",
    url: "https://github.com/acme/oxagen-platform",
  },
  publishedVersion: 3,
  health: "drifted",
  differences: [
    {
      setting: "rulesets.oxagen_merges",
      expected: '{"enforcement":"active"}',
      actual: "unset",
      changedBy: "octocat",
      changedAt: "2026-09-27T09:00:00.000Z",
    },
  ],
  legacySource: null,
  connectionChoices: [],
} as const;

describe("get_steering_repo contract", () => {
  it("is a workspace read on api and mcp, outside metering", () => {
    expect(steeringRepoGet.name).toBe("get_steering_repo");
    expect(steeringRepoGet.scoped).toBe(true);
    expect(steeringRepoGet.mutates).toBe(false);
    expect(steeringRepoGet.noBillingGate).toBe(true);
    expect(steeringRepoGet.sensitivity).toBe("low");
    expect(steeringRepoGet.surfaces).toEqual(["api", "mcp", "agent"]);
  });

  it("lets every workspace role read it", () => {
    expect(steeringRepoGet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow", Compliance: "allow" },
      workspace: {
        Owner: "allow",
        Admin: "allow",
        Member: "allow",
        Viewer: "allow",
        Compliance: "allow",
      },
    });
  });

  it("takes nothing", () => {
    expect(steeringRepoGet.input.parse({})).toEqual({});
    expect(steeringRepoGet.input.safeParse({ workspaceId: "ws_1" }).success).toBe(false);
  });

  it("answers a ready repo with its differences", () => {
    expect(steeringRepoGet.output.parse(VIEW)).toEqual(VIEW);
  });

  it("answers a workspace with no steering repo yet", () => {
    const none = {
      status: "not_started",
      step: null,
      failedStep: null,
      error: null,
      provider: null,
      repository: null,
      publishedVersion: null,
      health: null,
      differences: [],
      legacySource: {
        fullName: "acme/platform",
        url: "https://github.com/acme/platform",
      },
      connectionChoices: [],
    };
    expect(steeringRepoGet.output.parse(none)).toEqual(none);
  });

  it("lists the connections a blocked setup chooses between", () => {
    const blocked = {
      ...VIEW,
      status: "blocked",
      step: null,
      failedStep: "pick_connection",
      error: { code: "choose_connection", message: "Choose one." },
      repository: null,
      publishedVersion: null,
      health: null,
      differences: [],
      connectionChoices: [
        { provider: "github", id: 11, name: "acme" },
        { provider: "gitlab", id: 22, name: "acme/platform" },
      ],
    };
    expect(steeringRepoGet.output.parse(blocked)).toEqual(blocked);
    expect(
      steeringRepoGet.output.safeParse({
        ...blocked,
        connectionChoices: [{ provider: "github", id: 0, name: "acme" }],
      }).success,
    ).toBe(false);
  });

  it("accepts every provisioning step and every health state", () => {
    for (const step of STEERING_REPO_STEP_NAMES)
      expect(steeringRepoGet.output.safeParse({ ...VIEW, step }).success).toBe(true);
    for (const health of REPO_HEALTH_STATES)
      expect(steeringRepoGet.output.safeParse({ ...VIEW, health }).success).toBe(true);
  });

  it("refuses an unknown step, a version below 1, and a repository without a link", () => {
    expect(steeringRepoGet.output.safeParse({ ...VIEW, step: "clone" }).success).toBe(false);
    expect(steeringRepoGet.output.safeParse({ ...VIEW, publishedVersion: 0 }).success).toBe(
      false,
    );
    expect(
      steeringRepoGet.output.safeParse({
        ...VIEW,
        repository: { fullName: "acme/oxagen-platform", url: "acme/oxagen-platform" },
      }).success,
    ).toBe(false);
  });
});
