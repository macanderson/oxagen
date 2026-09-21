// @vitest-environment jsdom
// The three islands of Register an agent, driven the way an operator drives
// them: the name form's refusal and its credential shown once, the wrap step's
// token mint and its continue, and the run step's re-read and repository bind.
// Every write is answered ok and refused, so each refusal path renders its
// sentence and changes nothing.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const {
  router,
  registerAgent,
  issueEnrollmentToken,
  advanceOnboarding,
  bindMainRepository,
} = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  registerAgent: vi.fn(),
  issueEnrollmentToken: vi.fn(),
  advanceOnboarding: vi.fn(),
  bindMainRepository: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  registerAgent,
  issueEnrollmentToken,
  advanceOnboarding,
  bindMainRepository,
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { RegisterAgentForm } = await import("./ui/register-form");
const { WrapAgent } = await import("./ui/wrap-agent");
const { FirstFrameStep } = await import("./ui/first-frame");

const ORG = "acme";
const WS = "core-platform";
const HERE = routes.register(ORG, WS, "run", { agent: "agt_releasebot" });
const NEXT = routes.register(ORG, WS, "run", { agent: "agt_releasebot" });
const BACK = routes.register(ORG, WS, "name");

const DENIED = {
  ok: false,
  reason: "denied",
  code: "org_role_required",
} as const;

function renderForm() {
  render(
    <IntlProvider>
      <RegisterAgentForm org={ORG} ws={WS} />
    </IntlProvider>,
  );
}

function renderWrap(
  gated: boolean,
  harness: "claude-code" | "claude-agent-sdk" | "custom" | "stella",
) {
  render(
    <IntlProvider>
      <WrapAgent
        org={ORG}
        ws={WS}
        agentId="agt_releasebot"
        harness={harness}
        gated={gated}
        back={BACK}
        next={NEXT}
      />
    </IntlProvider>,
  );
}

function renderRun(
  repository: { owner: string; name: string } | null,
  host: { hostEnrollmentId: string } | null = null,
) {
  render(
    <IntlProvider>
      <FirstFrameStep
        org={ORG}
        ws={WS}
        workspace="Core platform"
        agentKey="acme.core.release-bot"
        host={
          host === null
            ? null
            : {
                hostEnrollmentId: host.hostEnrollmentId,
                enrolledAt: "2026-09-15T14:00:00.000Z",
                lastHeartbeatAt: null,
                hooksOk: null,
              }
        }
        here={HERE}
        repository={
          repository === null
            ? null
            : {
                provider: "github",
                owner: repository.owner,
                name: repository.name,
              }
        }
        provisionalUntil={
          repository === null ? null : "2026-09-29T00:00:00.000Z"
        }
      />
    </IntlProvider>,
  );
}

beforeEach(() => {
  router.push.mockClear();
  router.replace.mockClear();
  router.refresh.mockClear();
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("the name form", () => {
  it("refuses a slug the contract would refuse without calling the write (negative)", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText("Slug"), "Release Bot");
    await user.type(screen.getByLabelText("Display name"), "Release bot");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(registerAgent).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Use up to 18 lowercase letters/),
    ).toBeInTheDocument();
  });

  it("registers the agent and shows the credential once, with the wrap step to continue to", async () => {
    registerAgent.mockResolvedValue({
      ok: true,
      value: {
        agentId: "agt_releasebot",
        agentKey: "acme.core.release-bot",
        secret: "oxa_ag_s3cr3t",
        expiresAt: "2027-03-14T00:00:00.000Z",
        to: NEXT,
      },
    });
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText("Slug"), "release-bot");
    await user.type(screen.getByLabelText("Display name"), "Release bot");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(registerAgent).toHaveBeenCalledWith(ORG, WS, {
      slug: "release-bot",
      name: "Release bot",
      description: "",
      harness: "claude-code",
    });
    expect(screen.getByTestId("agent-credential")).toHaveTextContent(
      "oxa_ag_s3cr3t",
    );
    expect(
      screen.getByRole("link", { name: "Continue to wrap" }),
    ).toBeInTheDocument();
  });

  it("names a refusal and keeps the form (negative)", async () => {
    registerAgent.mockResolvedValue(DENIED);
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText("Slug"), "release-bot");
    await user.type(screen.getByLabelText("Display name"), "Release bot");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByTestId("register-failure")).toHaveTextContent(
      "This account may not register agents here",
    );
    expect(screen.queryByTestId("agent-credential")).toBeNull();
  });
});

