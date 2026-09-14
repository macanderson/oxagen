// The flow screens are async Server Components; these tests call them and walk
// the element tree they return, which exercises every branch (step, session,
// scope, backed or NotBacked read) without an RSC renderer.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translator } from "../auth/test-intl";

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
vi.mock("next/navigation", () => ({
  notFound,
  redirect,
  permanentRedirect: redirect,
  useRouter: () => ({}),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: (ns: string) => Promise.resolve(translator(ns)),
}));

const getAuthUser = vi.fn();
vi.mock("../auth/session", () => ({ getAuthUser }));
// requireViewer/resolveViewer run for real over stubbed tenancy lookups: Marcus
// is an Acme member who belongs to core-platform and not to finops, and
// "platform" is core-platform's historical slug.
const getSession = vi.fn();
vi.mock("@/server/session", () => ({ getSession }));
const ORG_ID = "7a000000-0000-4000-8000-0000000000a1";
const WS_ID = "7a000000-0000-4000-8000-0000000000b1";
const FINOPS_ID = "7a000000-0000-4000-8000-0000000000b2";
const org = {
  id: ORG_ID,
  publicId: "org_a",
  slug: "acme",
  name: "Acme Robotics",
};
const workspaces = [
  {
    id: WS_ID,
    publicId: "wks_c",
    orgId: ORG_ID,
    slug: "core-platform",
    name: "Core platform",
  },
  {
    id: FINOPS_ID,
    publicId: "wks_f",
    orgId: ORG_ID,
    slug: "finops",
    name: "FinOps",
  },
];
vi.mock("@/server/tenancy-lookups", () => ({
  liveTenancyLookups: {
    orgBySlug: (slug: string) => Promise.resolve(slug === "acme" ? org : null),
    orgBySlugHistory: () => Promise.resolve(null),
    workspaceBySlug: (orgId: string, slug: string) =>
      Promise.resolve(
        workspaces.find((w) => w.orgId === orgId && w.slug === slug) ?? null,
      ),
    workspaceBySlugHistory: (orgId: string, slug: string) =>
      Promise.resolve(
        slug === "platform" && orgId === ORG_ID ? workspaces[0] : null,
      ),
    orgRole: (orgId: string, userId: string) =>
      Promise.resolve(
        orgId === ORG_ID && userId === "usr_marcusbell" ? "member" : null,
      ),
    isWorkspaceMember: (workspaceId: string, userId: string) =>
      Promise.resolve(workspaceId === WS_ID && userId === "usr_marcusbell"),
    mfaPolicy: () => Promise.resolve(null),
    twoFactorEnabled: () => Promise.resolve(false),
  },
}));

// requireViewer defers its clock read behind connection(), which needs a request scope.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: () => Promise.resolve(),
}));
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers()),
}));
const liveTx = {
  query: {
    organizations: {
      findFirst: () =>
        Promise.resolve({
          id: "o1",
          slug: "acme",
          name: "Acme Robotics",
          namespace: "acme",
        }),
    },
    workspaces: {
      findFirst: () =>
        Promise.resolve({
          slug: "core-platform",
          name: "core-platform",
          namespace: "core",
        }),
    },
  },
};
// Only the onboarding port is under test: the real live source loads every live
// adapter, whose @oxagen/database imports this file's partial mock does not carry.
vi.mock("@/data/adapters/live", async () => ({
  liveSource: {
    onboarding: (await import("@/data/adapters/live/onboarding"))
      .liveOnboarding,
  },
}));
vi.mock("@oxagen/database", () => ({
  withSystemDb: (fn: (tx: unknown) => unknown) => fn(liveTx),
}));

const { RegisterScreen, WelcomeScreen } = await import("./screens");
const { GateShell } = await import("./ui/gate-shell");
const { OrganizationForm } = await import("./ui/organization-form");
const { NameAgentForm } = await import("./ui/name-agent-form");
const { FirstFramePanel } = await import("./ui/first-frame-panel");
const { PageState } = await import("@/ui/page-state");

const user = {
  id: "usr_marcusbell",
  email: "marcus.bell@acme.example",
  name: "Marcus Bell",
};

type AnyElement = ReactElement<Record<string, unknown>>;

/** Every element in a returned tree, descending through children and element-valued props. */
function elements(node: ReactNode): AnyElement[] {
  const out: AnyElement[] = [];
  const visit = (n: unknown) => {
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as AnyElement;
    out.push(el);
    for (const value of Object.values(el.props)) visit(value);
  };
  visit(node);
  return out;
}

function find(node: ReactNode, type: unknown): AnyElement | undefined {
  return elements(node).find((e) => e.type === type);
}

function welcome(
  step: string[] | undefined,
  query: Record<string, string> = {},
) {
  return WelcomeScreen({
    params: Promise.resolve(step ? { step } : {}),
    searchParams: Promise.resolve(query),
  });
}
function register(
  step: string[] | undefined,
  query: Record<string, string> = {},
  org = "acme",
  ws = "core-platform",
) {
  return RegisterScreen({
    params: Promise.resolve({ org, ws, ...(step ? { step } : {}) }),
    searchParams: Promise.resolve(query),
  });
}

beforeEach(() => {
  getAuthUser.mockReset();
  getAuthUser.mockResolvedValue(user);
  getSession.mockReset();
  getSession.mockResolvedValue({ user: { ...user, image: null } });
});

