import { describe, expect, it } from "vitest";
import { repositoryMainGet } from "./repository.main.get";

describe("get_main_repository contract", () => {
  it("is a scoped settings read, Owner/Admin, that takes no input at all", () => {
    expect(repositoryMainGet.scoped).toBe(true);
    expect(repositoryMainGet.mutates).toBe(false);
    expect(repositoryMainGet.noBillingGate).toBe(true);
    expect(repositoryMainGet.sensitivity).toBe("high");
    expect(repositoryMainGet.defaultEffect).toBe("deny");
    expect(repositoryMainGet.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
    expect(repositoryMainGet.input.parse({})).toEqual({});
    // A caller naming an installation could mint tokens for another account's;
    // the input is strict so there is nowhere to name one.
    expect(
      repositoryMainGet.input.safeParse({ installationId: "424242" }).success,
    ).toBe(false);
  });

  it("answers the bound repository, the install state and both signed doors", () => {
    const out = {
      repository: {
        bindingId: "rpb_0123456789abcdef",
        provider: "github",
        owner: "acme",
        name: "widgets",
        fullName: "acme/widgets",
        defaultRef: "main",
        htmlUrl: "https://github.com/acme/widgets",
        boundAt: "2026-09-15T12:06:00.000Z",
        connectionLive: true,
      },
      github: {
        connected: true,
        // Three doors, three different URLs. Connect is the identity leg, which
        // always round-trips a code and our state. Install is
        // `installations/new` WITH that state; manage is the same page without
        // it, and is never the way to establish a connection.
        connectUrl:
          "https://github.com/login/oauth/authorize?client_id=Iv1.x&state=abc.def",
        installUrl:
          "https://github.com/apps/oxagen/installations/new?state=abc.def",
        manageUrl: "https://github.com/apps/oxagen/installations/new",
      },
    };
    expect(repositoryMainGet.output.parse(out)).toEqual(out);
    expect(
      repositoryMainGet.output.safeParse({
        ...out,
        repository: { ...out.repository, bindingId: "rpb_XYZ" },
      }).success,
    ).toBe(false);
  });

  it("allows a provisional workspace: no repository, not connected", () => {
    const out = {
      repository: null,
      github: {
        connected: false,
        connectUrl:
          "https://github.com/login/oauth/authorize?client_id=Iv1.x&state=abc.def",
        installUrl:
          "https://github.com/apps/oxagen/installations/new?state=abc.def",
        manageUrl: "https://github.com/apps/oxagen/installations/new",
      },
    };
    expect(repositoryMainGet.output.parse(out)).toEqual(out);
  });

  it("allows null URLs, so a deployment with no GitHub App still renders", () => {
    const out = {
      repository: null,
      github: {
        connected: false,
        connectUrl: null,
        installUrl: null,
        manageUrl: null,
      },
    };
    expect(repositoryMainGet.output.parse(out)).toEqual(out);
  });

  it("refuses an installation id smuggled into the output", () => {
    expect(
      repositoryMainGet.output.safeParse({
        repository: null,
        github: {
          connected: true,
          connectUrl: null,
          installUrl: null,
          manageUrl: null,
          installationId: "424242",
        },
      }).success,
    ).toBe(false);
  });

  it("refuses a URL that is not a URL and a boundAt that is not RFC 3339", () => {
    expect(
      repositoryMainGet.output.safeParse({
        repository: null,
        github: {
          connected: true,
          connectUrl: "not-a-url",
          installUrl: null,
          manageUrl: null,
        },
      }).success,
    ).toBe(false);
    expect(
      repositoryMainGet.output.safeParse({
        repository: {
          bindingId: "rpb_0123456789abcdef",
          owner: "acme",
          name: "widgets",
          fullName: "acme/widgets",
          defaultRef: "main",
          htmlUrl: "https://github.com/acme/widgets",
          boundAt: "2026-09-15 12:06:00",
          connectionLive: true,
        },
        github: {
          connected: true,
          connectUrl: null,
          installUrl: null,
          manageUrl: null,
        },
      }).success,
    ).toBe(false);
  });
});