describe("the wrap step", () => {
  it("mints the one-time token and prints it with the command that uses it", async () => {
    issueEnrollmentToken.mockResolvedValue({
      ok: true,
      value: {
        token: "oxe_1time_7qk4m2nv9xr3t8zpabcdefghjk",
        expiresAt: "2026-09-15T14:30:00.000Z",
        agentKey: "acme.core.release-bot",
        enrollCommand:
          "oxagen agent enroll --token oxe_1time_7qk4m2nv9xr3t8zpabcdefghjk",
      },
    });
    const user = userEvent.setup();
    renderWrap(true, "claude-code");
    await user.click(
      screen.getByRole("button", { name: "Mint the one-time token" }),
    );
    expect(issueEnrollmentToken).toHaveBeenCalledWith(
      ORG,
      WS,
      "agt_releasebot",
    );
    expect(screen.getByTestId("enrollment-token-value")).toHaveTextContent(
      "oxe_1time_7qk4m2nv9xr3t8zpabcdefghjk",
    );
    expect(screen.getByTestId("enrollment-token")).toHaveTextContent(
      "oxagen agent enroll --token",
    );
    expect(
      screen.getByRole("button", { name: "Mint another token" }),
    ).toBeInTheDocument();
  });

  it("names a refused mint and prints no token (negative)", async () => {
    issueEnrollmentToken.mockResolvedValue(DENIED);
    const user = userEvent.setup();
    renderWrap(true, "claude-code");
    await user.click(
      screen.getByRole("button", { name: "Mint the one-time token" }),
    );
    expect(screen.getByTestId("wrap-failure")).toBeInTheDocument();
    expect(screen.queryByTestId("enrollment-token")).toBeNull();
  });

  it("moves the gate's step, then opens the run step", async () => {
    advanceOnboarding.mockResolvedValue({
      ok: true,
      value: { step: "run", changedAt: "2026-09-15T14:00:00.000Z" },
    });
    const user = userEvent.setup();
    renderWrap(true, "claude-code");
    await user.click(
      screen.getByRole("button", { name: "I have already installed it" }),
    );
    expect(advanceOnboarding).toHaveBeenCalledWith(ORG, WS, "run");
    expect(router.push).toHaveBeenCalledWith(NEXT);
  });

  it("moves no gate for a workspace that carries none (negative)", async () => {
    const user = userEvent.setup();
    renderWrap(false, "claude-code");
    await user.click(
      screen.getByRole("button", { name: "I have already installed it" }),
    );
    expect(advanceOnboarding).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith(NEXT);
  });

  it("stays on the step when the gate refuses the move (negative)", async () => {
    advanceOnboarding.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "first_frame_required",
    });
    const user = userEvent.setup();
    renderWrap(true, "claude-code");
    await user.click(
      screen.getByRole("button", { name: "I have already installed it" }),
    );
    expect(screen.getByTestId("advance-failure")).toHaveTextContent(
      "The run step completes when the first frame arrives",
    );
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("the run step", () => {
  it("does not poll while no host has enrolled, and re-reads when asked", async () => {
    const user = userEvent.setup();
    renderRun(null);
    expect(router.refresh).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("asks for one wait per enrolled host, not one per render", async () => {
    const user = userEvent.setup();
    renderRun(null, { hostEnrollmentId: "hen_1" });
    // The effect fires for the record, not for the render. Clicking adds one
    // ask, and the re-render its pending state causes adds none: `waitMs` is
    // 20 s per invoke, so a per-render effect would spend the budget several
    // times over on one click (ARCHITECTURE.md §3.5).
    expect(router.refresh).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(router.refresh).toHaveBeenCalledTimes(2);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("binds the detected repository and re-reads the step", async () => {
    bindMainRepository.mockResolvedValue({
      ok: true,
      value: {
        fullName: "acme/platform",
        defaultRef: "main",
        boundAt: "2026-09-15T14:10:00.000Z",
        provisionalClosed: true,
      },
    });
    const user = userEvent.setup();
    renderRun({ owner: "acme", name: "platform" });
    await user.click(
      screen.getByRole("button", {
        name: "Bind acme/platform as the main repo",
      }),
    );
    expect(bindMainRepository).toHaveBeenCalledWith(ORG, WS, {
      owner: "acme",
      name: "platform",
    });
    expect(router.replace).toHaveBeenCalledWith(HERE);
  });

  it("names a refused bind and leaves the workspace provisional (negative)", async () => {
    bindMainRepository.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "github_not_connected",
    });
    const user = userEvent.setup();
    renderRun({ owner: "acme", name: "platform" });
    await user.click(
      screen.getByRole("button", {
        name: "Bind acme/platform as the main repo",
      }),
    );
    expect(screen.getByTestId("bind-failure")).toHaveTextContent(
      "No GitHub App installation reaches this workspace",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("supported wrapping paths", () => {
  it.each(["claude-agent-sdk", "custom"] as const)(
    "keeps %s on an honest unavailable step",
    async (harness) => {
      renderWrap(true, harness);
      expect(screen.getByTestId("wrap-unavailable")).toHaveTextContent(
        "Wrapping is not available for this harness",
      );
      expect(
        screen.queryByRole("button", { name: "I have already installed it" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Mint the one-time token" }),
      ).toBeNull();
      expect(document.body.textContent).not.toContain("@oxagen/sdk");
      expect(document.body.textContent).not.toContain("oxagen.agent.wrap");
      expect(advanceOnboarding).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      await expectNoAxe(document.body);
    },
  );
  it("offers Stella the existing host enrollment path", () => {
    renderWrap(true, "stella");
    expect(
      screen.getByRole("button", { name: "Mint the one-time token" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("wrap-unavailable")).toBeNull();
  });
});
