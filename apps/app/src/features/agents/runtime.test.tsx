// @vitest-environment jsdom
// The Runtime tab drawn on its own (runtime.tsx), for the states the page
// test in agent.test.tsx does not reach: hooks in place, removed and not
// reported; a collector that reported its version and was seen; the proxy
// on each side of the gateway rung; no run, so no tier; every host revoked;
// and a retired identity, which is offered neither enroll nor unenroll.
// Axe runs after every test (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDetail } from "@/data/contracts/agents";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { agentDetail, runRow } from "./agents.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  revokeHostEnrollment: vi.fn(),
  issueAgentEnrollmentToken: vi.fn(),
}));

const { RuntimeSection } = await import("./runtime");

type Props = ComponentProps<typeof RuntimeSection>;
type Host = AgentDetail["hosts"][number];

const [BASE_HOST] = agentDetail().hosts as [Host];
const host = (overrides: Partial<Host> = {}): Host => ({
  ...BASE_HOST,
  ...overrides,
});

function renderRuntime(overrides: Partial<Props> = {}) {
  const props: Props = {
    detail: agentDetail(),
    lastRun: runRow(),
    org: "acme",
    ws: "core-platform",
    here: routes.agent("acme", "core-platform", "release-bot", {
      tab: "runtime",
    }),
    ...overrides,
  };
  render(
    <IntlProvider>
      <RuntimeSection {...props} />
    </IntlProvider>,
  );
}

const hostPanel = () => screen.getByTestId("host-panel");
const hooksCell = () => {
  const cell = hostPanel().querySelector("[data-hooks]");
  if (cell === null) throw new Error("no hooks cell");
  return cell;
};

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("Runtime › host", () => {
  it.each([
    [true, "ok", "in place"],
    [false, "missing", "removed"],
    [null, "unreported", "not reported"],
  ] as const)("reads hooksOk %s as %s", (hooksOk, key, words) => {
    renderRuntime({ detail: agentDetail({ hosts: [host({ hooksOk })] }) });
    expect(hooksCell()).toHaveAttribute("data-hooks", key);
    expect(hooksCell()).toHaveTextContent(words);
  });

  it("prints the collector version, when it was last seen and the bundle it was served", () => {
    renderRuntime({
      detail: agentDetail({
        hosts: [
          host({
            collectorVersion: "0.14.2",
            lastSeenAt: "2026-09-15T09:30:00.000Z",
            bundleVersionServed: 1204,
          }),
        ],
      }),
    });
    const panel = hostPanel();
    expect(panel).toHaveTextContent("Collector0.14.2last seen");
    expect(panel).not.toHaveTextContent("never seen");
    expect(panel).toHaveTextContent("Policy bundleversion 1,204");
  });

  it("says the collector was never seen and its version and bundle are not recorded (negative)", () => {
    renderRuntime();
    const panel = hostPanel();
    expect(panel).toHaveTextContent("Collectornot recordednever seen");
    expect(panel).toHaveTextContent("Policy bundlenot recorded");
  });

  it("routes the model proxy on the gateway rung and above", () => {
    renderRuntime({ lastRun: runRow({ enforcementTier: "gateway" }) });
    expect(hostPanel()).toHaveTextContent(
      "Model proxyloopback proxy on the host",
    );
  });

  it("does not route the model proxy below the gateway rung (negative)", () => {
    renderRuntime({ lastRun: runRow({ enforcementTier: "harness" }) });
    expect(hostPanel()).toHaveTextContent("Model proxynot routed");
  });

  it("marks no rung and answers nothing when no run recorded a tier (negative)", () => {
    renderRuntime({
      lastRun: null,
      detail: agentDetail({ identity: { firstFrameAt: null } }),
    });
    const panel = hostPanel();
    expect(panel).toHaveTextContent("Model proxynot recorded");
    expect(panel).toHaveTextContent("Tier earnednot recorded");
    expect(panel).toHaveTextContent("First frameno frame yet");
    const ladder = screen.getByRole("list", {
      name: "Enforcement tiers, weakest first",
    });
    expect(
      within(ladder)
        .getAllByRole("listitem")
        .filter((li) => li.getAttribute("aria-current") === "step"),
    ).toEqual([]);
    const tier = screen.getByRole("region", {
      name: "What this tier delivers",
    });
    expect(tier).toHaveTextContent(
      "No run of this agent is on the newest page of runs, so no tier is recorded for it.",
    );
    expect(tier).toHaveTextContent("Model callsnot recorded");
  });

  it("answers each tier row for the rung the newest run recorded", () => {
    renderRuntime({ lastRun: runRow({ enforcementTier: "contained" }) });
    const tier = screen.getByRole("region", {
      name: "What this tier delivers",
    });
    expect(tier).toHaveTextContent(
      "Model callsrouted through the loopback proxy on the host.",
    );
  });
});

describe("Runtime › revoked and retired", () => {
  it("draws the empty state above each revoked host, which says when it was revoked (negative)", () => {
    renderRuntime({
      detail: agentDetail({
        hosts: [host({ revokedAt: "2026-09-10T10:00:00.000Z" })],
      }),
    });
    expect(screen.getByTestId("runtime-empty")).toHaveTextContent(
      "No runtime is enrolled for this agent",
    );
    const panel = hostPanel();
    expect(panel).toHaveTextContent("Enrollment expiresrevoked");
    // A revoked host is not offered for unenroll: there is no Rollback panel.
    expect(screen.queryByTestId("unenroll-command")).toBeNull();
  });

  it("offers a retired identity neither Wrap it nor the enroll path (negative)", () => {
    renderRuntime({
      detail: agentDetail({ identity: { status: "retired" }, hosts: [] }),
    });
    const empty = screen.getByTestId("runtime-empty");
    expect(within(empty).queryByRole("link", { name: "Wrap it" })).toBeNull();
    expect(
      within(empty).queryByRole("button", { name: "Show the CLI path" }),
    ).toBeNull();
  });

  it("offers a retired identity with a live host no unenroll (negative)", () => {
    renderRuntime({ detail: agentDetail({ identity: { status: "retired" } }) });
    expect(screen.getByTestId("unenroll-command")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Unenroll build-01" }),
    ).toBeNull();
  });
});
