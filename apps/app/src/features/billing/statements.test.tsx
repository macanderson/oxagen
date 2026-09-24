// @vitest-environment jsdom
// The Billing page's Statements section with its action faked: it checks the
// period before it calls export_billing_statement, saves the CSV pages joined
// in order and the HTML document as they came back, shows its progress while
// pages arrive, stops at MAX_PAGES and says so, renders each refusal in its
// own words, and tells a viewer without the role why there is no form. Axe
// checks the state each test ends in (INV-26).
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import billing from "../../../messages/billing.json";
import ui from "../../../messages/ui.json";

const exportBillingStatementAction = vi.fn();
vi.mock("./statement-actions", () => ({ exportBillingStatementAction }));

const { MAX_PAGES, Statements } = await import("./statements");
const { statementPeriodInput } = await import("./statement-period");

const TODAY = "2026-09-23";

function renderWithIntl(node: ReactNode) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={{ ...billing, ...ui }}
      timeZone="UTC"
    >
      {node}
    </NextIntlClientProvider>,
  );
}

/** Captures what the section hands the browser to save. */
function captureSaves() {
  const blobs: Blob[] = [];
  const createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return "blob:statement";
  });
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
  const names: string[] = [];
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
  return { blobs, names, click, revokeObjectURL };
}

const page = (content: string, nextCursor: string | null, lines = 1) => ({
  ok: true as const,
  value: {
    filename: "ST-0192F3A4-20260901-20260930.csv",
    content,
    lines,
    nextCursor,
  },
});

