// @vitest-environment jsdom
/**
 * table.test.tsx — render tests for the shared Table primitive set.
 *
 * Covers: scroll container, density vars, header bar tokens, sticky header,
 * interactive rows, empty row colSpan.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableEmpty,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

afterEach(cleanup);

function renderTable(tableProps: React.ComponentProps<typeof Table> = {}) {
  return render(
    <Table {...tableProps}>
      <TableCaption>Monthly usage</TableCaption>
      <TableHeader data-testid="thead">
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow data-testid="row">
          <TableCell>ontology.query</TableCell>
          <TableCell className="text-right">$1.20</TableCell>
        </TableRow>
      </TableBody>
      <TableFooter data-testid="tfoot">
        <TableRow>
          <TableCell>Total</TableCell>
          <TableCell className="text-right">$1.20</TableCell>
        </TableRow>
      </TableFooter>
    </Table>,
  );
}

describe("Table", () => {
  it("wraps the table in an overflow-x-auto container for mobile scroll", () => {
    renderTable();
    const table = screen.getByRole("table");
    expect(table.parentElement?.className).toContain("overflow-x-auto");
  });

  it("applies the default density padding vars", () => {
    renderTable();
    expect(screen.getByRole("table").className).toContain(
      "[--table-pad-y:0.625rem]",
    );
  });

  it("compact density tightens the vertical padding var", () => {
    renderTable({ density: "compact" });
    expect(screen.getByRole("table").className).toContain(
      "[--table-pad-y:0.375rem]",
    );
  });

  it("merges containerClassName onto the scroll wrapper", () => {
    renderTable({ containerClassName: "rounded-xl" });
    const table = screen.getByRole("table");
    expect(table.parentElement?.className).toContain("rounded-xl");
  });

  it("header uses the card-header token bar", () => {
    renderTable();
    expect(screen.getByTestId("thead").className).toContain(
      "bg-card-header-bg",
    );
  });

  it("head cells are uppercase header ink", () => {
    renderTable();
    const th = screen.getByText("Name");
    expect(th.tagName).toBe("TH");
    expect(th.className).toContain("uppercase");
  });

  it("cells read the density padding vars", () => {
    renderTable();
    const td = screen.getByText("ontology.query");
    expect(td.className).toContain("px-[var(--table-pad-x)]");
    expect(td.className).toContain("py-[var(--table-pad-y)]");
  });

  it("rows get a hover treatment and can opt into pointer affordance", () => {
    render(
      <Table>
        <TableBody>
          <TableRow data-testid="interactive-row" interactive>
            <TableCell>Row</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const row = screen.getByTestId("interactive-row");
    expect(row.className).toContain("hover:bg-muted/50");
    expect(row.className).toContain("cursor-pointer");
  });

  it("sticky header opts into sticky positioning", () => {
    render(
      <Table>
        <TableHeader sticky data-testid="sticky-head">
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    expect(screen.getByTestId("sticky-head").className).toContain("sticky");
  });

  it("footer renders inside tfoot", () => {
    renderTable();
    expect(screen.getByTestId("tfoot").tagName).toBe("TFOOT");
  });

  it("TableEmpty spans the given columns with a default message", () => {
    render(
      <Table>
        <TableBody>
          <TableEmpty colSpan={3} />
        </TableBody>
      </Table>,
    );
    const cell = screen.getByText("No results.");
    expect(cell.getAttribute("colspan")).toBe("3");
  });

  it("TableEmpty renders custom children", () => {
    render(
      <Table>
        <TableBody>
          <TableEmpty colSpan={2}>No usage yet</TableEmpty>
        </TableBody>
      </Table>,
    );
    expect(screen.getByText("No usage yet")).toBeInTheDocument();
  });

  it("caption renders as muted helper text", () => {
    renderTable();
    expect(screen.getByText("Monthly usage").tagName).toBe("CAPTION");
  });
});
