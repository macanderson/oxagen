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
  looksLikeOpaqueId,
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

describe("looksLikeOpaqueId", () => {
  it("flags a UUID", () => {
    expect(looksLikeOpaqueId("913d6df1-4b2a-4c3d-9e1f-abcdef123456")).toBe(
      true,
    );
  });

  it("flags a ULID", () => {
    expect(looksLikeOpaqueId("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
  });

  it("flags a long separator-free alphanumeric token (nanoid-style)", () => {
    expect(looksLikeOpaqueId("a1b2c3d4e5f6g7h8i9j0")).toBe(true);
  });

  it("does not flag a human-readable slug", () => {
    expect(looksLikeOpaqueId("skills/code-review")).toBe(false);
    expect(looksLikeOpaqueId("oxagen.repo.edit")).toBe(false);
  });

  it("does not flag a short id-like token", () => {
    expect(looksLikeOpaqueId("github")).toBe(false);
  });
});

describe("CapabilityStrip — chat_ux_v2", () => {
  it("caps named chips at 3 (not 4) in v2", () => {
    const many: AgentToolRef[] = Array.from({ length: 5 }, (_, i) => ({
      type: "skill" as const,
      ref: `skills/s-${i}`,
    }));
    render(<CapabilityStrip toolRefs={many} v2 />);
    expect(screen.getByText("S 0")).toBeInTheDocument();
    expect(screen.getByText("S 1")).toBeInTheDocument();
    expect(screen.getByText("S 2")).toBeInTheDocument();
    expect(screen.queryByText("S 3")).not.toBeInTheDocument();
    expect(screen.getByText("+2 skills")).toBeInTheDocument();
  });

  it("renders the legacy bare +N overflow label when v2 is false", () => {
    const many: AgentToolRef[] = Array.from({ length: 5 }, (_, i) => ({
      type: "skill" as const,
      ref: `skills/s-${i}`,
    }));
    render(<CapabilityStrip toolRefs={many} />);
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.queryByText("+1 skills")).not.toBeInTheDocument();
  });

  it("never renders a raw id/UUID as a named chip in v2 — it folds into overflow", () => {
    const refs: AgentToolRef[] = [
      { type: "skill", ref: "skills/code-review" },
      { type: "skill", ref: "skills/write-tests" },
      { type: "mcp_server", ref: "913d6df1-4b2a-4c3d-9e1f-abcdef123456" },
    ];
    render(<CapabilityStrip toolRefs={refs} v2 />);
    expect(screen.getByText("Code Review")).toBeInTheDocument();
    expect(screen.getByText("Write Tests")).toBeInTheDocument();
    expect(screen.queryByText(/913d6df1/)).not.toBeInTheDocument();
    expect(screen.getByText("+1 skills")).toBeInTheDocument();
  });
});
