// @vitest-environment jsdom
// Register an agent over a fake DataSource, inside its gate: the top bar and
// the rail on every step, the name step's namespaces and reserved key, the
// wrap step's identity and gate reads, the run step's wait, the first frame
// once it lands, and the error, denied and loading states each spec lists.
// Axe runs after every test.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { agentDetail } from "../agents/agents.builders";
import { runChain, runDetail, runFrame } from "../run/run.builders";
import {
  firstFrame,
  onboardingGate,
  onboardingSource,
} from "./onboarding.builders";

const { readRegisterPlace, getAuthUser } = vi.hoisted(() => ({
  readRegisterPlace: vi.fn(),
  getAuthUser: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("./actions", () => ({
  registerAgent: vi.fn(),
  issueEnrollmentToken: vi.fn(),
  advanceOnboarding: vi.fn(),
  bindMainRepository: vi.fn(),
}));
vi.mock("./register-actions", () => ({
  readRegisterPlace,
  cancelRegistration: vi.fn(),
  issueAgentCredential: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn(), getAuthUser }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { RegisterAgent, RegisterGate, RegisterSkeleton } = await import(
  "./register"
);

function viewer(orgRole: "owner" | "member") {
  return unsafeMint(WsCtx, {
    userId: "usr_marcusbell",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole,
    workspaceId: "7b000000-0000-4000-8000-000000000001",
    wsSlug: "core-platform",
    wsName: "Core platform",
    wsRole: "member",
  });
}
const ctx = viewer("owner");

const HOST_ID = "tch_0123456789abcdefghijkl";
const CAPTION =
  "Registration does not complete until the agent has talked to Oxagen. That first frame is also the installer's smoke test, so there is one path, not two. Cancel at any time.";

async function renderStep(
  step: "name" | "wrap" | "run",
  agent: string | null,
  reads: Parameters<typeof onboardingSource>[0] = {},
  who = ctx,
) {
  const { source, calls } = onboardingSource(reads);
  const body = await RegisterAgent({ ctx: who, source, step, agent });
  const element = await RegisterGate({ ctx: who, step, agent, children: body });
  render(<IntlProvider>{element}</IntlProvider>);
  return calls;
}

const railSteps = () =>
  screen.queryAllByTestId("rail-step").map((step) => ({
    step: step.getAttribute("data-step"),
    state: step.getAttribute("data-state"),
  }));

beforeEach(() => {
  readRegisterPlace.mockReset();
  readRegisterPlace.mockResolvedValue({
    ok: true,
    value: { keyPrefix: "acme.core", repository: "acme/platform" },
  });
  getAuthUser.mockReset();
  getAuthUser.mockResolvedValue({
    id: "usr_marcusbell",
    name: "Marcus Bell",
    email: "marcus@acme.example",
  });
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("the gate", () => {
  it("draws the brandmark, the signed-in email, Cancel, the rail and the caption", async () => {
    await renderStep("name", null);
    expect(screen.getByRole("link", { name: "Oxagen home" })).toHaveAttribute(
      "href",
      "/acme/core-platform",
    );
    expect(screen.getByTestId("register-email")).toHaveTextContent(
      "marcus@acme.example",
    );
    expect(screen.getByTestId("register-cancel-top")).toHaveAttribute(
      "href",
      "/acme/core-platform",
    );
    expect(screen.getByText(CAPTION)).toBeInTheDocument();
  });

  it("marks the first step current and disables the two after it", async () => {
    await renderStep("name", null);
    const rail = screen.getByRole("navigation", { name: "Register an agent" });
    expect(railSteps()).toEqual([
      { step: "name", state: "current" },
      { step: "wrap", state: "todo" },
      { step: "run", state: "todo" },
    ]);
    expect(
      within(rail).getByText("Define the agent").closest("[aria-current]"),
    ).toHaveAttribute("aria-current", "step");
    for (const label of ["Wrap the agent", "Wait for the first frame"])
      expect(
        within(rail).getByRole("button", { name: new RegExp(label) }),
      ).toBeDisabled();
  });

  it("turns each done step into a link back carrying the identity", async () => {
    await renderStep("run", "agt_releasebot", {
      firstFrame: readOk(firstFrame()),
      agent: readOk(agentDetail()),
    });
    const rail = screen.getByRole("navigation", { name: "Register an agent" });
    expect(railSteps()).toEqual([
      { step: "name", state: "done" },
      { step: "wrap", state: "done" },
      { step: "run", state: "current" },
    ]);
    expect(
      within(rail).getByRole("link", { name: /Define the agent/ }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/register/name?agent=agt_releasebot",
    );
    expect(
      within(rail).getByRole("link", { name: /Wrap the agent/ }),
    ).toHaveTextContent("✓");
  });

  it("keeps the rail under the loading skeleton: four tiles and a panel of seven rows", () => {
    render(
      <IntlProvider>
        <RegisterSkeleton />
      </IntlProvider>,
    );
    const loading = screen.getByTestId("register-loading");
    expect(loading).toHaveAttribute("role", "status");
    expect(loading).toHaveTextContent("Loading the step");
    expect(loading.querySelectorAll(".h-16")).toHaveLength(4);
    expect(loading.querySelectorAll(".h-9")).toHaveLength(7);
    // Every bone is the design's shimmer, as on every other page, and none pulses.
    expect(loading.querySelectorAll(".skeleton")).toHaveLength(12);
    expect(loading.querySelector(".animate-pulse")).toBeNull();
  });
});

describe("the denied state", () => {
  it("names the missing permission, offers Request access and Back to Fleet, and reads nothing", async () => {
    const calls = await renderStep(
      "wrap",
      "agt_releasebot",
      {},
      viewer("member"),
    );
    const denied = screen.getByTestId("register-denied");
    expect(
      within(denied).getByRole("heading", {
        level: 1,
        name: "You cannot see agent registration",
      }),
    ).toBeInTheDocument();
    expect(denied).toHaveTextContent(
      "Your roles on Acme Robotics do not include agent.register on core-platform. An organization owner can grant it; the grant is a governed action and lands in the audit record with your name on it.",
    );
    expect(
      within(denied).getByRole("button", { name: "Request access" }),
    ).toBeInTheDocument();
    expect(
      within(denied).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core-platform");
    expect(denied).toHaveTextContent(
      "Signed in asMarcus Bell · member · core-platform",
    );
    expect(denied).toHaveTextContent("Neededagent.register on core-platform");
    expect(denied).toHaveTextContent(
      "Decided byregister_agent · organization owner or admin",
    );
    expect(calls.agent).toEqual([]);
    expect(calls.state).toEqual([]);
    expect(readRegisterPlace).not.toHaveBeenCalled();
    // The rail stays so the viewer keeps their bearings.
    expect(railSteps()).toHaveLength(3);
  });
});

describe("the name step", () => {
  it("heads the step verbatim and builds the key from the workspace namespaces", async () => {
    await renderStep("name", null);
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Define the agent" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The key is reserved now and is immutable\./),
    ).toBeInTheDocument();
    expect(readRegisterPlace).toHaveBeenCalledWith("acme", "core-platform");
    expect(screen.getAllByTestId("register-key")[0]).toHaveTextContent(
      "acme.core.agent",
    );
  });

  it("offers the named runtimes with the one Add a runtime chose already chosen (ADR-198)", async () => {
    const { source } = onboardingSource({
      runtimes: readOk({
        runtimes: [
          {
            id: "rtm_buildbox",
            name: "Build box",
            slug: "build-box",
            createdAt: "2026-09-21T10:00:00.000Z",
            agents: [],
            liveHosts: 0,
            lastSeenAt: null,
          },
        ],
      }),
    });
    const body = await RegisterAgent({
      ctx,
      source,
      step: "name",
      agent: null,
      runtime: "rtm_buildbox",
    });
    render(<IntlProvider>{body}</IntlProvider>);
    expect(
      within(screen.getByRole("radiogroup", { name: "Runtime" })).getByRole(
        "radio",
        { name: /Build box/ },
      ),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("radiogroup", { name: "Toolbelt" }),
    ).toBeInTheDocument();
  });

  it("names a refused workspace read instead of drawing a key it cannot build (negative)", async () => {
    readRegisterPlace.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    await renderStep("name", null);
    expect(screen.getByTestId("register-place-failure")).toHaveTextContent(
      "This account may not register agents here.",
    );
    expect(screen.queryByLabelText("Slug")).not.toBeInTheDocument();
  });

  it("reads the agent already reserved and shows it read-only", async () => {
    const calls = await renderStep("name", "agt_releasebot", {
      agent: readOk(agentDetail()),
    });
    expect(calls.agent).toEqual([[ctx, "agt_releasebot"]]);
    expect(screen.getByTestId("register-reserved")).toHaveTextContent(
      "release-bot",
    );
    expect(screen.queryByLabelText("Slug")).not.toBeInTheDocument();
  });
});

describe("the wrap step", () => {
  it("sends the operator back to the first step when no identity exists (negative)", async () => {
    const calls = await renderStep("wrap", null);
    expect(screen.getByTestId("register-no-agent")).toHaveTextContent(
      "No agent to wrap yet",
    );
    expect(calls.agent).toEqual([]);
  });

  it("reads the identity and the gate and heads the step with the agent key", async () => {
    const calls = await renderStep("wrap", "agt_releasebot", {
      state: readOk(onboardingGate()),
      agent: readOk(agentDetail()),
    });
    expect(calls.agent).toEqual([[ctx, "agt_releasebot"]]);
    expect(calls.state).toHaveLength(1);
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Wrap the agent" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/The enrollment token for/)).toHaveTextContent(
      "The enrollment token for acme.core.release-bot is single use, so the machine that presents it becomes this agent's host.",
    );
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "data-tab",
      "claude-code",
    );
  });

  it("answers an identity outside this workspace with a 404 (negative)", async () => {
    await expect(
      renderStep("wrap", "agt_gone", {
        state: readOk(onboardingGate()),
        agent: readError("agent_not_found", 404),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("names a refused identity read and draws no tabs (negative)", async () => {
    await renderStep("wrap", "agt_releasebot", {
      state: readOk(onboardingGate()),
      agent: readError("upstream", 503),
    });
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByText(/upstream/)).toBeInTheDocument();
  });
});

describe("the run step", () => {
  const waitingFrame = firstFrame({
    agentKey: "acme.core.release-bot",
    host: {
      hostEnrollmentId: HOST_ID,
      enrolledAt: "2026-09-15T14:01:48.000Z",
      lastHeartbeatAt: "2026-09-15T14:01:52.000Z",
      hooksOk: true,
    },
  });

  it("waits with the spinner, the chips, the recorded log lines and no gold action", async () => {
    const calls = await renderStep("run", "agt_releasebot", {
      firstFrame: readOk(waitingFrame),
      agent: readOk(agentDetail()),
    });
    expect(calls.firstFrame).toEqual([
      [ctx, "agt_releasebot", { waitMs: 20_000 }],
    ]);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Wait for the first frame",
      }),
    ).toBeInTheDocument();
    const card = screen.getByTestId("first-frame-waiting");
    expect(
      within(card).getByRole("heading", {
        name: "Waiting for the first frame",
      }),
    ).toBeInTheDocument();
    expect(card).toHaveTextContent("polling");
    expect(
      within(screen.getByTestId("first-frame-chips"))
        .getAllByText(/./)
        .map((chip) => chip.textContent),
    ).toEqual(["acme.core.release-bot", "Claude Code", "host build-01"]);
    const log = screen.getByTestId("first-frame-log");
    expect(log).toHaveTextContent("host enrolled · device key sha256:ab12cd34");
    expect(log).toHaveTextContent("collector reported");
    expect(log).toHaveTextContent("hooks written · ~/.claude/settings.json");
    expect(log).toHaveTextContent("waiting…");
    expect(card).toHaveTextContent(
      "Start Claude Code in any repository on build-01. This card flips on its own when the first frame lands.",
    );
    expect(
      screen.getByText("There is no Done button. The frame is the completion."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Done|Finish/ })).toBeNull();
    expect(
      document.querySelectorAll('[class*="bg-button-primary-bg"]'),
    ).toHaveLength(0);
  });

  it("says no host has enrolled when none has", async () => {
    await renderStep("run", "agt_releasebot", {
      firstFrame: readOk(firstFrame({ host: null })),
      agent: readOk(agentDetail({ hosts: [] })),
    });
    expect(screen.getByText("no host yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No host has enrolled for this agent. The token from the previous step is what enrols one.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the first frames, the recorded tier, grade and chain, and Open in Fleet", async () => {
    const calls = await renderStep("run", "agt_releasebot", {
      firstFrame: readOk(
        firstFrame({
          firstFrame: {
            runId: "run_first",
            receivedAt: "2026-09-15T14:02:11.402Z",
          },
        }),
      ),
      agent: readOk(agentDetail()),
      run: readOk(
        runDetail({
          frames: {
            frames: [
              runFrame({
                seq: "0",
                type: "agent_start",
                summary: "harness=claude-code",
              }),
              runFrame({
                seq: "1",
                type: "oxagen:run.start",
                summary: "tier=harness",
              }),
              runFrame({ seq: "2", type: "model.call_completed" }),
            ],
            cursor: null,
            more: false,
          },
        }),
      ),
      chain: readOk(runChain()),
    });
    expect(calls.run).toEqual([[ctx, "run_first", { framesAfter: null }]]);
    const card = screen.getByTestId("first-frame-received");
    expect(card).toHaveTextContent("connected");
    expect(
      within(card).getByRole("heading", { name: "First frame received" }),
    ).toBeInTheDocument();
    const frames = within(screen.getByTestId("first-frames")).getAllByRole(
      "listitem",
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveTextContent("agent_start");
    expect(frames[1]).toHaveTextContent("oxagen:run.start");
    const badges = screen.getByTestId("first-frame-badges");
    expect(badges).toHaveTextContent("harness");
    expect(badges).toHaveTextContent("replay grade: fork");
    expect(badges).toHaveTextContent("chain intact");
    expect(card).toHaveTextContent(
      "The hooks answered, so this run is harness: delivered, recorded, client-attested, fail-open.",
    );
    expect(
      screen.getByRole("button", { name: "Open in Fleet" }),
    ).toBeInTheDocument();
    expect(document.getElementById("regAuto")).toHaveTextContent(
      "Opening automatically…",
    );
  });

  it("claims nothing stronger than the recorded tier and chain (negative)", async () => {
    await renderStep("run", "agt_releasebot", {
      firstFrame: readOk(
        firstFrame({
          firstFrame: {
            runId: "run_first",
            receivedAt: "2026-09-15T14:02:11.402Z",
          },
        }),
      ),
      agent: readOk(agentDetail()),
      run: readOk(runDetail()),
      chain: readOk(
        runChain({
          enforcementTier: "observe",
          recordedGrade: null,
          gaps: {
            missingSequences: [{ from: "3", to: "4" }],
            missingFrameCount: 2,
            missingBodies: 0,
            recorded: [],
          },
        }),
      ),
    });
    const badges = screen.getByTestId("first-frame-badges");
    expect(badges).toHaveTextContent("observe");
    expect(badges).toHaveTextContent("2 frames missing");
    expect(badges).not.toHaveTextContent("chain intact");
    expect(badges).not.toHaveTextContent("replay grade");
    expect(screen.queryByText(/this run is/)).not.toBeInTheDocument();
  });

  it("names a failed first-frame read with Check again, Cancel and Back, and no gold action", async () => {
    await renderStep("run", "agt_releasebot", {
      firstFrame: readError("upstream", 503),
      agent: readOk(agentDetail()),
    });
    const error = screen.getByTestId("first-frame-error");
    expect(
      within(error).getByRole("heading", {
        name: "The first frame cannot be read",
      }),
    ).toBeInTheDocument();
    expect(
      within(error).getByRole("button", { name: "Check again" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute(
      "href",
      "/acme/core-platform/register/wrap?agent=agt_releasebot",
    );
    expect(
      document.querySelectorAll('[class*="bg-button-primary-bg"]'),
    ).toHaveLength(0);
  });
});
