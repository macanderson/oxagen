import { describe, expect, it } from "vitest";
import { steeringRepoDestinationsList } from "./steering_repo.destinations.list";
import { workspaceCreate } from "./workspace.create";

const acme = { provider: "github", id: 11, name: "acme", kind: "organization" } as const;

describe("list_steering_repo_destinations contract", () => {
  it("is a read outside metering on api, mcp, and agent", () => {
    expect(steeringRepoDestinationsList.name).toBe("list_steering_repo_destinations");
    expect(steeringRepoDestinationsList.scoped).toBe(true);
    expect(steeringRepoDestinationsList.mutates).toBe(false);
    expect(steeringRepoDestinationsList.noBillingGate).toBe(true);
    expect(steeringRepoDestinationsList.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(steeringRepoDestinationsList.agent?.requiresApproval).toBe(false);
  });

  it("admits the people create_workspace admits", () => {
    expect(steeringRepoDestinationsList.defaultRoles).toEqual(
      workspaceCreate.defaultRoles,
    );
  });

  it("takes nothing, or a workspace slug, and nothing looser", () => {
    expect(steeringRepoDestinationsList.input.parse({})).toEqual({});
    expect(steeringRepoDestinationsList.input.parse({ slug: "support" })).toEqual({
      slug: "support",
    });
    expect(
      steeringRepoDestinationsList.input.safeParse({ slug: "Not A Slug" }).success,
    ).toBe(false);
    expect(
      steeringRepoDestinationsList.input.safeParse({ slug: "billing" }).success,
    ).toBe(false);
    expect(
      steeringRepoDestinationsList.input.safeParse({ org: "acme" }).success,
    ).toBe(false);
  });

  it("answers the places, the default, the default name, and the hosts to authorize again", () => {
    const out = {
      destinations: [
        acme,
        { provider: "github", id: 12, name: "mac", kind: "user" },
        { provider: "gitlab", id: 7, name: "acme/platform", kind: "organization" },
      ],
      default: acme,
      defaultName: "oxagen-support",
      reauthorize: [],
    };
    expect(steeringRepoDestinationsList.output.parse(out)).toEqual(out);
    expect(
      steeringRepoDestinationsList.output.parse({
        destinations: [],
        default: null,
        defaultName: null,
        reauthorize: ["github"],
      }).reauthorize,
    ).toEqual(["github"]);
    expect(
      steeringRepoDestinationsList.output.safeParse({ ...out, reauthorize: ["bitbucket"] })
        .success,
    ).toBe(false);
  });
});

describe("create_workspace steeringRepo", () => {
  const base = { name: "Support", slug: "support" };

  it("is optional, and so is each of its fields", () => {
    expect(workspaceCreate.input.parse(base).steeringRepo).toBeUndefined();
    expect(
      workspaceCreate.input.parse({ ...base, steeringRepo: {} }).steeringRepo,
    ).toEqual({});
  });

  it("takes a place and a name", () => {
    const steeringRepo = {
      name: "acme-support-steering",
      connection: { provider: "gitlab", id: 7 },
    };
    expect(
      workspaceCreate.input.parse({ ...base, steeringRepo }).steeringRepo,
    ).toEqual(steeringRepo);
  });

  it("refuses a name GitHub or GitLab would refuse", () => {
    for (const name of [
      "",
      "-support",
      "support-",
      "sup--port",
      "sup.-port",
      "has space",
      "support.git",
      "support.atom",
      "a".repeat(101),
      "näme",
    ])
      expect(
        workspaceCreate.input.safeParse({ ...base, steeringRepo: { name } }).success,
        name,
      ).toBe(false);
  });

  it("accepts names both hosts accept, up to 100 characters", () => {
    for (const name of [
      "oxagen-support",
      "Support_Steering",
      "steering.v2",
      "a",
      "a".repeat(100),
    ])
      expect(
        workspaceCreate.input.safeParse({ ...base, steeringRepo: { name } }).success,
        name,
      ).toBe(true);
  });

  it("refuses the organization's own oxagen-config in any letter case", () => {
    for (const name of ["oxagen-config", "Oxagen-Config"])
      expect(
        workspaceCreate.input.safeParse({ ...base, steeringRepo: { name } }).success,
        name,
      ).toBe(false);
    expect(
      workspaceCreate.input.safeParse({
        ...base,
        steeringRepo: { name: "oxagen-config-2" },
      }).success,
    ).toBe(true);
  });

  it("refuses an unknown provider, a stray field, or a non-positive id", () => {
    for (const steeringRepo of [
      { connection: { provider: "bitbucket", id: 7 } },
      { connection: { provider: "github", id: 0 } },
      { connection: { provider: "github", id: 7, name: "acme" } },
      { owner: "acme" },
    ])
      expect(
        workspaceCreate.input.safeParse({ ...base, steeringRepo }).success,
      ).toBe(false);
  });
});
