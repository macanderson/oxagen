import { describe, expect, it } from "vitest";
import { workspaceCreate } from "./workspace.create";

const OUTPUT = {
  publicId: "wrk_abc",
  name: "Default",
  slug: "default",
  orgSlug: "acme",
  createdAt: new Date().toISOString(),
  mainRepo: {
    bindingId: "rpb_0123abcd",
    connectionId: "con_abc",
    provider: "github",
    fullName: "acme/widgets",
    defaultRef: "main",
  },
};

describe("workspace.create capability", () => {
  it("is a settings write, never a governed action (INV-28), with no e2e layer", () => {
    expect(workspaceCreate.noBillingGate).toBe(true);
    expect(workspaceCreate.mutates).toBe(true);
    expect(workspaceCreate.layers).not.toContain("e2e");
  });

  it("parses a valid input, defaulting the repository provider", () => {
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

  // §17 M0: "a workspace cannot be created without a main repo". The contract
  // is where that holds — a draft without one never reaches the handler.
  it("refuses a draft with no mainRepo", () => {
    expect(
      workspaceCreate.input.safeParse({ name: "Default", slug: "default" })
        .success,
    ).toBe(false);
  });

  it("refuses a mainRepo that names an installation, or an unknown provider", () => {
    // An installation id a caller could choose would let one tenant mint
    // tokens for another account's installation; the object is strict.
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

  it("parses a valid output, which carries the main repository it bound", () => {
    const parsed = workspaceCreate.output.parse(OUTPUT);
    expect(parsed.orgSlug).toBe("acme");
    expect(parsed.mainRepo.bindingId).toBe("rpb_0123abcd");
  });

  it("refuses an output with no main repository: the handler never answers one", () => {
    const { mainRepo: _dropped, ...without } = OUTPUT;
    expect(workspaceCreate.output.safeParse(without).success).toBe(false);
  });
});
