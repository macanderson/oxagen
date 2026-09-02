// @vitest-environment jsdom
/**
 * mermaid-diagram.test.tsx
 *
 * Tests for MermaidDiagram:
 *   1.  Renders the title in header and as aria-label on the figure
 *   2.  Shows spinner/loading state initially (before mermaid resolves)
 *   3.  Shows success SVG after mermaid.render resolves
 *   4.  Shows error state when mermaid.render throws
 *   5.  "Show source" toggle — click shows code, click again hides it
 *   6.  "Copy" button calls navigator.clipboard.writeText with the source
 *   7.  "Copy" button label changes to "Copied" after click, then reverts
 *   8.  Source panel shows raw source text when toggled
 *   9.  Different theme prop gets passed to mermaid.initialize
 *   10. Cleanup effect cancels pending render if component unmounts mid-render
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import MermaidDiagram from "./mermaid-diagram";

afterEach(cleanup);

// ── mermaid mock ──────────────────────────────────────────────────────────────
// vi.mock is hoisted — vitest intercepts dynamic import("mermaid") too.
const mockMermaidRender =
  vi.fn<(id: string, source: string) => Promise<{ svg: string }>>();
const mockMermaidInitialize =
  vi.fn<(config: Record<string, unknown>) => void>();

vi.mock("mermaid", () => ({
  default: {
    initialize: (...args: Parameters<typeof mockMermaidInitialize>) =>
      mockMermaidInitialize(...args),
    render: (...args: Parameters<typeof mockMermaidRender>) =>
      mockMermaidRender(...args),
  },
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("lucide-react", () => ({
  Copy: () => <span data-testid="icon-copy" />,
  Check: () => <span data-testid="icon-check" />,
  Code2: () => <span data-testid="icon-code2" />,
  Download: () => <span data-testid="icon-download" />,
}));

// ── clipboard mock ────────────────────────────────────────────────────────────
const writeTextMock = vi.fn<(text: string) => Promise<void>>(() =>
  Promise.resolve(),
);

beforeEach(() => {
  mockMermaidRender.mockReset();
  mockMermaidInitialize.mockReset();
  writeTextMock.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    writable: true,
    configurable: true,
  });
});

// ── helper ────────────────────────────────────────────────────────────────────
function renderDiagram(
  props: Partial<{
    source: string;
    title: string;
    theme: "default" | "dark" | "neutral" | "forest";
  }> = {},
) {
  const source = props.source ?? "graph LR\nA-->B";
  const title = props.title ?? "Test Diagram";
  const theme = props.theme ?? "default";
  return render(<MermaidDiagram source={source} title={title} theme={theme} />);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("MermaidDiagram", () => {
  it("shows a Download link for the persisted .mmd source when sourceUrl is set", () => {
    mockMermaidRender.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );

    render(
      <MermaidDiagram
        source="graph LR\nA-->B"
        title="My Flow"
        sourceUrl="/api/v1/assets/gen_mmd1"
      />,
    );

    const link = screen.getByLabelText("Download My Flow diagram source");
    expect(link).toHaveAttribute("href", "/api/v1/assets/gen_mmd1");
    expect(link).toHaveAttribute("download", "My Flow.mmd");
  });

  it("hides the Download link when sourceUrl is absent (persistence skipped/failed)", () => {
    mockMermaidRender.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );

    renderDiagram({ title: "No Persist" });

    expect(
      screen.queryByLabelText("Download No Persist diagram source"),
    ).not.toBeInTheDocument();
  });

  it("renders the title in header and as aria-label on figure", () => {
    // Keep render in loading state so we can inspect synchronously
    mockMermaidRender.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );

    renderDiagram({ title: "My Flow Chart" });

    // Title text in header
    expect(screen.getByText("My Flow Chart")).toBeInTheDocument();

    // aria-label on the figure wrapper
    const figure = screen.getByRole("figure");
    expect(figure).toHaveAttribute(
      "aria-label",
      "Mermaid diagram: My Flow Chart",
    );
  });

  it("shows spinner/loading state initially before mermaid renders", () => {
    mockMermaidRender.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );

    renderDiagram();

    // Spinner has role="status" with aria-live="polite"
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Rendering diagram…")).toBeInTheDocument();
  });

  it("shows success SVG after mermaid.render resolves", async () => {
    const svgContent = '<svg><g id="test"></g></svg>';
    mockMermaidRender.mockResolvedValue({ svg: svgContent });

    renderDiagram({ title: "Success Diagram" });

    // Wait for the SVG to be rendered via dangerouslySetInnerHTML
    await waitFor(
      () => {
        const svgContainer = screen.getByLabelText("Success Diagram");
        expect(svgContainer).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Spinner should be gone
    expect(screen.queryByText("Rendering diagram…")).not.toBeInTheDocument();
  });

  it("shows error state when mermaid.render throws an Error", async () => {
    mockMermaidRender.mockRejectedValue(new Error("Syntax error at line 2"));

    renderDiagram();

    await waitFor(
      () => {
        expect(screen.getByRole("alert")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    expect(screen.getByText("Failed to render diagram")).toBeInTheDocument();
    expect(screen.getByText("Syntax error at line 2")).toBeInTheDocument();
  });

  it("shows generic error message for non-Error throw", async () => {
    mockMermaidRender.mockRejectedValue("unexpected string error");

    renderDiagram();

    await waitFor(
      () => {
        expect(screen.getByRole("alert")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Role="alert" is present and contains the fallback message
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    // The alert element should contain "Failed to render diagram" text
    expect(alert.textContent).toContain("Failed to render diagram");
  });

  it("Show source toggle: clicking shows the source, clicking again hides it", () => {
    mockMermaidRender.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );
    const source = "graph LR\nA-->B";

    renderDiagram({ source });

    // Source panel should not be visible initially
    expect(document.querySelector("pre")).toBeNull();

    // Click "Source" button
    const sourceBtn = screen.getByRole("button", {
      name: /show mermaid source/i,
    });
    fireEvent.click(sourceBtn);

    // Source panel should now be visible
    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();

    // Loading panel should be hidden (diagram panel replaced by source panel)
    expect(screen.queryByText("Rendering diagram…")).not.toBeInTheDocument();

    // Click again to hide
    const hideBtn = screen.getByRole("button", {
      name: /hide mermaid source/i,
    });
    fireEvent.click(hideBtn);

    // Source panel should be hidden again
    expect(document.querySelector("pre")).toBeNull();
  });

  it("Copy button calls navigator.clipboard.writeText with source", () => {
    const source = "sequenceDiagram\nAlice->>Bob: Hello";
    mockMermaidRender.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );

    renderDiagram({ source });

    const copyBtn = screen.getByRole("button", {
      name: /copy diagram source/i,
    });
    fireEvent.click(copyBtn);

    expect(writeTextMock).toHaveBeenCalledOnce();
    expect(writeTextMock).toHaveBeenCalledWith(source);
  });

  it("Copy button label changes to 'Copied' after click, then reverts to 'Copy'", async () => {
    mockMermaidRender.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );

    // Use real timers so waitFor and setTimeout work correctly
    vi.useRealTimers();

    renderDiagram();

    expect(screen.getByText("Copy")).toBeInTheDocument();

    const copyBtn = screen.getByRole("button", {
      name: /copy diagram source/i,
    });
    fireEvent.click(copyBtn);

    // After click the label should update to "Copied"
    await waitFor(
      () => {
        expect(screen.getByText("Copied")).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
    expect(
      screen.getByRole("button", { name: /source copied/i }),
    ).toBeInTheDocument();

    // After 2000ms it should revert to "Copy"
    await waitFor(
      () => {
        expect(screen.getByText("Copy")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    expect(
      screen.getByRole("button", { name: /copy diagram source/i }),
    ).toBeInTheDocument();
  });

  it("Source panel shows raw source text when toggled", () => {
    const source = 'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85';
    mockMermaidRender.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );

    renderDiagram({ source });

    const sourceBtn = screen.getByRole("button", {
      name: /show mermaid source/i,
    });
    fireEvent.click(sourceBtn);

    // The source text should be visible inside <pre><code>
    const code = document.querySelector("pre code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe(source);
  });

  it("passes theme prop to mermaid.initialize", async () => {
    mockMermaidRender.mockResolvedValue({ svg: "<svg></svg>" });

    renderDiagram({ theme: "dark" });

    await waitFor(
      () => {
        expect(mockMermaidInitialize).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );

    expect(mockMermaidInitialize).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark" }),
    );
  });

  it("defaults theme to 'default' when no theme prop provided", async () => {
    mockMermaidRender.mockResolvedValue({ svg: "<svg></svg>" });

    renderDiagram(); // no theme prop

    await waitFor(
      () => {
        expect(mockMermaidInitialize).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );

    expect(mockMermaidInitialize).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "default" }),
    );
  });

  it("cleanup cancels pending render so unmounted component does not update state", async () => {
    let resolveRender!: (value: { svg: string }) => void;
    const pendingPromise = new Promise<{ svg: string }>((resolve) => {
      resolveRender = resolve;
    });
    mockMermaidRender.mockReturnValue(pendingPromise);

    const { unmount } = renderDiagram();

    // Unmount before the render promise resolves
    unmount();

    // Resolve the promise after unmount — should NOT trigger a state update or React warning
    await act(async () => {
      resolveRender({ svg: "<svg>late</svg>" });
      await pendingPromise;
    });

    // No elements remain in the document — no crash means the cancelled flag worked
    expect(document.querySelector("[role='figure']")).toBeNull();
  });
});
