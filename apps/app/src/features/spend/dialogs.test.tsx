// @vitest-environment jsdom
// The Spend page's two dialogs with their actions faked: Set a budget checks
// the form before it calls set_spend_budget, lands a saved ceiling on the
// Budgets tab and shows what the server refused; Export report saves the
// month's CSV and shows a refusal. Axe checks the state each test ends in,
// the open dialog's portal included (INV-26).
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantDraftOf } from "@/shared/assistant-draft";
import { createRequestOf } from "@/shared/create";
import { expectNoAxe } from "@/test/expect-no-axe";
import spend from "../../../messages/spend.json";
import ui from "../../../messages/ui.json";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const setBudgetAction = vi.fn();
const exportStatementAction = vi.fn();
const exportCostCenterStatementAction = vi.fn();
const recordFindingFixAction = vi.fn();
const dismissFindingAction = vi.fn();
vi.mock("./actions", () => ({
  setBudgetAction,
  exportStatementAction,
  exportCostCenterStatementAction,
  recordFindingFixAction,
  dismissFindingAction,
}));

const { BudgetDialog } = await import("./budget-dialog");
const { ExportDialog } = await import("./export-dialog");
const { FixDialog } = await import("./fix-dialog");

const at = { org: "acme", ws: "core-platform" };

function renderWithIntl(node: ReactNode) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={{ ...spend, ...ui }}
      timeZone="UTC"
    >
      {node}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
  setBudgetAction.mockReset();
  exportStatementAction.mockReset();
  exportCostCenterStatementAction.mockReset();
  recordFindingFixAction.mockReset();
  dismissFindingAction.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

