// @vitest-environment jsdom
// The reported-token panel under a transcript turn: it sums each token class
// over the frames that reported usage, says "Not recorded" for a class no
// frame reported rather than printing a zero, and says usage was not
// recorded at all when no frame carried any.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { transcriptEntry } from "./run.builders";
import { TokenUsage } from "./token-usage";

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function renderUsage(entries: Parameters<typeof TokenUsage>[0]["entries"]) {
  render(
    <IntlProvider>
      <TokenUsage entries={entries} />
    </IntlProvider>,
  );
  return screen.getByTestId("reported-token-usage");
}

/** The figure printed against one class label. */
function figure(panel: HTMLElement, label: string): string | null {
  const term = within(panel).getByText(label, { selector: "dt" });
  return term.nextElementSibling?.textContent ?? null;
}

describe("TokenUsage", () => {
  it("sums each class over the frames that reported it and marks a class nobody reported", () => {
    const panel = renderUsage([
      transcriptEntry({
        seq: "1",
        usage: {
          inputUncached: 1200,
          cacheRead: null,
          cacheWrite: 40,
          output: 300,
          reasoning: null,
        },
      }),
      transcriptEntry({ seq: "2", usage: null }),
      transcriptEntry({ seq: "3" }),
      transcriptEntry({
        seq: "4",
        usage: {
          inputUncached: 34,
          cacheRead: 9000,
          cacheWrite: null,
          output: 12,
          reasoning: null,
        },
      }),
    ]);
    expect(figure(panel, "Uncached input")).toBe("1,234");
    expect(figure(panel, "Cache read")).toBe("9,000");
    expect(figure(panel, "Cache write")).toBe("40");
    expect(figure(panel, "Output")).toBe("312");
    expect(figure(panel, "Reasoning (within output)")).toBe("Not recorded");
    expect(
      within(panel).queryByText(
        "Token usage was not recorded for these frames.",
      ),
    ).toBeNull();
    expect(within(panel).getByText(/Counts cover loaded frames/)).toBeTruthy();
  });

  it("prints a reported zero as a zero, not as missing", () => {
    const panel = renderUsage([
      transcriptEntry({
        usage: {
          inputUncached: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          reasoning: 0,
        },
      }),
    ]);
    expect(figure(panel, "Output")).toBe("0");
    expect(within(panel).queryByText("Not recorded")).toBeNull();
  });

  it("says usage was not recorded when no frame carried any, and prints no figure (negative)", () => {
    const panel = renderUsage([
      transcriptEntry({ seq: "1", usage: null }),
      transcriptEntry({ seq: "2" }),
    ]);
    expect(
      within(panel).getByText("Token usage was not recorded for these frames."),
    ).toBeTruthy();
    expect(panel.querySelector("dl")).toBeNull();
  });

  it("says usage was not recorded for a turn with no frames (negative)", () => {
    const panel = renderUsage([]);
    expect(
      within(panel).getByText("Token usage was not recorded for these frames."),
    ).toBeTruthy();
  });
});
