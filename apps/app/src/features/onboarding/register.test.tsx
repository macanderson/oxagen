// @vitest-environment jsdom
// Register an agent over a fake DataSource: the stepper, the name form, the
// two wrap paths, the wait for the first frame and the frame once it lands,
// plus the states each step reaches when a read is refused or no identity
// exists. Axe runs after every test.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { agentDetail } from "../agents/agents.builders";
import {
  firstFrame,
  onboardingGate,
  onboardingSource,
} from "./onboarding.builders";

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
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { RegisterAgent } = await import("./register");

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

async function renderStep(
  step: "name" | "wrap" | "run",
  agent: string | null,
  reads: Parameters<typeof onboardingSource>[0] = {},
) {
  const { source, calls } = onboardingSource(reads);
  const element = await RegisterAgent({ ctx, source, step, agent });
  render(<IntlProvider>{element}</IntlProvider>);
  return calls;
}

const railSteps = () =>
  screen.queryAllByTestId("rail-step").map((step) => ({
    step: step.getAttribute("data-step"),
    state: step.getAttribute("data-state"),
  }));

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("the name step", () => {
  it("draws the stepper with the first step current and reads nothing", async () => {
    const calls = await renderStep("name", null);
    expect(railSteps()).toEqual([
      { step: "name", state: "current" },
      { step: "wrap", state: "todo" },
      { step: "run", state: "todo" },
    ]);
    expect(calls.state).toEqual([]);
    expect(calls.agent).toEqual([]);
  });

  it("names the step under the page and offers the form", async () => {
    await renderStep("name", null);
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(
      screen.getByRole("form", { name: "Name the agent" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Slug")).toBeInTheDocument();
    expect(screen.getByLabelText("Harness")).toBeInTheDocument();
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

  it("reads the identity and offers the host path for a hook-based harness", async () => {
    const calls = await renderStep("wrap", "agt_releasebot", {
      state: readOk(onboardingGate()),
      agent: readOk(agentDetail()),
    });
    expect(calls.agent).toEqual([[ctx, "agt_releasebot"]]);
    expect(screen.getByTestId("register-identity")).toHaveTextContent(
      "acme.core.release-bot",
    );
    expect(
      screen.getByRole("button", { name: "Mint the one-time token" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("wrap-unavailable")).toBeNull();
  });

  it("shows the missing SDK adapter without invented installation instructions", async () => {
    await renderStep("wrap", "agt_releasebot", {
      state: readOk(onboardingGate()),
      agent: readOk(agentDetail({ identity: { harness: "claude-agent-sdk" } })),
    });
    expect(screen.getByTestId("wrap-unavailable")).toHaveTextContent(
      "Wrapping is not available for this harness",
    );
    expect(
      screen.queryByRole("button", { name: "Mint the one-time token" }),
    ).toBeNull();
  });

  it("renders the read's failure in place of the step (negative)", async () => {
    await renderStep("wrap", "agt_releasebot", {
      state: readOk(onboardingGate()),
      agent: { ok: false, reason: "denied", permission: "agent.read" },
    });
    expect(screen.getByText(/You cannot see Register an agent/)).toBeVisible();
  });
});

describe("the run step", () => {
  it("waits on the record with the contract's budget and names the host that enrolled", async () => {
    const calls = await renderStep("run", "agt_releasebot", {
      state: readOk(onboardingGate({ step: "run" })),
      firstFrame: readOk(firstFrame()),
    });
    expect(calls.firstFrame).toEqual([
      [ctx, "agt_releasebot", { waitMs: 20_000 }],
    ]);
    expect(screen.getByTestId("first-frame-waiting")).toHaveTextContent(
      "Waiting for the first frame",
    );
    expect(screen.getByTestId("first-frame-host")).toHaveTextContent(
      "Hooks written and checked.",
    );
  });

  it("says nothing has enrolled yet rather than waiting on nothing (negative)", async () => {
    await renderStep("run", "agt_releasebot", {
      state: readOk(onboardingGate({ step: "run" })),
      firstFrame: readOk(firstFrame({ host: null })),
    });
    expect(screen.getByTestId("first-frame-no-host")).toHaveTextContent(
      "No host has enrolled for this agent",
    );
    expect(screen.queryByTestId("first-frame-host")).toBeNull();
  });

  it("offers the detected repository while the workspace is provisional", async () => {
    await renderStep("run", "agt_releasebot", {
      state: readOk(onboardingGate({ step: "run" })),
      firstFrame: readOk(firstFrame()),
    });
    const panel = screen.getByTestId("detected-repository");
    expect(panel).toHaveTextContent("acme/platform");
    expect(
      screen.getByRole("button", {
        name: "Bind acme/platform as the main repo",
      }),
    ).toBeInTheDocument();
  });

  it("drops the repository offer once a main repo is bound (negative)", async () => {
    await renderStep("run", "agt_releasebot", {
      state: readOk(
        onboardingGate({
          step: "run",
          provisional: {
            until: "2026-09-29T00:00:00.000Z",
            mainRepoBoundAt: "2026-09-16T00:00:00.000Z",
            detectedRepository: {
              provider: "github",
              owner: "acme",
              name: "platform",
            },
          },
        }),
      ),
      firstFrame: readOk(firstFrame()),
    });
    expect(screen.queryByTestId("detected-repository")).toBeNull();
  });

  it("shows the frame and the run it opened once one arrives", async () => {
    await renderStep("run", "agt_releasebot", {
      state: readOk(onboardingGate({ step: "unlocked" })),
      firstFrame: readOk(
        firstFrame({
          firstFrame: {
            runId: "tse_first",
            receivedAt: "2026-09-15T14:02:11.000Z",
          },
        }),
      ),
    });
    const panel = screen.getByTestId("first-frame-received");
    expect(panel).toHaveTextContent("tse_first");
    expect(panel).toHaveTextContent("Open in Fleet");
    expect(screen.queryByTestId("first-frame-waiting")).toBeNull();
  });

  it("renders the read's failure in place of the step (negative)", async () => {
    await renderStep("run", "agt_releasebot", {
      state: readOk(onboardingGate({ step: "run" })),
      firstFrame: readError("onboarding_state_unavailable", 503),
    });
    expect(screen.getByText(/onboarding_state_unavailable/)).toBeVisible();
  });
});
