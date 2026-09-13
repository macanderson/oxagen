// @vitest-environment jsdom
/**
 * structured-value.test.tsx
 *
 * Covers the canonical tool-I/O renderer:
 *   (1) the pure classifiers — looksLikeId / looksLikeEnum / statusToneDot
 *   (2) rendering — humanized keys, typed values (id chip, enum pill, number,
 *       date, boolean, url, nested object, array), and the core guarantee:
 *       a typical tool payload NEVER renders as raw JSON.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  StructuredValue,
  StructuredField,
  looksLikeId,
  looksLikeEnum,
  statusToneDot,
} from "./structured-value";

// TruncatedText (free-text scalar values) measures scroll overflow via
// ResizeObserver, which isn't implemented in JSDOM.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(cleanup);

// The exact payload from the research.swarm.start card in the bug report.
const SWARM_INPUT = {
  depth: "deep",
  topic: "Captain William Anderson nuclear submarine career biography",
  maxParallel: 5,
  searchDepth: "basic",
  targetLabel: "Topic",
};
const SWARM_RESULT = {
  status: "running",
  swarmId: "fan_p48e66xt6jag15rqg0t10y",
  dispatchId: "fan_p48e66xt6jag15rqg0t10y",
  estimatedTasks: 15,
};

// ── pure classifiers ──────────────────────────────────────────────────────────

describe("looksLikeId", () => {
  it("matches UUIDs and prefixed opaque ids", () => {
    expect(looksLikeId("27de4a9d-1b01-4249-a174-563ba651aee6")).toBe(true);
    expect(looksLikeId("fan_p48e66xt6jag15rqg0t10y")).toBe(true);
    expect(looksLikeId("mcs_abc123def")).toBe(true);
  });

  it("matches a plain token when the key hint ends in Id", () => {
    expect(looksLikeId("abc123def456", "swarmId")).toBe(true);
    expect(looksLikeId("xyz789", "node_id")).toBe(true);
  });

  it("matches long opaque tokens", () => {
    expect(looksLikeId("9f8e7d6c5b4a3f2e1d0c9b8a")).toBe(true);
  });

  it("does NOT treat prose or short words as ids", () => {
    expect(looksLikeId("deep")).toBe(false);
    expect(looksLikeId("Captain William Anderson")).toBe(false);
    expect(looksLikeId("running")).toBe(false);
    expect(looksLikeId("basic", "searchDepth")).toBe(false);
  });

  it("does NOT mistake word_word status enums for prefixed ids", () => {
    // Regression: PREFIXED_ID_RE used to match these (prefix_+6 letters); a
    // prefixed id's suffix must look opaque (digits or long), unlike a word.
    expect(looksLikeId("in_progress")).toBe(false);
    expect(looksLikeId("in_review")).toBe(false);
    expect(looksLikeId("not_started")).toBe(false);
    // …but a real prefixed id (digits in the suffix) still matches.
    expect(looksLikeId("fan_p48e66xt6jag15rqg0t10y")).toBe(true);
    expect(looksLikeId("mcs_abc123def")).toBe(true);
  });
});

describe("looksLikeEnum", () => {
  it("accepts short single tokens", () => {
    expect(looksLikeEnum("deep")).toBe(true);
    expect(looksLikeEnum("basic")).toBe(true);
    expect(looksLikeEnum("running")).toBe(true);
    expect(looksLikeEnum("in_progress")).toBe(true);
    expect(looksLikeEnum("not_started")).toBe(true);
    expect(looksLikeEnum("Topic")).toBe(true);
  });

  it("rejects long strings and multi-word phrases", () => {
    expect(looksLikeEnum("Captain William Anderson nuclear submarine")).toBe(
      false,
    );
    expect(looksLikeEnum("a sentence with spaces")).toBe(false);
    expect(
      looksLikeEnum("supercalifragilisticexpialidocious_and_then_some"),
    ).toBe(false);
  });
});

describe("statusToneDot", () => {
  it("maps lifecycle words to tone classes", () => {
    expect(statusToneDot("running")).toBe("bg-info");
    expect(statusToneDot("completed")).toBe("bg-success");
    expect(statusToneDot("failed")).toBe("bg-destructive");
    expect(statusToneDot("pending")).toBe("bg-warning");
  });

  it("is case-insensitive", () => {
    expect(statusToneDot("RUNNING")).toBe("bg-info");
    expect(statusToneDot("Completed")).toBe("bg-success");
  });

  it("returns undefined for non-status enums", () => {
    expect(statusToneDot("deep")).toBeUndefined();
    expect(statusToneDot("Topic")).toBeUndefined();
  });
});

// ── rendering ─────────────────────────────────────────────────────────────────

describe("StructuredValue — object rendering", () => {
  it("renders humanized keys, not raw JSON keys", () => {
    render(<StructuredValue value={SWARM_INPUT} />);
    expect(screen.getByText("Search depth")).toBeInTheDocument();
    expect(screen.getByText("Max parallel")).toBeInTheDocument();
    expect(screen.getByText("Target label")).toBeInTheDocument();
  });

  it("renders the long string value as plain readable text", () => {
    render(<StructuredValue value={SWARM_INPUT} />);
    expect(
      screen.getByText(
        "Captain William Anderson nuclear submarine career biography",
      ),
    ).toBeInTheDocument();
  });

  it("NEVER emits raw JSON for a typical payload", () => {
    const { container } = render(<StructuredValue value={SWARM_RESULT} />);
    const text = container.textContent ?? "";
    // No object braces, no quoted JSON keys, no raw camelCase keys.
    expect(text).not.toContain("{");
    expect(text).not.toContain('"status"');
    expect(text).not.toContain("swarmId");
    expect(text).not.toContain("dispatchId");
  });
});

describe("StructuredValue — typed scalars", () => {
  it("renders an id value as a copy-to-clipboard chip", () => {
    render(<StructuredValue value={SWARM_RESULT} />);
    // CopyableId truncates the visible text but the button's accessible name
    // carries the full id.
    expect(
      screen.getAllByRole("button", { name: /fan_p48e66xt6jag15rqg0t10y/ })
        .length,
    ).toBeGreaterThan(0);
  });

  it("renders a status enum as a pill with its label", () => {
    render(<StructuredValue value={SWARM_RESULT} />);
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("formats numbers with grouping and renders booleans as Yes/No", () => {
    render(
      <StructuredValue
        value={{ count: 12345, enabled: true, archived: false }}
      />,
    );
    expect(
      screen.getByText(new Intl.NumberFormat().format(12345)),
    ).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
  });

  it("renders null as an em dash", () => {
    render(<StructuredValue value={{ missing: null }} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders a word_word status as a pill, NOT an id copy chip", () => {
    render(<StructuredValue value={{ phase: "in_progress" }} />);
    expect(screen.getByText("in_progress")).toBeInTheDocument();
    // A misclassified id would render a CopyableId button.
    expect(
      screen.queryByRole("button", { name: /in_progress/i }),
    ).not.toBeInTheDocument();
  });

  it("renders an ISO date as a localized value, not the raw ISO string", () => {
    render(<StructuredValue value={{ createdAt: "2024-01-15T12:00:00Z" }} />);
    const cell = screen.getByText(/2024/);
    // Localized output drops the ISO 'T' separator.
    expect(cell.textContent ?? "").not.toContain("T12:00");
  });

  it("renders a url as a link", () => {
    render(<StructuredValue value={{ docs: "https://example.com/guide" }} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://example.com/guide");
  });
});

describe("StructuredValue — nested + arrays", () => {
  it("recurses into nested objects with humanized keys", () => {
    render(<StructuredValue value={{ outer: { innerField: "v" } }} />);
    expect(screen.getByText("Outer")).toBeInTheDocument();
    expect(screen.getByText("Inner field")).toBeInTheDocument();
  });

  it("renders a scalar array as chips, not JSON", () => {
    const { container } = render(
      <StructuredValue value={{ tags: ["alpha", "beta", "gamma"] }} />,
    );
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("gamma")).toBeInTheDocument();
    expect(container.textContent ?? "").not.toContain("[");
  });

  it("renders an array of objects as numbered records, never [object Object] or JSON", () => {
    const { container } = render(
      <StructuredValue
        value={{
          rows: [
            { name: "a", score: 1 },
            { name: "b", score: 2 },
          ],
        }}
      />,
    );
    // Each object renders as its own humanized record.
    expect(screen.getAllByText("Name")).toHaveLength(2);
    expect(screen.getAllByText("Score")).toHaveLength(2);
    const text = container.textContent ?? "";
    expect(text).not.toContain("[object Object]");
    expect(text).not.toContain("{");
  });

  it("renders an empty array and empty object as readable hints", () => {
    render(<StructuredValue value={{ items: [], meta: {} }} />);
    expect(screen.getByText("Empty")).toBeInTheDocument();
    expect(screen.getByText("No fields")).toBeInTheDocument();
  });
});

describe("StructuredField", () => {
  it("renders the label, value tree, and a copy affordance", () => {
    render(<StructuredField label="Result" value={SWARM_RESULT} />);
    expect(screen.getByText("Result")).toBeInTheDocument();
    expect(screen.getByText("Estimated tasks")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /copy value as json/i }),
    ).toBeInTheDocument();
  });

  it("omits the copy affordance for nullish values", () => {
    render(<StructuredField label="Input" value={null} />);
    expect(
      screen.queryByRole("button", { name: /copy value as json/i }),
    ).not.toBeInTheDocument();
  });
});
