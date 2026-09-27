import { describe, expect, it } from "vitest";
import { workspaceCreate } from "./workspace.create";

const OUTPUT = {
  publicId: "wrk_abc",
  name: "Default",
  slug: "default",
  orgSlug: "acme",
  createdAt: new Date().toISOString(),
  steering_repo: { status: "provisioning" },
};

describe("workspace.create capability", () => {
  it("is a settings write, never a governed action (INV-28), with no e2e layer", () => {
    expect(workspaceCreate.noBillingGate).toBe(true);
    expect(workspaceCreate.mutates).toBe(true);
    expect(workspaceCreate.layers).not.toContain("e2e");
  });

  it("parses a valid input that still sends the deprecated mainRepo, defaulting its provider", () => {
    const parsed = workspaceCreate.input.parse({
      name: "Default",
      slug: "default",
      mainRepo: { owner: "acme", name: "widgets" },
    });
    expect(parsed.slug).toBe("default");
    expect(parsed.mainRepo).toEqual({
      provider: "github",
      owner: "acme",
      name: "widgets",
    });
  });

  // Lane S1 (#4450): a workspace no longer takes a main repository. A draft
  // with a name and a slug is complete.
  it("accepts a draft with no mainRepo", () => {
    const parsed = workspaceCreate.input.parse({
      name: "Default",
      slug: "default",
    });
    expect(parsed).toEqual({ name: "Default", slug: "default" });
    expect(parsed.mainRepo).toBeUndefined();
  });

  it("refuses a mainRepo that names an installation, or an unknown provider", () => {
    // The field is ignored, and it still validates: an older caller that sends
    // a malformed repository gets the refusal it always got. The object is
    // strict, so an installation id is refused.
    expect(
      workspaceCreate.input.safeParse({
        name: "Default",
        slug: "default",
        mainRepo: { owner: "acme", name: "widgets", installationId: "555" },
      }).success,
    ).toBe(false);
    expect(
      workspaceCreate.input.safeParse({
        name: "Default",
        slug: "default",
        mainRepo: { provider: "gitlab", owner: "acme", name: "widgets" },
      }).success,
    ).toBe(false);
  });

  it("takes a gitlab.com project with its project access token, and nothing looser (#3762)", () => {
    const token = "glpat-abcdefghijklmnopqrstuvwxyz";
    expect(
      workspaceCreate.input.parse({
        name: "Rules",
        slug: "rules",
        mainRepo: {
          provider: "gitlab",
          projectPath: "acme/platform/rules",
          token,
        },
      }).mainRepo,
    ).toEqual({
      provider: "gitlab",
      projectPath: "acme/platform/rules",
      token,
    });
    for (const mainRepo of [
      { provider: "gitlab", projectPath: "acme/platform/rules" },
      { provider: "gitlab", projectPath: "rules", token },
      {
        provider: "gitlab",
        projectPath: "acme/rules",
        token,
        host: "gitlab.example.com",
      },
    ])
      expect(
        workspaceCreate.input.safeParse({ name: "R", slug: "rules", mainRepo })
          .success,
      ).toBe(false);
  });

  it("refuses a repository owner or name bind_main_repository would refuse", () => {
    expect(
      workspaceCreate.input.safeParse({
        name: "Default",
        slug: "default",
        mainRepo: { owner: "acme/evil", name: "widgets" },
      }).success,
    ).toBe(false);
    expect(
      workspaceCreate.input.safeParse({
        name: "Default",
        slug: "default",
        mainRepo: { owner: "acme", name: "" },
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid slug", () => {
    expect(() =>
      workspaceCreate.input.parse({
        name: "Default",
        slug: "Has Space",
        mainRepo: { owner: "acme", name: "widgets" },
      }),
    ).toThrow();
  });

  it("rejects a too-short slug", () => {
    expect(() =>
      workspaceCreate.input.parse({
        name: "Default",
        slug: "a",
        mainRepo: { owner: "acme", name: "widgets" },
      }),
    ).toThrow();
  });

  it("parses a valid output, which carries the steering repo status", () => {
    const parsed = workspaceCreate.output.parse(OUTPUT);
    expect(parsed.orgSlug).toBe("acme");
    expect(parsed.steering_repo).toEqual({ status: "provisioning" });
  });

  it("parses every steering repo status the handler can return", () => {
    for (const status of ["provisioning", "ready", "failed", "blocked"])
      expect(
        workspaceCreate.output.parse({ ...OUTPUT, steering_repo: { status } })
          .steering_repo.status,
      ).toBe(status);
  });

  it("refuses an output with no steering repo status, or an unknown one", () => {
    const { steering_repo: _dropped, ...without } = OUTPUT;
    expect(workspaceCreate.output.safeParse(without).success).toBe(false);
    expect(
      workspaceCreate.output.safeParse({
        ...OUTPUT,
        steering_repo: { status: "bound" },
      }).success,
    ).toBe(false);
  });

  it("no longer answers a main repository", () => {
    const parsed = workspaceCreate.output.parse({
      ...OUTPUT,
      mainRepo: { bindingId: "rpb_0123abcd", fullName: "acme/widgets" },
    });
    expect(parsed).not.toHaveProperty("mainRepo");
  });
});
