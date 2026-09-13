// The flow screens are async Server Components; these tests call them and walk
// the element tree they return, which exercises every branch (step, session,
// state switch, scope, backed or NotBacked read) without an RSC renderer.
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
  useRouter: () => ({}),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: (ns: string) => Promise.resolve(translator(ns)),
}));

const getAuthUser = vi.fn();
vi.mock("../auth/session", () => ({ getAuthUser }));

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (n: string) =>
        cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined,
    }),
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
    orgUsers: { findFirst: () => Promise.resolve({ orgId: "o1" }) },
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
vi.mock("@oxagen/database", () => ({
  withSystemDb: (fn: (tx: unknown) => unknown) => fn(liveTx),
}));

const { RegisterScreen, WelcomeScreen } = await import("./screens");
const { GateShell, GateSkeleton } = await import("./ui/gate-shell");
const { OrganizationForm } = await import("./ui/organization-form");
const { NameAgentForm } = await import("./ui/name-agent-form");
const { FirstFramePanel } = await import("./ui/first-frame-panel");
const { RepoPanel } = await import("./ui/repo-panel");
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

function fixtureMode() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("MC_DATA", "fixture");
}

beforeEach(() => {
  cookieJar.clear();
  getAuthUser.mockReset();
  getAuthUser.mockResolvedValue(user);
  fixtureMode();
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

  it("honours the loading and denied switches", async () => {
    cookieJar.set("mc_state", "loading");
    expect((await welcome(undefined)).type).toBe(GateSkeleton);
    cookieJar.set("mc_state", "denied");
    const deniedTree = await welcome(undefined);
    expect(find(deniedTree, GateShell)?.props.hiddenTitle).toBe(true);
    const denied = find(deniedTree, PageState);
    expect(denied?.props.result).toEqual({
      ok: false,
      reason: "denied",
      permission: "org.create",
    });
  });

  it("asks for step 1 when a later step has no org in the URL, and for an org the user cannot see", async () => {
    const missing = elements(await welcome(["wrap"]));
    expect(missing.some((e) => e.props.kind === "missing")).toBe(true);
    const unknown = elements(
      await welcome(["wrap"], { org: "globex", ws: "labs" }),
    );
    expect(unknown.some((e) => e.props.kind === "not-found")).toBe(true);
  });

  it("wrap and run read the fixture scope; run shows the first frame and the repository", async () => {
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

  it("denied names agent.register on the workspace; loading renders the skeleton", async () => {
    cookieJar.set("mc_state", "denied");
    expect(find(await register(undefined), PageState)?.props.result).toEqual({
      ok: false,
      reason: "denied",
      permission: "agent.register on core-platform",
    });
    cookieJar.set("mc_state", "loading");
    expect((await register(undefined)).type).toBe(GateSkeleton);
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

  it("fixture · the first-frame island and the detected repository", async () => {
    const tree = await runStepElement({ org: "acme", ws: "core-platform" });
    expect(find(tree, FirstFramePanel)?.props).toMatchObject({
      mode: "gate",
      openHref: "/acme/core-platform",
      agentKey: "acme.core.claude-code",
    });
    expect(find(tree, RepoPanel)).toBeDefined();
  });

  it("fixture · error names the host and offers checking again", async () => {
    cookieJar.set("mc_state", "error");
    const tree = await runStepElement({ org: "acme", ws: "core-platform" });
    expect(
      elements(tree).some((e) => e.props.testId === "first-frame-error"),
    ).toBe(true);
    const registerTree = await runStepElement(
      { agent: "perf-watch", harness: "custom", tier: "complex" },
      "register",
    );
    expect(
      elements(registerTree).some(
        (e) => e.props.testId === "first-frame-error",
      ),
    ).toBe(true);
  });

  it("live · the first frame and the repository are NotBacked (G15), with a way on to Fleet", async () => {
    vi.stubEnv("MC_DATA", "live");
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

  it("live · the wrap step renders the installer's NotBacked notice", async () => {
    vi.stubEnv("MC_DATA", "live");
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

  it("wrap step · passes the backed installer through", async () => {
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
    expect(panel?.props.installer).not.toBeNull();
  });
});
