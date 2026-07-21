// @vitest-environment jsdom
/**
 * tool-call-card-json-result.test.tsx
 *
 * Graph query capabilities (search_graph et al) render their Result as the
 * plain clipped JSON snippet — NOT the structured chip/grid tree, which turns
 * node/edge documents into an unreadable wall. Every other capability keeps
 * the structured Result field.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ToolCallCard } from "./tool-call-card";

afterEach(cleanup);

vi.mock("./registry-components/diff-syntax", () => ({
  highlightLine: vi.fn(async (line: string) => [{ content: line }]),
}));

const output = { nodes: [{ id: "n1", label: "Person", displayName: "Ada" }] };

function renderCard(capability: string) {
  return render(
    <ToolCallCard
      toolCallId="t1"
      capability={capability}
      inputPreview={{ query: "ada" }}
      riskLevel="low"
      status="completed"
      output={output}
      defaultOpen
    />,
  );
}

describe("ToolCallCard result rendering", () => {
  it.each(["search_graph", "query_ontology"])(
    "renders %s output as a clipped JSON snippet",
    (cap) => {
      renderCard(cap);
      const snippet = document.querySelector("[data-component='json-snippet']");
      expect(snippet).not.toBeNull();
      expect(snippet!.querySelector("pre")?.textContent).toContain(
        '"displayName": "Ada"',
      );
      // Exactly one structured field remains — the (small) Input.
      expect(
        document.querySelectorAll("[data-testid='structured-field']").length,
      ).toBe(1);
    },
  );

  it("keeps the structured Result tree for non-graph capabilities", () => {
    renderCard("send_message");
    expect(
      document.querySelector("[data-component='json-snippet']"),
    ).toBeNull();
    // Input + Result both structured.
    expect(
      document.querySelectorAll("[data-testid='structured-field']").length,
    ).toBe(2);
  });
});