describe("Set a budget", () => {
  async function openDialog() {
    renderWithIntl(<BudgetDialog at={at} />);
    await userEvent.click(screen.getByRole("button", { name: "Set a budget" }));
    return screen.getByRole("dialog", { name: "Set a budget" });
  }

  it("refuses a limit that is not an amount above zero before calling the action (negative)", async () => {
    await openDialog();
    await userEvent.type(screen.getByLabelText("Limit (USD)"), "-5");
    await userEvent.click(screen.getByRole("button", { name: "Set it" }));
    expect(
      screen.getByText(
        "Enter an amount above zero, with at most six decimal places.",
      ),
    ).toBeInTheDocument();
    expect(setBudgetAction).not.toHaveBeenCalled();
  });

  it("asks for the window's days on a rolling period (negative)", async () => {
    await openDialog();
    await userEvent.selectOptions(
      screen.getByLabelText("Period"),
      "Rolling window",
    );
    await userEvent.type(screen.getByLabelText("Limit (USD)"), "50");
    await userEvent.click(screen.getByRole("button", { name: "Set it" }));
    expect(
      screen.getByText("Enter a whole number of days above zero."),
    ).toBeInTheDocument();
    expect(setBudgetAction).not.toHaveBeenCalled();
  });

  it("sends the form and lands a saved ceiling on the Budgets tab", async () => {
    setBudgetAction.mockResolvedValue({ ok: true, value: null });
    await openDialog();
    await userEvent.selectOptions(
      screen.getByLabelText("Scope"),
      "Organization",
    );
    await userEvent.type(screen.getByLabelText("Limit (USD)"), "500.25");
    await userEvent.click(screen.getByRole("button", { name: "Set it" }));

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(
        "/acme/core-platform/spend?tab=budgets",
      );
    });
    expect(setBudgetAction).toHaveBeenCalledWith(at, {
      scope: "org",
      period: "monthly",
      windowDays: "",
      limit: "500.25",
      enabled: true,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the denied alert when the handler refuses the role, and a field the contract refused (negative)", async () => {
    setBudgetAction.mockResolvedValueOnce({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    await openDialog();
    await userEvent.type(screen.getByLabelText("Limit (USD)"), "10");
    await userEvent.click(screen.getByRole("button", { name: "Set it" }));
    expect(
      await screen.findByText(/Your role cannot set this ceiling/),
    ).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();

    setBudgetAction.mockResolvedValueOnce({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "limit.micros",
    });
    await userEvent.click(screen.getByRole("button", { name: "Set it" }));
    expect(
      await screen.findByText(
        "Enter an amount above zero, with at most six decimal places.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Your role cannot set this ceiling/)).toBeNull();
  });
});

describe("Export report", () => {
  async function openDialog() {
    renderWithIntl(<ExportDialog at={at} month="2026-09" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Export report" }),
    );
    return screen.getByRole("dialog", { name: "Export a spend report" });
  }

  it("saves the month's statement as the CSV the call answered", async () => {
    const createObjectURL = vi.fn(() => "blob:statement");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const saved: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        saved.push(this.download);
      });
    exportStatementAction.mockResolvedValue({
      ok: true,
      value: { filename: "spend-2026-08.csv", content: "level,key\n" },
    });

    await openDialog();
    expect(screen.getByLabelText("Month")).toHaveValue("2026-09");
    await userEvent.clear(screen.getByLabelText("Month"));
    await userEvent.type(screen.getByLabelText("Month"), "2026-08");
    await userEvent.click(
      screen.getByRole("button", { name: "Download the CSV" }),
    );

    await waitFor(() => {
      expect(click).toHaveBeenCalledOnce();
    });
    expect(exportStatementAction).toHaveBeenCalledWith(at, "2026-08");
    expect(saved).toEqual(["spend-2026-08.csv"]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:statement");
    expect(screen.queryByRole("dialog")).toBeNull();
    click.mockRestore();
  });

  it("refuses a value that is not a month, and renders a refused export (negative)", async () => {
    await openDialog();
    await userEvent.clear(screen.getByLabelText("Month"));
    await userEvent.type(screen.getByLabelText("Month"), "September");
    await userEvent.click(
      screen.getByRole("button", { name: "Download the CSV" }),
    );
    expect(screen.getByText("Enter a month as YYYY-MM.")).toBeInTheDocument();
    expect(exportStatementAction).not.toHaveBeenCalled();

    exportStatementAction.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    await userEvent.clear(screen.getByLabelText("Month"));
    await userEvent.type(screen.getByLabelText("Month"), "2026-09");
    await userEvent.click(
      screen.getByRole("button", { name: "Download the CSV" }),
    );
    expect(
      await screen.findByText(
        "Your roles on this organization do not let you export this workspace’s spend.",
      ),
    ).toBeInTheDocument();
  });
});

describe("Export the chargeback statement", () => {
  it("saves the organization's statement by cost center when that is picked", async () => {
    const createObjectURL = vi.fn(() => "blob:chargeback");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const saved: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        saved.push(this.download);
      });
    exportCostCenterStatementAction.mockResolvedValue({
      ok: true,
      value: {
        filename: "cost-center-statement-2026-09.csv",
        content: "line,cost_center\n",
      },
    });
    renderWithIntl(<ExportDialog at={at} month="2026-09" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Export report" }),
    );
    await userEvent.click(
      screen.getByRole("radio", { name: /Organization by cost center/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Download the CSV" }),
    );
    await waitFor(() => {
      expect(click).toHaveBeenCalledOnce();
    });
    expect(exportCostCenterStatementAction).toHaveBeenCalledWith(at, "2026-09");
    expect(exportStatementAction).not.toHaveBeenCalled();
    expect(saved).toEqual(["cost-center-statement-2026-09.csv"]);
    click.mockRestore();
  });

  it("says who may export it when the organization refuses (negative)", async () => {
    exportCostCenterStatementAction.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    renderWithIntl(<ExportDialog at={at} month="2026-09" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Export report" }),
    );
    await userEvent.click(
      screen.getByRole("radio", { name: /Organization by cost center/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Download the CSV" }),
    );
    expect(
      await screen.findByText(
        "Only an organization Owner, Admin or Billing member can export the chargeback statement.",
      ),
    ).toBeInTheDocument();
  });
});

describe("Fix a finding", () => {
  async function openDialog() {
    renderWithIntl(
      <FixDialog
        at={at}
        findingId="fnd_01k5rtgh"
        fix="Request grouped totals; page line items only on drill-down."
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Review fix" }));
    return screen.getByRole("dialog", {
      name: "Review the recommended change",
    });
  }

  it("bounds a long finding handoff to the downstream rationale limit", async () => {
    const events: Event[] = [];
    const listener = (event: Event) => {
      events.push(event);
    };
    window.addEventListener("oxagen:create", listener);
    try {
      const description =
        "Finding fnd_1. " + "Review repeated tool calls. ".repeat(80);
      renderWithIntl(
        <FixDialog
          at={at}
          findingId="fnd_1"
          fix="Batch repeated reads."
          contextDescription={description}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Review fix" }));
      await userEvent.click(
        screen.getByRole("button", { name: "Draft a context PR" }),
      );
      const event = events[0];
      const request = event === undefined ? null : createRequestOf(event);
      expect(request?.prefill?.description).toBe(description.slice(0, 1000));
      expect(request?.prefill?.description).toHaveLength(1000);
      expect(recordFindingFixAction).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("oxagen:create", listener);
    }
  });

  it("opens a prefilled context draft without claiming a fix or writing a PR", async () => {
    const listener = vi.fn((event: Event) => createRequestOf(event));
    window.addEventListener("oxagen:create", listener);
    try {
      await openDialog();
      expect(
        screen.getByText(/Implementation cost is not estimated/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Plan a code PR with Stella" }),
      ).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", { name: "Draft a context PR" }),
      );
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.results[0]?.value).toEqual({
        kind: "record",
        prefill: {
          description:
            "Request grouped totals; page line items only on drill-down.",
        },
      });
      expect(recordFindingFixAction).not.toHaveBeenCalled();
      expect(dismissFindingAction).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("oxagen:create", listener);
    }
  });

  it("offers a scoped code PR request for review without recording a fix", async () => {
    const events: Event[] = [];
    const listener = vi.fn((event: Event) => {
      events.push(event);
    });
    window.addEventListener("oxagen:assistant-draft", listener);
    try {
      await openDialog();
      await userEvent.click(
        screen.getByRole("button", { name: "Plan a code PR with Stella" }),
      );
      expect(listener).toHaveBeenCalledOnce();
      const event = events[0];
      const draft = event === undefined ? null : assistantDraftOf(event);
      expect(draft?.org).toBe(at.org);
      expect(draft?.ws).toBe(at.ws);
      expect(draft?.content).toContain("Do not mark the finding fixed.");
      expect(draft?.content).toContain("Request grouped totals");
      expect(recordFindingFixAction).not.toHaveBeenCalled();
      expect(dismissFindingAction).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("oxagen:assistant-draft", listener);
    }
  });

  it("shows the fix the finding names and records the change, returning to the findings tab", async () => {
    recordFindingFixAction.mockResolvedValue({ ok: true, value: null });
    await openDialog();
    expect(
      screen.getByText(
        "Request grouped totals; page line items only on drill-down.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Record the fix as applied" }),
    );

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(
        "/acme/core-platform/spend?tab=findings",
      );
    });
    expect(recordFindingFixAction).toHaveBeenCalledWith(at, "fnd_01k5rtgh");
    expect(dismissFindingAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dismisses the finding without recording a fix", async () => {
    dismissFindingAction.mockResolvedValue({ ok: true, value: null });
    await openDialog();
    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss this finding" }),
    );

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(
        "/acme/core-platform/spend?tab=findings",
      );
    });
    expect(dismissFindingAction).toHaveBeenCalledWith(at, "fnd_01k5rtgh");
    expect(recordFindingFixAction).not.toHaveBeenCalled();
  });

  it("names a role refusal, a finding already decided and a decision waiting for approval, changing nothing (negative)", async () => {
    recordFindingFixAction.mockResolvedValueOnce({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    await openDialog();
    await userEvent.click(
      screen.getByRole("button", { name: "Record the fix as applied" }),
    );
    expect(
      await screen.findByText(/Your organization role cannot decide a finding/),
    ).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();

    recordFindingFixAction.mockResolvedValueOnce({
      ok: false,
      reason: "conflict",
      code: "finding_not_open",
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Record the fix as applied" }),
    );
    expect(
      await screen.findByText(
        "This finding was already decided. Nothing was changed.",
      ),
    ).toBeInTheDocument();

    recordFindingFixAction.mockResolvedValueOnce({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "acr_01k5",
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Record the fix as applied" }),
    );
    expect(
      await screen.findByText(
        "The decision is waiting for approval, request acr_01k5.",
      ),
    ).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names a write that threw before it answered (negative)", async () => {
    dismissFindingAction.mockRejectedValue(new Error("offline"));
    await openDialog();
    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss this finding" }),
    );
    expect(
      await screen.findByText(
        "The decision could not be recorded: action_failed. Nothing was changed.",
      ),
    ).toBeInTheDocument();
  });
});