beforeEach(() => {
  exportBillingStatementAction.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("statementPeriodInput", () => {
  const base = {
    kind: "month" as const,
    anchor: TODAY,
    firstDay: "",
    lastDay: TODAY,
  };

  it("passes a calendar period by its day, and a custom range as a half-open UTC range", () => {
    expect(statementPeriodInput(base, TODAY)).toEqual({
      ok: true,
      input: { period: "month", anchor: TODAY },
    });
    expect(
      statementPeriodInput(
        {
          ...base,
          kind: "custom",
          firstDay: "2026-09-01",
          lastDay: "2026-09-03",
        },
        TODAY,
      ),
    ).toEqual({
      ok: true,
      input: {
        period: "custom",
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-04T00:00:00.000Z",
      },
    });
  });

  it("names the field and the rule a period breaks", () => {
    const cases: [Parameters<typeof statementPeriodInput>[0], unknown][] = [
      [
        { ...base, anchor: "2026-02-30" },
        { field: "anchor", code: "dayInvalid" },
      ],
      [
        { ...base, anchor: "2026-09-24" },
        { field: "anchor", code: "future" },
      ],
      [
        { ...base, kind: "custom", firstDay: "" },
        { field: "firstDay", code: "dayInvalid" },
      ],
      [
        {
          ...base,
          kind: "custom",
          firstDay: "2026-09-24",
          lastDay: "2026-09-30",
        },
        { field: "firstDay", code: "future" },
      ],
      [
        { ...base, kind: "custom", firstDay: "2026-09-01", lastDay: "" },
        { field: "lastDay", code: "dayInvalid" },
      ],
      [
        {
          ...base,
          kind: "custom",
          firstDay: "2026-09-01",
          lastDay: "2026-09-02",
        },
        { field: "lastDay", code: "rangeTooShort" },
      ],
      [
        {
          ...base,
          kind: "custom",
          firstDay: "2026-09-05",
          lastDay: "2026-09-01",
        },
        { field: "lastDay", code: "rangeTooShort" },
      ],
      [
        {
          ...base,
          kind: "custom",
          firstDay: "2025-01-01",
          lastDay: "2026-01-02",
        },
        { field: "lastDay", code: "rangeTooLong" },
      ],
    ];
    for (const [form, error] of cases)
      expect(statementPeriodInput(form, TODAY), JSON.stringify(form)).toEqual({
        ok: false,
        error,
      });
  });
});

describe("Statements", () => {
  it("downloads this month's CSV, joining the pages in order", async () => {
    const saves = captureSaves();
    exportBillingStatementAction
      .mockResolvedValueOnce(page("header\r\nrow1\r\n", "c1"))
      .mockResolvedValueOnce(page("row2\r\n", null));
    const { container } = renderWithIntl(
      <Statements org="acme" today={TODAY} allowed />,
    );

    expect(screen.getByRole("radio", { name: "Month" })).toBeChecked();
    expect(screen.getByLabelText("Any day in the period")).toHaveValue(TODAY);
    await userEvent.click(screen.getByRole("button", { name: "Download CSV" }));

    await waitFor(() => {
      expect(saves.click).toHaveBeenCalledOnce();
    });
    const form = { kind: "month", anchor: TODAY, firstDay: "", lastDay: TODAY };
    expect(exportBillingStatementAction).toHaveBeenNthCalledWith(
      1,
      "acme",
      form,
      TODAY,
      "csv",
      null,
    );
    expect(exportBillingStatementAction).toHaveBeenNthCalledWith(
      2,
      "acme",
      form,
      TODAY,
      "csv",
      "c1",
    );
    expect(saves.names).toEqual(["ST-0192F3A4-20260901-20260930.csv"]);
    expect(await saves.blobs[0]?.text()).toBe("header\r\nrow1\r\nrow2\r\n");
    expect(saves.blobs[0]?.type).toBe("text/csv;charset=utf-8");
    expect(saves.revokeObjectURL).toHaveBeenCalledWith("blob:statement");
    expect(screen.getByTestId("statements-progress")).toHaveTextContent(
      "Saved ST-0192F3A4-20260901-20260930.csv",
    );
    await expectNoAxe(container);
  });

  it("downloads the HTML document for a custom range", async () => {
    const saves = captureSaves();
    exportBillingStatementAction.mockResolvedValue({
      ok: true,
      value: {
        filename: "ST-X.html",
        content: "<!doctype html>",
        lines: 0,
        nextCursor: null,
      },
    });
    renderWithIntl(<Statements org="acme" today={TODAY} allowed />);

    await userEvent.click(screen.getByRole("radio", { name: "Custom" }));
    await userEvent.type(screen.getByLabelText("First day"), "2026-09-01");
    await userEvent.clear(screen.getByLabelText("Last day"));
    await userEvent.type(screen.getByLabelText("Last day"), "2026-09-09");
    await userEvent.click(
      screen.getByRole("button", { name: "Download HTML" }),
    );

    await waitFor(() => {
      expect(saves.click).toHaveBeenCalledOnce();
    });
    expect(exportBillingStatementAction).toHaveBeenCalledWith(
      "acme",
      {
        kind: "custom",
        anchor: TODAY,
        firstDay: "2026-09-01",
        lastDay: "2026-09-09",
      },
      TODAY,
      "html",
      null,
    );
    expect(saves.blobs[0]?.type).toBe("text/html;charset=utf-8");
  });

  it("refuses a custom range of two days on its field, before any call", async () => {
    const { container } = renderWithIntl(
      <Statements org="acme" today={TODAY} allowed />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "Custom" }));
    await userEvent.type(screen.getByLabelText("First day"), "2026-09-01");
    await userEvent.clear(screen.getByLabelText("Last day"));
    await userEvent.type(screen.getByLabelText("Last day"), "2026-09-02");
    await userEvent.click(screen.getByRole("button", { name: "Download CSV" }));

    expect(
      screen.getByText(
        "Pick at least three days. For two days or fewer, download the week that contains them.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Last day")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(exportBillingStatementAction).not.toHaveBeenCalled();
    await expectNoAxe(container);
  });

  it("disables both buttons and reports the rows read while pages arrive", async () => {
    captureSaves();
    let release: (v: unknown) => void = () => {};
    exportBillingStatementAction
      .mockResolvedValueOnce(page("header\r\n", "c1", 10_000))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    renderWithIntl(<Statements org="acme" today={TODAY} allowed />);
    await userEvent.click(screen.getByRole("button", { name: "Download CSV" }));

    expect(
      await screen.findByRole("button", { name: "Preparing CSV…" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Download HTML" }),
    ).toBeDisabled();
    expect(
      await screen.findByText("10000 rows read so far."),
    ).toBeInTheDocument();
    release(page("row\r\n", null));
    expect(
      await screen.findByRole("button", { name: "Download CSV" }),
    ).toBeEnabled();
  });

  it(`saves what it has after ${String(MAX_PAGES)} pages and says how to get the rest (partial)`, async () => {
    const saves = captureSaves();
    exportBillingStatementAction.mockResolvedValue(
      page("row\r\n", "more", 10_000),
    );
    const { container } = renderWithIntl(
      <Statements org="acme" today={TODAY} allowed />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "Year" }));
    await userEvent.click(screen.getByRole("button", { name: "Download CSV" }));

    expect(
      await screen.findByText(
        "Saved the first 200000 rows. The period has more. Export it whole with the oxagen billing statement command or the API.",
      ),
    ).toBeInTheDocument();
    expect(exportBillingStatementAction).toHaveBeenCalledTimes(MAX_PAGES);
    expect(saves.click).toHaveBeenCalledOnce();
    await expectNoAxe(container);
  });

  it.each([
    [
      { ok: false, reason: "denied", code: "role_required" },
      "Your role on this organization cannot download statements. Ask an Owner to assign you Owner, Admin or Billing.",
    ],
    [
      { ok: false, reason: "invalid", code: "invalid_input" },
      "Oxagen could not state that period. Check the dates and try again.",
    ],
    [
      { ok: false, reason: "unavailable", code: "contract_output_mismatch" },
      "The statement did not download. Try again in a minute. If it keeps failing, the oxagen billing statement command reads the same statement.",
    ],
  ])(
    "renders a refused export in its own words (%o)",
    async (result, message) => {
      const saves = captureSaves();
      exportBillingStatementAction.mockResolvedValue(result);
      const { container } = renderWithIntl(
        <Statements org="acme" today={TODAY} allowed />,
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Download CSV" }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(saves.click).not.toHaveBeenCalled();
      await expectNoAxe(container);
    },
  );

  it("puts a server-side field refusal on its field", async () => {
    exportBillingStatementAction.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "future",
      field: "anchor",
    });
    renderWithIntl(<Statements org="acme" today={TODAY} allowed />);
    await userEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(
      await screen.findByText("Pick today or an earlier day."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a field refusal whose code the form has no message for as a general failure", async () => {
    exportBillingStatementAction.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "anchor",
    });
    renderWithIntl(<Statements org="acme" today={TODAY} allowed />);
    await userEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Oxagen could not state that period. Check the dates and try again.",
    );
  });

  it("treats a thrown action as unavailable", async () => {
    exportBillingStatementAction.mockRejectedValue(new Error("network"));
    renderWithIntl(<Statements org="acme" today={TODAY} allowed />);
    await userEvent.click(
      screen.getByRole("button", { name: "Download HTML" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The statement did not download.",
    );
  });

  it("tells a viewer without the role why there is no form (permission denied)", async () => {
    const { container } = renderWithIntl(
      <Statements org="acme" today={TODAY} allowed={false} />,
    );
    expect(screen.getByTestId("statements-denied")).toHaveTextContent(
      "Statements need the Owner, Admin or Billing role on this organization. Ask an Owner to assign you one.",
    );
    expect(screen.queryByRole("button")).toBeNull();
    await expectNoAxe(container);
  });
});
