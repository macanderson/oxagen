import { describe, expect, it } from "vitest";
import { repositoryInstallationList } from "./repository.installation.list";

const REPO = {
  id: "424242",
  owner: "acme",
  name: "widgets",
  fullName: "acme/widgets",
  defaultBranch: "main",
  private: true,
  htmlUrl: "https://github.com/acme/widgets",
};

describe("list_installation_repositories contract", () => {
  it("is a scoped settings read, Owner/Admin, that takes no input at all", () => {
    expect(repositoryInstallationList.scoped).toBe(true);
    expect(repositoryInstallationList.mutates).toBe(false);
    expect(repositoryInstallationList.noBillingGate).toBe(true);
    expect(repositoryInstallationList.sensitivity).toBe("high");
    expect(repositoryInstallationList.defaultEffect).toBe("deny");
    expect(repositoryInstallationList.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
    expect(repositoryInstallationList.input.parse({})).toEqual({});
    // An installation id a caller could choose would let one tenant enumerate
    // another account's repositories; the input is strict so there is none.
    expect(
      repositoryInstallationList.input.safeParse({ installationId: "424242" })
        .success,
    ).toBe(false);
  });

  it("answers the installation's repositories and whether the walk was bounded short", () => {
    const out = { repositories: [REPO], truncated: false };
    expect(repositoryInstallationList.output.parse(out)).toEqual(out);
    expect(
      repositoryInstallationList.output.parse({
        repositories: [],
        truncated: true,
      }),
    ).toEqual({ repositories: [], truncated: true });
  });

  it("requires every field the picker and the bind both need", () => {
    for (const key of Object.keys(REPO)) {
      const partial: Record<string, unknown> = { ...REPO };
      delete partial[key];
      expect(
        repositoryInstallationList.output.safeParse({
          repositories: [partial],
          truncated: false,
        }).success,
      ).toBe(false);
    }
  });

  it("refuses a repository element carrying anything else, and a non-URL html url", () => {
    expect(
      repositoryInstallationList.output.safeParse({
        repositories: [{ ...REPO, installationId: "424242" }],
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      repositoryInstallationList.output.safeParse({
        repositories: [{ ...REPO, htmlUrl: "acme/widgets" }],
        truncated: false,
      }).success,
    ).toBe(false);
  });

  it("refuses an empty id, owner, name, full name or default branch", () => {
    for (const key of [
      "id",
      "owner",
      "name",
      "fullName",
      "defaultBranch",
    ] as const) {
      expect(
        repositoryInstallationList.output.safeParse({
          repositories: [{ ...REPO, [key]: "" }],
          truncated: false,
        }).success,
      ).toBe(false);
    }
  });
});
