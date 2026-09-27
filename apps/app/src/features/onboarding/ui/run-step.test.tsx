// @vitest-environment jsdom
// Onboarding step 5 as an operator meets it: the wait with the chips and the
// log the record holds, the re-read a second after each read, the received
// card with only the trust words the run recorded and the countdown to Fleet,
// and the silent-host error.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const { RunStep, COUNTDOWN_SECONDS } = await import("./run-step");

const FLEET = routes.fleet("aintel", "core");
const AGENT = {
  id: "agt_rm",
  key: "aintel.core.release-manager",
  harness: "claude-code",
  credentialPrefix: null,
};
const HOST = {
  hostEnrollmentId: "hen_01",
  enrolledAt: "2026-09-23T14:01:48.000Z",
  lastHeartbeatAt: "2026-09-23T14:01:52.000Z",
  hooksOk: true,
};
const RECEIVED = {
  runId: "run_01",
  receivedAt: "2026-09-23T14:02:11.402Z",
  frames: [
    {
      seq: "0",
      at: "2026-09-23T14:02:11.402Z",
      type: "agent_start",
      summary: "harness=claude-code",
    },
    {
      seq: "1",
      at: "2026-09-23T14:02:11.418Z",
      type: "oxagen:run.start",
      summary: "tier=harness",
    },
  ],
  tier: "harness" as const,
  replayGrade: "fork" as const,
  chainIntact: true,
};

type Props = Parameters<typeof RunStep>[0];

function renderStep(props: Partial<Props> = {}): void {
  render(
    <IntlProvider>
      <RunStep
        fleet={FLEET}
        back={routes.welcome("aintel", "core", "wrap", { agent: "agt_rm" })}
        installer={routes.welcome("aintel", "core", "installer", {
          agent: "agt_rm",
        })}
        register={routes.register("aintel", "core", "name")}
        pollRevision="r1"
        agent={AGENT}
        host={HOST}
        received={null}
        silentFor={null}
        {...props}
      />
    </IntlProvider>,
  );
}

const goldButtons = () =>
  [...document.querySelectorAll("a, button")].filter((el) =>
    el.className.includes("bg-button-primary-bg"),
  );

