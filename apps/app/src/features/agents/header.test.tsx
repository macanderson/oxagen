// @vitest-environment jsdom
// The agent page's header drawn on its own (header.tsx), for the states the
// page test in agent.test.tsx does not reach: a newest run made on behalf of
// someone other than the agent's operator, an identity with no operator or
// description, a run with no replay grade, a retired identity, which keeps
// Clone and loses every write that would act on it, and the built-in
// assistant, which keeps only its kill switch. Axe runs after every test
// (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  retireAgent: vi.fn(),
  rotateAgentCredential: vi.fn(),
  setAgentSuspended: vi.fn(),
  pauseAgent: vi.fn(),
}));

const { AgentHeader, operatorNameOf } = await import("./header");

type Props = ComponentProps<typeof AgentHeader>;

function renderHeader(overrides: Partial<Props> = {}) {
  const props: Props = {
    identity: agentDetail().identity,
    lastRun: runRow(),
    orgRole: "owner",
    org: "acme",
    ws: "core-platform",
    ...overrides,
  };
  render(
    <IntlProvider>
      <AgentHeader {...props} />
    </IntlProvider>,
  );
}

const badges = () => screen.getByTestId("agent-badges");
const actions = () =>
  within(screen.getByTestId("agent-header-actions"))
    .getAllByRole("button")
    .map((b) => b.textContent);

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("operatorNameOf", () => {
  const { identity } = agentDetail();

  it("names the operator from a run made on their behalf", () => {
    expect(operatorNameOf(identity, runRow())).toBe("Marcus Bell");
  });

  it("names nobody from a run made on behalf of someone else, or with no run or no operator (negative)", () => {
    expect(
      operatorNameOf(
        identity,
        runRow({ operatorId: "usr_priya", operatorName: "Priya N" }),
      ),
    ).toBeNull();
    expect(operatorNameOf(identity, null)).toBeNull();
    expect(
      operatorNameOf({ ...identity, operatorId: null }, runRow()),
    ).toBeNull();
  });
});

describe("AgentHeader", () => {
  it("says the operator is not recorded when the newest run names someone else (negative)", () => {
    renderHeader({
      lastRun: runRow({ operatorId: "usr_priya", operatorName: "Priya N" }),
    });
    expect(badges()).toHaveTextContent("operator not recorded");
    expect(badges()).not.toHaveTextContent("Priya N");
  });

  it("carries an empty operator key, no replay grade and no description when none is recorded (negative)", () => {
    renderHeader({
      identity: agentDetail({
        identity: { operatorId: null, description: null },
      }).identity,
      lastRun: runRow({ replayGrade: null }),
    });
    expect(badges().querySelector("[data-operator]")).toHaveAttribute(
      "data-operator",
      "",
    );
    expect(badges()).toHaveTextContent("replay not recorded");
    expect(
      screen.queryByText("Cuts releases and opens their pull requests."),
    ).toBeNull();
  });

  it("names the run the tier badge was recorded on", () => {
    renderHeader();
    expect(
      screen.getByTitle("Recorded on run arun_7k2m9q"),
    ).toBeInTheDocument();
  });

  it("offers a retired identity Clone and nothing that acts on it (negative)", () => {
    renderHeader({
      identity: agentDetail({ identity: { status: "retired" } }).identity,
    });
    const labels = actions();
    expect(labels).toContain("Edit avatar");
    expect(labels).not.toContain("Suspend");
    expect(labels).not.toContain("Deregister");
    expect(labels).not.toContain("Rotate credential");
    expect(badges().querySelector("[data-status]")).toHaveAttribute(
      "data-status",
      "retired",
    );
  });

  // #4350: stella acts as the built-in assistant, and deregistering it from
  // this header stopped stella in the workspace. The kill switch stays.
  it("offers the built-in assistant no identity write, only its kill switch (negative)", () => {
    renderHeader({
      identity: agentDetail({ identity: { managed: true, slug: "qa-chat" } })
        .identity,
    });
    const labels = actions();
    expect(labels).not.toContain("Suspend");
    expect(labels).not.toContain("Deregister");
    expect(labels).not.toContain("Rotate credential");
    expect(labels).toContain("Kill switch");
    expect(badges().querySelector("[data-managed]")).toHaveTextContent(
      "managed by Oxagen",
    );
  });

  it("offers a suspended identity the way back", () => {
    renderHeader({
      identity: agentDetail({ identity: { status: "suspended" } }).identity,
    });
    expect(actions()).not.toContain("Suspend");
    expect(actions().some((l) => /resume|reinstate/i.test(l))).toBe(true);
  });
});
