// The two sign-in callbacks: the CLI's authorize parameters and its approve and
// cancel actions (kernelWrite(authorize_cli) + redirectToLoopback), and the
// GitHub App setup landing.
import { authCliAuthorize } from "@oxagen/oxagen/contracts/auth.cli.authorize";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { redirect, requireUser, requireViewer, kernelWrite } = vi.hoisted(
  () => ({
    redirect: vi.fn((to: string) => {
      throw new Error(`NEXT_REDIRECT ${to}`);
    }),
    requireUser: vi.fn(),
    requireViewer: vi.fn(),
    kernelWrite: vi.fn(),
  }),
);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/server/kernel", () => ({ kernelWrite }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireUser,
  requireViewer,
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const cli = await import("./cli-authorize");
const { approveCliAuth, cancelCliAuth } = await import("./cli-actions");
const { handleGithubSetup } = await import("./github-setup");

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const valid = {
  redirect_uri: "http://127.0.0.1:53682/callback",
  state: "st_1",
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
};

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

function viewer(orgRole: "owner" | "member") {
  return unsafeMint(WsCtx, {
    userId: "u1",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme",
    orgRole,
    workspaceId: "7b000000-0000-4000-8000-000000000001",
    wsSlug: "core",
    wsName: "Core",
  });
}

beforeEach(() => {
  redirect.mockClear();
  requireViewer.mockReset();
  kernelWrite.mockReset();
});

describe("CLI authorize parameters", () => {
  it("reads and defaults the label", () => {
    expect(
      cli.readAuthorizeParams({ ...valid, label: ["  my-laptop  ", "x"] })
        .label,
    ).toBe("my-laptop");
    expect(cli.readAuthorizeParams({}).label).toBe("Oxagen CLI");
  });

  it("accepts a loopback S256 request as a checked request", () => {
    expect(
      cli.checkAuthorizeParams(
        cli.readAuthorizeParams({ ...valid, label: "laptop" }),
      ),
    ).toEqual({
      ok: true,
      request: {
        redirectUri: valid.redirect_uri,
        state: "st_1",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
        label: "laptop",
      },
    });
  });

  it("names every invalid parameter, and never accepts a non-loopback redirect (negative)", () => {
    expect(
      cli.checkAuthorizeParams(
        cli.readAuthorizeParams({
          redirect_uri: "https://evil.example/cb",
          code_challenge: "short",
          code_challenge_method: "plain",
        }),
      ),
    ).toEqual({
      ok: false,
      errors: ["redirectUri", "codeChallenge", "codeChallengeMethod", "state"],
    });
  });

  it("refuses a request whose only fault is the challenge (negative)", () => {
    expect(
      cli.checkAuthorizeParams(
        cli.readAuthorizeParams({ ...valid, code_challenge: "short" }),
      ),
    ).toEqual({ ok: false, errors: ["codeChallenge"] });
  });

  it("builds the return path log in sends the person back to", () => {
    const path = cli.authorizeReturnPath(cli.readAuthorizeParams(valid));
    expect(path.startsWith("/cli/authorize?")).toBe(true);
    expect(new URLSearchParams(path.split("?")[1]).get("redirect_uri")).toBe(
      valid.redirect_uri,
    );
  });
});

describe("approveCliAuth", () => {
  const approve = {
    ...valid,
    label: "laptop",
    org_slug: "acme",
    workspace_slug: "core",
  };

  it("refuses a non-loopback redirect before resolving a viewer or minting (negative)", async () => {
    expect(
      await approveCliAuth(
        null,
        form({ ...approve, redirect_uri: "https://evil.example/cb" }),
      ),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "redirectUri",
    });
    expect(requireViewer).not.toHaveBeenCalled();
    expect(kernelWrite).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("answers a member the handler refuses as denied, with no redirect (negative)", async () => {
    const member = viewer("member");
    requireViewer.mockResolvedValue(member);
    kernelWrite.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "forbidden",
    });
    expect(await approveCliAuth(null, form(approve))).toEqual({
      ok: false,
      reason: "denied",
      code: "forbidden",
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core");
    expect(kernelWrite).toHaveBeenCalledWith(member, authCliAuthorize, {
      redirectUri: valid.redirect_uri,
      state: "st_1",
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
      label: "laptop",
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("sends an owner's code and the state to the loopback listener", async () => {
    requireViewer.mockResolvedValue(viewer("owner"));
    kernelWrite.mockResolvedValue({ ok: true, value: { code: "code_123" } });
    await expect(approveCliAuth(null, form(approve))).rejects.toThrow(
      "NEXT_REDIRECT http://127.0.0.1:53682/callback?code=code_123&state=st_1",
    );
  });
});

describe("cancelCliAuth", () => {
  it("returns access_denied and the state to a checked loopback listener", async () => {
    await expect(cancelCliAuth(null, form(valid))).rejects.toThrow(
      "NEXT_REDIRECT http://127.0.0.1:53682/callback?error=access_denied&state=st_1",
    );
    expect(requireUser).toHaveBeenCalledOnce();
  });

  it("sends a signed-out person to sign in before answering the listener (negative)", async () => {
    requireUser.mockRejectedValueOnce(new Error("NEXT_REDIRECT /login"));
    await expect(cancelCliAuth(null, form(valid))).rejects.toThrow(
      "NEXT_REDIRECT /login",
    );
    expect(redirect).not.toHaveBeenCalled();
  });

  it("refuses a non-loopback redirect and a missing state (negative)", async () => {
    expect(
      await cancelCliAuth(
        null,
        form({ ...valid, redirect_uri: "https://evil.example/cb" }),
      ),
    ).toMatchObject({ reason: "invalid", field: "redirectUri" });
    expect(
      await cancelCliAuth(null, form({ ...valid, state: "" })),
    ).toMatchObject({ reason: "invalid", field: "state" });
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("handleGithubSetup", () => {
  const setup =
    "https://app.oxagen.sh/github/setup?installation_id=12345&setup_action=install";

  it("sends a signed-out visitor to log in, with the installation query intact (negative)", async () => {
    const res = await handleGithubSetup(new Request(setup), {
      getAuthUser: () => Promise.resolve(null),
    });
    expect(res.status).toBe(307);
    const target = new URL(res.headers.get("location") ?? "");
    expect(target.origin).toBe("https://app.oxagen.sh");
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBe(
      "/github/setup?installation_id=12345&setup_action=install",
    );
  });

  it("lands a signed-in person on /", async () => {
    const res = await handleGithubSetup(new Request(setup), {
      getAuthUser: () => Promise.resolve({ id: "u1" }),
    });
    expect(res.headers.get("location")).toBe("https://app.oxagen.sh/");
  });
});