beforeEach(() => {
  router.push.mockReset();
  router.refresh.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("RunStep while waiting", () => {
  it("draws the header, the waiting card with the chips and the log the record holds, and the waiting footer", () => {
    renderStep();
    expect(screen.getByText("Step 5 of 5")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Start a run" }),
    ).toBeInTheDocument();
    const card = screen.getByTestId("first-frame-waiting");
    expect(
      within(card).getByRole("heading", {
        name: "Waiting for the first frame",
      }),
    ).toBeInTheDocument();
    expect(card).toHaveTextContent("polling · 1s");
    expect(card).toHaveTextContent("aintel.core.release-manager");
    expect(card).toHaveTextContent("Claude Code");
    expect(card).toHaveTextContent("host enrolled");
    const log = screen.getByTestId("first-frame-log");
    expect(log).toHaveTextContent("host enrolled · enrollment hen_01");
    expect(log).toHaveTextContent("collector reporting · last heartbeat");
    expect(log).toHaveTextContent("hooks written · the collector checked them");
    expect(log).toHaveTextContent("waiting…");
    expect(
      screen.getByTestId("first-frame-log-not-backed"),
    ).toBeInTheDocument();
    const footer = screen.getByTestId("gate-footer");
    expect(
      [...footer.querySelectorAll("a, button")].map((el) => el.textContent),
    ).toEqual(["Cancel", "Back", "Open the installer"]);
    expect(footer).toHaveTextContent(
      "There is no Done button. The frame is the completion.",
    );
    expect(screen.queryByRole("button", { name: /Done|Finish/ })).toBeNull();
    // Nothing is gold while waiting: the frame is the completion.
    expect(goldButtons()).toHaveLength(0);
  });

  it("re-reads a second after each read", () => {
    vi.useFakeTimers();
    renderStep();
    expect(router.refresh).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("before a host enrolls, says so and says how to enrol", () => {
    renderStep({ host: null });
    expect(screen.getByTestId("first-frame-waiting")).toHaveTextContent(
      "no host enrolled",
    );
    expect(screen.queryByTestId("first-frame-log-not-backed")).toBeNull();
    expect(
      screen.getByText(/Nothing has enrolled for this agent yet/),
    ).toBeInTheDocument();
  });

  it("with no agent, names the gap instead of waiting on nothing", () => {
    renderStep({ agent: null, host: null });
    expect(screen.getByTestId("wrap-no-agent")).toBeInTheDocument();
    expect(screen.queryByTestId("first-frame-waiting")).toBeNull();
  });
});

describe("RunStep once the frame is in", () => {
  it("shows the frames and only the recorded words, makes Open Oxagen the gold action, and opens Fleet after the countdown", () => {
    vi.useFakeTimers();
    renderStep({ received: RECEIVED });
    const card = screen.getByTestId("first-frame-received");
    expect(card).toHaveTextContent("connected");
    expect(
      within(card).getByRole("heading", { name: "First frame received" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("first-frame-rows")).toHaveTextContent(
      "agent_start",
    );
    expect(screen.getByTestId("first-frame-rows")).toHaveTextContent(
      "oxagen:run.start",
    );
    expect(card).toHaveTextContent("harness");
    expect(card).toHaveTextContent("replay grade: fork");
    expect(card).toHaveTextContent("chain intact");
    expect(card).toHaveTextContent(
      "The hooks answered, so this run is harness: delivered, recorded, client-attested, fail-open.",
    );
    expect(goldButtons().map((el) => el.textContent)).toEqual(["Open Oxagen"]);
    expect(screen.getByRole("link", { name: "Open Oxagen" })).toHaveAttribute(
      "href",
      FLEET,
    );
    expect(document.getElementById("regAuto")).toHaveTextContent(
      `Opening automatically in ${String(COUNTDOWN_SECONDS)}…`,
    );
    act(() => {
      vi.advanceTimersByTime(COUNTDOWN_SECONDS * 1_000);
    });
    expect(router.push).toHaveBeenCalledWith(FLEET);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("leaves off every word the run did not record", () => {
    renderStep({
      received: {
        ...RECEIVED,
        frames: null,
        tier: null,
        replayGrade: null,
        chainIntact: false,
      },
    });
    const card = screen.getByTestId("first-frame-received");
    expect(card).toHaveTextContent("The run’s frames are not readable yet.");
    expect(card).not.toHaveTextContent("chain intact");
    expect(card).not.toHaveTextContent("replay grade");
    expect(card).not.toHaveTextContent("harness");
  });

  it("names a recorded tier other than harness without the harness sentence", () => {
    renderStep({ received: { ...RECEIVED, tier: "gateway" } });
    expect(screen.getByTestId("first-frame-received")).toHaveTextContent(
      "This run recorded gateway.",
    );
  });
});

describe("RunStep when the host is silent", () => {
  it("says the collector cannot reach Oxagen, drops the gold action, and checks again", async () => {
    renderStep({ silentFor: 94 });
    const error = screen.getByTestId("first-frame-error");
    expect(
      within(error).getByRole("heading", {
        level: 2,
        name: "The collector cannot reach Oxagen",
      }),
    ).toBeInTheDocument();
    expect(error).toHaveTextContent(
      "no heartbeat from its collector has reached Oxagen for 94 seconds",
    );
    expect(error).toHaveTextContent("host enrollment hen_01");
    expect(goldButtons()).toHaveLength(0);
    expect(
      [...screen.getByTestId("gate-footer").querySelectorAll("a, button")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["Cancel", "Back"]);
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(router.refresh).toHaveBeenCalled();
    expect(error).toHaveTextContent(
      "Checked again. Still no heartbeat from the host.",
    );
  });
});
