// @vitest-environment jsdom
// Table (table.tsx): one header row, a numeric column aligned right, and a
// hidden column that names itself to assistive tech through aria-label and
// draws no text, so the phone card features/shell/card-tables.ts builds from
// the header leaves that cell unlabelled. Every test ends in an axe check.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { Table } from "./table";

function renderTable() {
  render(
    <Table
      label="Invoices"
      columns={[
        { label: "Invoice" },
        { label: "Amount", numeric: true },
        { label: "Open in Stripe", hidden: true },
      ]}
    >
      <tr>
        <td>OXA-0042</td>
        <td>$32.10</td>
        <td>
          <a href="https://invoice.stripe.com/i/x">Open ↗</a>
        </td>
      </tr>
    </Table>,
  );
}

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Table", () => {
  it("names the table and prints each visible column's label, the numeric one on the right", () => {
    renderTable();
    expect(screen.getByRole("table", { name: "Invoices" })).toBeInTheDocument();
    const invoice = screen.getByRole("columnheader", { name: "Invoice" });
    expect(invoice).toHaveTextContent("Invoice");
    expect(invoice).not.toHaveAttribute("aria-label");
    expect(invoice.className).toContain("text-left");
    expect(
      screen.getByRole("columnheader", { name: "Amount" }).className,
    ).toContain("text-right");
  });

  it("names a hidden column through aria-label and draws no text in its header", () => {
    renderTable();
    const link = screen.getByRole("columnheader", { name: "Open in Stripe" });
    expect(link).toHaveAttribute("aria-label", "Open in Stripe");
    expect(link).toHaveTextContent("");
  });
});
