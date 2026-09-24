import { describe, expect, it } from "vitest";
import { repositoryGitlabAttach } from "./repository.gitlab.attach";

describe("attach_gitlab_project contract", () => {
  it("is a scoped Owner/Admin settings write on the API only", () => {
    expect(repositoryGitlabAttach.scoped).toBe(true);
    expect(repositoryGitlabAttach.mutates).toBe(true);
    expect(repositoryGitlabAttach.noBillingGate).toBe(true);
    expect(repositoryGitlabAttach.sensitivity).toBe("high");
    expect(repositoryGitlabAttach.defaultEffect).toBe("deny");
    expect(repositoryGitlabAttach.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
    // A token is pasted by a signed-in person; no agent or key-held surface.
    expect(repositoryGitlabAttach.surfaces).toEqual(["api"]);
  });

  it("takes a project path with nested groups and a token, and nothing else", () => {
    const token = "glpat-abcdefghijklmnopqrstuvwxyz";
    expect(
      repositoryGitlabAttach.input.parse({
        projectPath: "acme/platform/tools/rules",
        token,
      }),
    ).toEqual({ projectPath: "acme/platform/tools/rules", token });
    for (const bad of [
      { projectPath: "rules", token },
      { projectPath: "/acme/rules", token },
      { projectPath: "acme/rules/", token },
      { projectPath: "acme/-rules", token },
      { projectPath: "acme/rules", token: "short" },
      { projectPath: "acme/rules", token: "glpat has spaces in it here" },
      { projectPath: "acme/rules", token, host: "gitlab.example.com" },
    ]) {
      expect(repositoryGitlabAttach.input.safeParse(bad).success).toBe(false);
    }
  });

  it("never answers the token", () => {
    const shape = repositoryGitlabAttach.output.shape;
    expect(Object.keys(shape)).not.toContain("token");
    expect(
      repositoryGitlabAttach.output.safeParse({
        connectionId: "con_abc123",
        projectId: "4242",
        fullName: "acme/rules",
        defaultRef: "main",
        tokenExpiresAt: null,
        rotated: false,
        webhook: { status: "registered" },
        token: "glpat-x",
      }).success,
    ).toBe(false);
  });
});
