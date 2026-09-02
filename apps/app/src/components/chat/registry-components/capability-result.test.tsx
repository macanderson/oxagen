// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import CapabilityResult, {
  humanizeKey,
  humanizeCapability,
  isHttpUrl,
} from "./capability-result";

// TruncatedText (long free-text scalar values) measures scroll overflow via
// ResizeObserver, which isn't implemented in JSDOM.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

afterEach(cleanup);

describe("capability-result helpers", () => {
  it("humanizeCapability turns a snake_case name into a sentence", () => {
    expect(humanizeCapability("get_node")).toBe("Get node");
    expect(humanizeCapability("")).toBe("Result");
  });
  it("humanizeKey splits camelCase + underscores", () => {
    expect(humanizeKey("displayName")).toBe("Display name");
    expect(humanizeKey("node_id")).toBe("Node id");
  });
  it("isHttpUrl detects http(s) urls only", () => {
    expect(isHttpUrl("https://x.com")).toBe(true);
    expect(isHttpUrl("/internal/path")).toBe(false);
  });
});

describe("CapabilityResult render", () => {
  it("renders a typed key/value card with a deep-link chip and no raw JSON", () => {
    render(
      <CapabilityResult
        capability="some.capability"
        title="My Result"
        output={{
          displayName: "Reactor",
          count: 1200,
          active: true,
          homepage: "https://example.com/page",
          tags: ["a", "b"],
          meta: { nested: 1 },
        }}
        links={[
          {
            field: "id",
            recordType: "graph.node",
            id: "n1",
            href: "/acme/ws/knowledge/graph/n1",
            label: "Open node",
          },
        ]}
      />,
    );
    expect(screen.getByText("My Result")).toBeTruthy();
    // humanized keys
    expect(screen.getByText("Display name")).toBeTruthy();
    expect(screen.getByText("Reactor")).toBeTruthy();
    // number is locale-formatted
    expect(screen.getByText("1,200")).toBeTruthy();
    // boolean → Yes
    expect(screen.getByText("Yes")).toBeTruthy();
    // deep-link chip present with the resolved href
    const chip = screen.getByText("Open node").closest("a");
    expect(chip?.getAttribute("href")).toBe("/acme/ws/knowledge/graph/n1");
    // external url rendered as a link (full url shown, truncated at 80 chars)
    const ext = screen.getByText("https://example.com/page").closest("a");
    expect(ext?.getAttribute("target")).toBe("_blank");
  });

  it("renders a scalar output directly", () => {
    render(<CapabilityResult capability="x.y" output={"just a string"} />);
    expect(screen.getByText("just a string")).toBeTruthy();
  });

  it("renders an empty state for null output", () => {
    render(<CapabilityResult capability="x.y" output={null} />);
    expect(screen.getByText("No result.")).toBeTruthy();
  });
});
