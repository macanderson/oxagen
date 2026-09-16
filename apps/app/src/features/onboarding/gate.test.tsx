// @vitest-environment jsdom
// The gate over Fleet: the rail while the gate is open, the provisional banner
// while no main repo is bound, and the first-run banner once the ingest
// recorded the run that opened the gate. An organization that predates the
// gate, a bound workspace and a refused read each draw nothing, with an axe
// check in every state.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { onboardingGate, onboardingSource } from "./onboarding.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
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

  it("draws the three gate steps with the recorded one current", async () => {
    await renderGate({ state: { ok: true, value: onboardingGate() } });
    expect(railSteps()).toEqual([
      { step: "organization", state: "done" },
      { step: "wrap", state: "current" },
      { step: "run", state: "todo" },
    ]);
  });

  it("names the provisional window and offers the repository the host reported", async () => {
    await renderGate({ state: { ok: true, value: onboardingGate() } });
    const banner = screen.getByTestId("onboarding-provisional");
    expect(banner).toHaveTextContent(
      "core-platform is provisional until Sep 29, 2026",
    );
    expect(banner).toHaveTextContent(
      "Steering, context records and agent definitions stay off",
    );
    expect(screen.getByTestId("bind-main-repo")).toHaveTextContent(
      "Bind acme/platform",
    );
  });

  it("says a workspace with no reported remote has nothing to bind here (negative)", async () => {
    await renderGate({
      state: {
        ok: true,
        value: onboardingGate({
          provisional: {
            until: "2026-09-29T00:00:00.000Z",
            mainRepoBoundAt: null,
            detectedRepository: null,
          },
        }),
      },
    });
    expect(screen.getByTestId("onboarding-provisional")).toHaveTextContent(
      "No enrolled host has reported a GitHub remote",
    );
    expect(screen.queryByTestId("bind-main-repo")).toBeNull();
  });

  it("drops the rail once the first frame opened the gate and names the run it recorded", async () => {
    await renderGate({
      state: {
        ok: true,
        value: onboardingGate({
          step: "unlocked",
          firstFrameAt: "2026-09-15T14:02:11.000Z",
          firstRunId: "tse_first",
        }),
      },
    });
    expect(railSteps()).toEqual([]);
    const banner = screen.getByTestId("onboarding-first-run");
    expect(banner).toHaveTextContent("tse_first");
    expect(banner).toHaveTextContent("Open the first run");
  });

  it("draws nothing once the gate is open and a main repo is bound (negative)", async () => {
    const { container } = await renderGate({
      state: {
        ok: true,
        value: onboardingGate({
          step: "unlocked",
          firstRunId: "tse_first",
          provisional: {
            until: "2026-09-29T00:00:00.000Z",
            mainRepoBoundAt: "2026-09-16T00:00:00.000Z",
            detectedRepository: null,
          },
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
