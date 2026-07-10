// @vitest-environment jsdom
/**
 * capability-strip.test.tsx — the tool/skill summary logic + render.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  CapabilityStrip,
  summarizeToolRefs,
  prettifyRef,
} from "./capability-strip";
import type { AgentToolRef } from "./agent-picker-types";

afterEach(cleanup);

const REFS: AgentToolRef[] = [
  { type: "skill", ref: "skills/code-review" },
  { type: "skill", ref: "skills/write-tests" },
  { type: "mcp_server", ref: "github" },
  { type: "function", ref: "oxagen.repo.edit" },
];

describe("prettifyRef", () => {
  it("drops the namespace and title-cases the tail", () => {
    expect(prettifyRef("skills/code-review")).toBe("Code Review");
    expect(prettifyRef("oxagen.repo.edit")).toBe("Edit");
    expect(prettifyRef("write_tests")).toBe("Write Tests");
  });

  it("splits camelCase refs", () => {
    expect(prettifyRef("runSandboxCommand")).toBe("Run Sandbox Command");
  });
});

describe("summarizeToolRefs", () => {
  it("groups counts in display order with a readable label", () => {
    const s = summarizeToolRefs(REFS);
    expect(s.total).toBe(4);
    expect(s.label).toBe("2 skills · 1 MCP · 1 tool");
    expect(s.counts.map((c) => c.kind)).toEqual([
      "skill",
      "mcp_server",
      "function",
    ]);
  });

  it("is empty for no refs", () => {
    expect(summarizeToolRefs([]).label).toBe("");
  });
});

describe("CapabilityStrip", () => {
  it("renders nothing when there are no tools", () => {
    const { container } = render(<CapabilityStrip toolRefs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the count summary and named chips", () => {
    render(<CapabilityStrip toolRefs={REFS} />);
    expect(screen.getByText("2 skills · 1 MCP · 1 tool")).toBeInTheDocument();
    expect(screen.getByText("Code Review")).toBeInTheDocument();
  });

  it("collapses overflow beyond four named chips into a +N chip", () => {
    const many: AgentToolRef[] = Array.from({ length: 7 }, (_, i) => ({
      type: "skill" as const,
      ref: `skills/s-${i}`,
    }));
    render(<CapabilityStrip toolRefs={many} />);
    expect(screen.getByText("+3")).toBeInTheDocument();
  });
});