describe("WelcomeScreen", () => {
  it("renders step 1 at the bare route inside the gate shell", async () => {
    const tree = await welcome(undefined);
    const shell = find(tree, GateShell);
    expect(shell?.props).toMatchObject({
      mode: "gate",
      step: "organization",
      email: user.email,
    });
    expect(find(tree, OrganizationForm)).toBeDefined();
  });

  it("is not found for an unknown step", async () => {
    await expect(welcome(["billing"])).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("sends a signed-out visit to log in", async () => {
    getAuthUser.mockResolvedValue(null);
    await expect(welcome(undefined)).rejects.toThrow(
      "NEXT_REDIRECT /login?next=%2Fwelcome",
    );
  });

  it("asks for step 1 when a later step has no org in the URL, and for an org the user cannot see", async () => {
    const missing = elements(await welcome(["wrap"]));
    expect(missing.some((e) => e.props.kind === "missing")).toBe(true);
    const unknown = elements(
      await welcome(["wrap"], { org: "globex", ws: "labs" }),
    );
    expect(unknown.some((e) => e.props.kind === "not-found")).toBe(true);
    const notMember = elements(
      await welcome(["run"], { org: "acme", ws: "finops" }),
    );
    expect(notMember.some((e) => e.props.kind === "not-found")).toBe(true);
  });

  it("wrap and run read the scope; run carries the agent choice", async () => {
    const wrapTree = await welcome(["wrap"], {
      org: "acme",
      ws: "core-platform",
    });
    const wrapStep = elements(wrapTree).find(
      (e) => e.props.runPath === "/welcome/run",
    );
    expect(wrapStep?.props).toMatchObject({
      mode: "gate",
      runQuery: { org: "acme", ws: "core-platform" },
    });

    const runTree = await welcome(["run"], {
      org: "acme",
      ws: "core-platform",
      harness: "codex-cli",
    });
    const runStep = elements(runTree).find(
      (e) => e.props.choice !== undefined && e.props.mode === "gate",
    );
    expect(runStep?.props.choice).toEqual({
      agent: "codex-cli",
      harness: "codex-cli",
      tier: "complex",
    });
  });
});

describe("RegisterScreen", () => {
  it("renders the name step with the workspace's namespaces and a cancel back to Fleet", async () => {
    const tree = await register(undefined);
    expect(find(tree, GateShell)?.props).toMatchObject({
      mode: "register",
      step: "name",
      cancelHref: "/acme/core-platform",
    });
    expect(find(tree, NameAgentForm)?.props).toMatchObject({
      org: { slug: "acme", namespace: "acme" },
    });
  });

  it("is not found for an unknown step or a workspace the user cannot see", async () => {
    await expect(register(["organization"])).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(register(undefined, {}, "globex", "labs")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    // A member of the organization who is not a member of the workspace.
    await expect(register(undefined, {}, "acme", "finops")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("a historical workspace slug redirects to the canonical register URL", async () => {
    await expect(register(undefined, {}, "acme", "platform")).rejects.toThrow(
      "NEXT_REDIRECT /acme/core-platform",
    );
  });

  it("sends a signed-out visit to log in, back to the name step", async () => {
    getAuthUser.mockResolvedValue(null);
    await expect(register(["wrap"])).rejects.toThrow(
      "NEXT_REDIRECT /login?next=%2Facme%2Fcore-platform%2Fregister",
    );
  });

  it("asks for step 1 when a later step has no agent choice", async () => {
    const tree = await register(["wrap"]);
    expect(
      elements(tree).some((e) => e.props.testId === "register-choice-missing"),
    ).toBe(true);
    expect(find(tree, GateShell)?.props.hiddenTitle).toBe(true);
  });

  it("wrap and run carry the choice", async () => {
    const choice = {
      agent: "perf-watch",
      harness: "claude-code",
      tier: "light",
    };
    const wrapStep = elements(await register(["wrap"], choice)).find(
      (e) => e.props.runPath === "/acme/core-platform/register/run",
    );
    expect(wrapStep?.props.runQuery).toEqual({
      agent: "perf-watch",
      tier: "light",
    });
    const runStep = elements(await register(["run"], choice)).find(
      (e) => e.props.mode === "register" && e.props.choice,
    );
    expect(runStep?.props.choice).toEqual(choice);
  });
});

describe("the run and wrap steps", () => {
  // The step components are not exported; render them through the screens and call them directly.
  async function runStepElement(
    query: Record<string, string>,
    mode: "gate" | "register" = "gate",
  ) {
    const tree =
      mode === "gate"
        ? await welcome(["run"], query)
        : await register(["run"], query);
    const step = elements(tree).find(
      (e) => e.props.choice !== undefined && e.props.scope !== undefined,
    );
    if (!step || typeof step.type !== "function")
      throw new Error("run step not found");
    return (step.type as (p: unknown) => Promise<ReactNode>)(step.props);
  }

  it("the first frame and the repository are NotBacked (G15), with a way on to Fleet", async () => {
    const tree = await runStepElement({ org: "acme", ws: "core-platform" });
    expect(find(tree, FirstFramePanel)).toBeUndefined();
    expect(find(tree, PageState)?.props.result).toEqual({
      ok: false,
      reason: "not_backed",
      milestone: "M1",
      gap: "G15",
    });
    expect(
      elements(tree).some((e) => e.props["data-testid"] === "repo-not-backed"),
    ).toBe(true);
  });

  it("the wrap step renders the installer's NotBacked notice", async () => {
    const tree = await welcome(["wrap"], { org: "acme", ws: "core-platform" });
    const step = elements(tree).find((e) => e.props.runPath === "/welcome/run");
    if (!step || typeof step.type !== "function")
      throw new Error("wrap step not found");
    const rendered = await (step.type as (p: unknown) => Promise<ReactNode>)(
      step.props,
    );
    const panel = elements(rendered).find(
      (e) => e.props.agentKey === "acme.core.claude-code",
    );
    expect(panel?.props.installer).toBeNull();
    expect(
      find(panel?.props.installerNotice as ReactNode, PageState),
    ).toBeDefined();
  });
});
