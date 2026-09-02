// @vitest-environment jsdom
/**
 * property-list.test.tsx — render tests for PropertyList.
 *
 * Covers: humanized keys, typed value rendering (string, number, boolean,
 * ISO date, url, null), URL as <a> with target=_blank, omit prop, empty state.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PropertyList } from "./property-list";

afterEach(cleanup);

const baseProps = {
  title: "Bug Report",
  count: 42,
  active: true,
  createdAt: "2026-01-15T12:00:00Z",
  homepage: "https://example.com/page",
  description: null as null,
};

describe("PropertyList — typed value rendering", () => {
  it("renders humanized key for a string value", () => {
    render(<PropertyList properties={{ title: "Bug Report" }} />);
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("Bug Report")).toBeInTheDocument();
  });

  it("renders a number value formatted with locale separators", () => {
    render(<PropertyList properties={{ itemCount: 1000 }} />);
    expect(screen.getByText("Item count")).toBeInTheDocument();
    // formatPropertyValue uses Intl.NumberFormat
    expect(
      screen.getByText(new Intl.NumberFormat().format(1000)),
    ).toBeInTheDocument();
  });

  it("renders boolean true as 'Yes'", () => {
    render(<PropertyList properties={{ active: true }} />);
    expect(screen.getByText("Yes")).toBeInTheDocument();
  });

  it("renders boolean false as 'No'", () => {
    render(<PropertyList properties={{ active: false }} />);
    expect(screen.getByText("No")).toBeInTheDocument();
  });

  it("renders an ISO date as a localized string (not raw ISO)", () => {
    render(<PropertyList properties={{ createdAt: "2026-01-15T12:00:00Z" }} />);
    const raw = "2026-01-15T12:00:00Z";
    // The formatted date should not be the raw ISO string
    expect(screen.queryByText(raw)).not.toBeInTheDocument();
    // The key should be humanized
    expect(screen.getByText("Created at")).toBeInTheDocument();
  });

  it("renders a URL as an <a> with target=_blank", () => {
    render(
      <PropertyList properties={{ homepage: "https://example.com/page" }} />,
    );
    const link = screen.getByRole("link", { name: "https://example.com/page" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "https://example.com/page");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders null as an em dash", () => {
    render(<PropertyList properties={{ description: null }} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders an array value as a readable comma-joined string", () => {
    render(<PropertyList properties={{ tags: ["auth", "billing", 3] }} />);
    expect(screen.getByText("Tags")).toBeInTheDocument();
    expect(screen.getByText("auth, billing, 3")).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it("renders a nested-object value as compact JSON, not '[object Object]'", () => {
    render(
      <PropertyList properties={{ meta: { status: "open", count: 2 } }} />,
    );
    expect(screen.getByText("Meta")).toBeInTheDocument();
    expect(screen.getByText('{"status":"open","count":2}')).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it("renders an array of objects as JSON items, not '[object Object]'", () => {
    render(<PropertyList properties={{ items: [{ id: 1 }, { id: 2 }] }} />);
    expect(screen.getByText('{"id":1}, {"id":2}')).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });
});

describe("PropertyList — omit prop", () => {
  it("hides keys listed in omit", () => {
    render(
      <PropertyList
        properties={{ displayName: "Alice", priority: "high" }}
        omit={["displayName"]}
      />,
    );
    expect(screen.queryByText("Display name")).not.toBeInTheDocument();
    expect(screen.getByText("Priority")).toBeInTheDocument();
  });
});

describe("PropertyList — empty state", () => {
  it("renders 'No properties.' when the properties object is empty", () => {
    render(<PropertyList properties={{}} />);
    expect(screen.getByText("No properties.")).toBeInTheDocument();
  });

  it("renders 'No properties.' when all keys are omitted", () => {
    render(<PropertyList properties={{ name: "x" }} omit={["name"]} />);
    expect(screen.getByText("No properties.")).toBeInTheDocument();
  });
});

describe("PropertyList — multiple properties", () => {
  it("renders all key-value pairs for a mixed properties object", () => {
    render(<PropertyList properties={baseProps} />);
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("Bug Report")).toBeInTheDocument();
    expect(screen.getByText("Count")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "https://example.com/page" }),
    ).toBeInTheDocument();
  });
});
