// @vitest-environment jsdom
// The delivery report as a person opens it (#2953): read when the dialog
// opens, one card per command with its status, the mode asked for and the
// mode carried as two facts (INV-10), who issued it, what a steer said, and
// the frame an applied command landed on; counted as applied, pending and
// undelivered. Each state it renders gets an axe check.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandReport } from "@/data/contracts/runs";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { readDeliveryReport } = vi.hoisted(() => ({
  readDeliveryReport: vi.fn(),
}));
vi.mock("./actions", () => ({ readDeliveryReport }));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { DeliveryReport } = await import("./delivery-report");

const RUN = "tse_7k2m9q";
type Row = CommandReport["commands"][number];

function command(over: Partial<Row> = {}): Row {
  return {
    id: "tcm_s",
    runId: RUN,
    command: "steer",
    status: "applied",
    requestedMode: "interrupt",
    deliveryMode: "next_step",
    degradedReason: "harness_tier",
    reason: null,
    issuedAt: "2026-09-15T09:14:30.000Z",
    expiresAt: null,
    sentAt: "2026-09-15T09:14:31.000Z",
    acknowledgedAt: "2026-09-15T09:14:33.000Z",
    appliedAt: "2026-09-15T09:14:33.000Z",
    appliedAtSeq: 41,
    detail: null,
    issuedBy: { id: "usr_0a", name: "Ada Park" },
    text: "Run the migration tests before you push.",
    ...over,
  };
}

const PAUSE = command({
  id: "tcm_p",
  command: "pause",
  status: "queued",
  requestedMode: null,
  deliveryMode: null,
  degradedReason: null,
  reason: "budget review",
  sentAt: null,
  acknowledgedAt: null,
  appliedAt: null,
  appliedAtSeq: null,
  issuedBy: { id: "usr_0b", name: null },
  text: null,
});
const RESUME = command({
  id: "tcm_r",
  command: "resume",
  status: "expired",
  requestedMode: null,
  deliveryMode: null,
  degradedReason: null,
  appliedAt: null,
  appliedAtSeq: null,
  issuedBy: null,
  text: null,
});

function renderReport(
  query: { runId: string } | { commandIds: string[] } = { runId: RUN },
) {
  return render(
    <IntlProvider>
      <DeliveryReport org="acme" ws="core-platform" query={query} />
    </IntlProvider>,
  );
}

async function openReport() {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("delivery-report-open"));
  return { user, dialog: await screen.findByTestId("delivery-report") };
}

beforeEach(() => {
  readDeliveryReport.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("delivery report", () => {
  it("reads the run's commands on opening and shows how far each one got, with the requested and the delivered mode apart", async () => {
    readDeliveryReport.mockResolvedValue({
      ok: true,
      value: { commands: [command(), PAUSE, RESUME] },
    });
    renderReport();
    const { dialog } = await openReport();
    await waitFor(() => {
      expect(within(dialog).getAllByTestId("report-command")).toHaveLength(3);
    });
    expect(readDeliveryReport).toHaveBeenCalledWith("acme", "core-platform", {
      runId: RUN,
    });
    expect(within(dialog).getByTestId("report-applied")).toHaveTextContent(
      "Applied1",
    );
    expect(within(dialog).getByTestId("report-pending")).toHaveTextContent(
      "Pending1",
    );
    expect(within(dialog).getByTestId("report-undelivered")).toHaveTextContent(
      "Undelivered1",
    );
    const [steer, pause, resume] = within(dialog).getAllByTestId(
      "report-command",
    );
    if (!steer || !pause || !resume) throw new Error("three rows expected");
    expect(steer).toHaveAttribute("data-status", "applied");
    expect(within(steer).getByTestId("report-requested")).toHaveTextContent(
      "Interrupt the step in flight",
    );
    expect(within(steer).getByTestId("report-delivered")).toHaveTextContent(
      "Before the next model call",
    );
    expect(steer).toHaveTextContent(
      "Nothing on the run's path can cut a call in flight.",
    );
    expect(steer).toHaveTextContent("Ada Park");
    expect(steer).toHaveTextContent(
      "“Run the migration tests before you push.”",
    );
    expect(
      within(within(steer).getByTestId("report-frame")).getByRole("link"),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=41",
    );
    // A pause carries no prompt content, and nothing has landed yet.
    expect(within(pause).getByTestId("report-requested")).toHaveTextContent(
      "none",
    );
    expect(within(pause).getByTestId("report-frame")).toHaveTextContent(
      "none yet",
    );
    expect(pause).toHaveTextContent("budget review");
    // An issuer whose record holds no name is named by id.
    expect(pause).toHaveTextContent("usr_0b");
    expect(resume).toHaveAttribute("data-status", "expired");
    expect(resume).toHaveTextContent("not recorded");
    await expectNoAxe(dialog);
  });

  it("says no command has been sent to a run that has none", async () => {
    readDeliveryReport.mockResolvedValue({
      ok: true,
      value: { commands: [] },
    });
    renderReport();
    const { dialog } = await openReport();
    await waitFor(() => {
      expect(within(dialog).getByTestId("report-empty")).toHaveTextContent(
        "No command has been sent to this run.",
      );
    });
    await expectNoAxe(dialog);
  });

  it("reads a broadcast's commands by the ids dispatch returned", async () => {
    readDeliveryReport.mockResolvedValue({
      ok: true,
      value: {
        commands: [command(), command({ id: "tcm_t", runId: "tse_other1" })],
      },
    });
    renderReport({ commandIds: ["tcm_s", "tcm_t"] });
    const { dialog } = await openReport();
    await waitFor(() => {
      expect(within(dialog).getAllByTestId("report-command")).toHaveLength(2);
    });
    expect(readDeliveryReport).toHaveBeenCalledWith("acme", "core-platform", {
      commandIds: ["tcm_s", "tcm_t"],
    });
    expect(dialog).toHaveTextContent("tse_other1");
  });

  it("names a refused read and shows no command (negative)", async () => {
    readDeliveryReport.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "run.read",
    });
    renderReport();
    const { dialog } = await openReport();
    await waitFor(() => {
      expect(within(dialog).getByTestId("report-failure")).toHaveTextContent(
        "The report could not be read: run.read. Open it again to retry.",
      );
    });
    expect(within(dialog).queryByTestId("report-command")).toBeNull();
    await expectNoAxe(dialog);
  });

  it("names a read that threw before it answered (negative)", async () => {
    readDeliveryReport.mockRejectedValue(new Error("network"));
    renderReport();
    const { dialog } = await openReport();
    await waitFor(() => {
      expect(within(dialog).getByTestId("report-failure")).toHaveTextContent(
        "The report read did not answer. Open it again to retry.",
      );
    });
  });

  it("reads the report again each time it opens", async () => {
    readDeliveryReport.mockResolvedValue({
      ok: true,
      value: { commands: [command()] },
    });
    renderReport();
    const { user, dialog } = await openReport();
    await within(dialog).findByTestId("report-command");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByTestId("delivery-report-open"));
    await waitFor(() => {
      expect(readDeliveryReport).toHaveBeenCalledTimes(2);
    });
  });
});
