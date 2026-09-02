// @vitest-environment jsdom
/**
 * key-value-list.test.tsx — render tests for KeyValueList.
 *
 * Covers: dl/dt/dd semantics, ReactNode values, dense + stacked layouts.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KeyValueList } from "./key-value-list";

afterEach(cleanup);

const items = [
  { label: "Status", value: "Active" },
  { label: "Region", value: "us-east-1" },
];

describe("KeyValueList", () => {
  it("renders semantic dt/dd pairs", () => {
    render(<KeyValueList items={items} />);
    const status = screen.getByText("Status");
    expect(status.tagName).toBe("DT");
    expect(screen.getByText("Active").tagName).toBe("DD");
    expect(status.closest("dl")).not.toBeNull();
  });

  it("accepts ReactNode values", () => {
    render(
      <KeyValueList
        items={[
          { label: "Key", value: <code data-testid="code">pk_123</code> },
        ]}
      />,
    );
    expect(screen.getByTestId("code")).toBeInTheDocument();
  });

  it("two-column grid by default", () => {
    const { container } = render(<KeyValueList items={items} />);
    expect((container.firstChild as HTMLElement).className).toContain(
      "grid-cols-[minmax(6rem,auto)_1fr]",
    );
  });

  it("dense tightens the row gap", () => {
    const { container } = render(<KeyValueList items={items} dense />);
    expect((container.firstChild as HTMLElement).className).toContain(
      "gap-y-1",
    );
  });

  it("stacked mode wraps each pair so the gap sits between pairs", () => {
    const { container } = render(<KeyValueList items={items} stacked />);
    const dl = container.firstChild as HTMLElement;
    expect(dl.className).toContain("grid-cols-1");
    expect(dl.querySelectorAll(":scope > div").length).toBe(2);
  });

  it("uses provided keys for repeatable labels", () => {
    render(
      <KeyValueList
        items={[
          { key: "a", label: "Env", value: "prod" },
          { key: "b", label: "Env", value: "dev" },
        ]}
      />,
    );
    expect(screen.getAllByText("Env")).toHaveLength(2);
  });
});
