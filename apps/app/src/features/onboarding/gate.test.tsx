// @vitest-environment jsdom
// The gate over Fleet: the rail while the gate is open, and the first-run
// banner once the ingest recorded the run that opened the gate. There is no
// provisional banner: a workspace is created with its steering repo (#4518).
// An organization that predates the gate and a refused read each draw
// nothing, with an axe check in every state.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  onboardingGate,
  onboardingSource,
  runsPage,
} from "./onboarding.builders";

const { router } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { OnboardingGate } = await import("./gate");

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

async function renderGate(read: Parameters<typeof onboardingSource>[0]) {
  const { source, calls } = onboardingSource(read);
  const element = await OnboardingGate({ ctx, source });
  const { container } = render(<IntlProvider>{element}</IntlProvider>);
  return { container, calls };
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

describe("OnboardingGate", () => {
  it("reads the gate for the viewer's organization", async () => {
    const { calls } = await renderGate({
      state: { ok: true, value: onboardingGate() },
    });
    expect(calls.state).toEqual([[ctx]]);
  });

  it("draws the five gate steps with the recorded one current", async () => {
    await renderGate({ state: { ok: true, value: onboardingGate() } });
    expect(railSteps()).toEqual([
      { step: "organization", state: "done" },
      { step: "connect", state: "done" },
      { step: "workspace", state: "done" },
      { step: "wrap", state: "current" },
      { step: "run", state: "todo" },
    ]);
  });

  // The provisional window is gone (#4518). A gate row that still carries one
  // from before draws no banner and offers no bind.
  it("draws no provisional banner while the gate is open (negative)", async () => {
    await renderGate({ state: { ok: true, value: onboardingGate() } });
    expect(screen.getByTestId("onboarding-rail")).toBeInTheDocument();
    expect(screen.queryByTestId("onboarding-provisional")).toBeNull();
    expect(screen.queryByTestId("bind-main-repo")).toBeNull();
  });

  const unlocked = onboardingGate({
    step: "unlocked",
    firstFrameAt: "2026-09-15T14:02:11.000Z",
    firstRunId: "tse_first",
  });

  it("drops the rail once the first frame opened the gate and draws the first run as the design words it", async () => {
    const user = userEvent.setup();
    const { calls } = await renderGate({
      state: { ok: true, value: unlocked },
      runs: runsPage([{ id: "tse_first", agentKey: "acme.core.release-bot" }]),
    });
    expect(calls.runs).toEqual([[ctx, { cursor: null }]]);
    expect(railSteps()).toEqual([]);
    const banner = screen.getByTestId("onboarding-first-run");
    expect(banner).toHaveTextContent("One run so far.");
    expect(banner).toHaveTextContent(
      "This workspace has recorded the installer’s smoke session, tse_first from acme.core.release-bot, and nothing else. The tiles below read off that run.",
    );
    expect(banner.querySelector("[data-banner-badge]")).toHaveAttribute(
      "data-banner-badge",
      "quiet",
    );
    await user.click(
      screen.getByRole("button", { name: "Show the seeded fleet" }),
    );
    expect(screen.queryByTestId("onboarding-first-run")).toBeNull();
  });

  it("draws no first-run banner once the workspace holds a second run (negative)", async () => {
    await renderGate({
      state: { ok: true, value: unlocked },
      runs: runsPage([
        { id: "tse_second", agentKey: "acme.core.release-bot" },
        { id: "tse_first", agentKey: "acme.core.release-bot" },
      ]),
    });
    expect(screen.queryByTestId("onboarding-first-run")).toBeNull();
  });

  it("draws no first-run banner when the runs read failed (negative)", async () => {
    await renderGate({
      state: { ok: true, value: unlocked },
      runs: readError("run_index_unavailable", 503),
    });
    expect(screen.queryByTestId("onboarding-first-run")).toBeNull();
  });

  it("draws nothing once the gate is open and the first run is not on this page (negative)", async () => {
    const { container } = await renderGate({
      state: {
        ok: true,
        value: onboardingGate({
          step: "unlocked",
          firstRunId: "tse_first",
          workspace: { id: "wrk_other", slug: "other-workspace" },
        }),
      },
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("draws nothing for an organization that predates the gate (negative)", async () => {
    const { container } = await renderGate({
      state: {
        ok: true,
        value: onboardingGate({
          step: "unlocked",
          workspace: null,
          provisional: null,
        }),
      },
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("draws nothing when the gate read failed, leaving Fleet to report its own failure (negative)", async () => {
    const { container } = await renderGate({
      state: readError("onboarding_state_unavailable", 503),
    });
    expect(container).toBeEmptyDOMElement();
  });
});
