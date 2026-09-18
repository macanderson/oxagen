// @vitest-environment jsdom
// The Entry component: one transcript entry and the two halves of the
// exchange it records (spec §14, Appendix F page 2).
//
// The rule these hold is the file's own: an empty box pretending to be
// content is the one thing entry.tsx exists to prevent. So every half either
// shows a body, or says in a real sentence why it has none — never a blank
// pane. Halves are folded `<details>`, opened here the way a reader would:
// clicking the summary, not just asserting on hidden DOM.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { NOW, transcriptBody, transcriptEntry } from "./run.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { Entry } = await import("./entry");

const PLACE = { org: "acme", ws: "core-platform", runId: "tse_7k2m9q" };

function renderEntry(
  entry: ReturnType<typeof transcriptEntry>,
  current = false,
) {
  return render(
    <IntlProvider>
      <ul>
        <Entry entry={entry} current={current} {...PLACE} />
      </ul>
    </IntlProvider>,
  );
}

afterEach(cleanup);

describe("Entry", () => {
  it("labels a tool call's two halves Called with and Returned, and both bodies read once opened", async () => {
    const user = userEvent.setup();
    renderEntry(
      transcriptEntry({
        kind: "tool_call",
        label: "create_release",
        request: transcriptBody({
          seq: "11",
          text: '{"branch":"release/3.2"}',
        }),
        response: transcriptBody({
          seq: "12",
          text: '{"ok":true,"prUrl":"https://github.com/acme/core/pull/9"}',
        }),
      }),
    );
    const [sent, returned] = screen.getAllByTestId("transcript-half");
    if (sent === undefined || returned === undefined) {
      throw new Error("a tool call draws both halves");
    }
    expect(within(sent).getByText("Called with")).toBeInTheDocument();
    expect(within(returned).getByText("Returned")).toBeInTheDocument();
    await user.click(within(sent).getByText("Called with"));
    await user.click(within(returned).getByText("Returned"));
    expect(within(sent).getByText('{"branch":"release/3.2"}')).toBeVisible();
    expect(
      within(returned).getByText(
        '{"ok":true,"prUrl":"https://github.com/acme/core/pull/9"}',
      ),
    ).toBeVisible();
  });

  it("labels a model call's outgoing half Sent, not Called with", () => {
    renderEntry(
      transcriptEntry({
        kind: "model_call",
        label: "claude-opus-5",
        request: transcriptBody({ seq: "9", text: "cut the release" }),
        response: transcriptBody({ seq: "10", text: "cutting it now" }),
      }),
    );
    const [outgoing] = screen.getAllByTestId("transcript-half");
    if (outgoing === undefined) throw new Error("a model call draws a half");
    expect(within(outgoing).getByText("Sent")).toBeInTheDocument();
    expect(screen.queryByText("Called with")).toBeNull();
  });

  it("says a digest_only half's body was not recorded, and draws no pre", () => {
    renderEntry(
      transcriptEntry({
        kind: "model_call",
        request: null,
        response: transcriptBody({
          fidelity: "digest_only",
          text: null,
          bytesRef: null,
        }),
      }),
    );
    const half = screen.getByTestId("transcript-half");
    expect(within(half).getByTestId("entry-no-body")).toHaveTextContent(
      "The recorder kept a digest and no body, so there is nothing to read here.",
    );
    expect(within(half).queryByRole("code")).toBeNull();
    expect(document.querySelector("pre")).toBeNull();
  });

  it("says a full-fidelity half with no retained text has no body, or bytes that are not text", () => {
    renderEntry(
      transcriptEntry({
        kind: "model_call",
        request: null,
        response: transcriptBody({ fidelity: "full", text: null }),
      }),
    );
    const half = screen.getByTestId("transcript-half");
    expect(within(half).getByTestId("entry-no-body")).toHaveTextContent(
      "No body was retained for this entry, or the bytes are not text.",
    );
    expect(document.querySelector("pre")).toBeNull();
  });

  it("says a truncated half was cut and links to the whole body on the Frames tab", () => {
    renderEntry(
      transcriptEntry({
        kind: "model_call",
        request: null,
        response: transcriptBody({
          seq: "42",
          text: "the first slice of a much longer answer",
          truncated: true,
        }),
      }),
    );
    const truncated = screen.getByTestId("entry-truncated");
    expect(truncated).toHaveTextContent("Cut at the length one entry carries.");
    const link = within(truncated).getByRole("link", {
      name: "Read the whole body of frame 42",
    });
    expect(link).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=frames&body=42",
    );
  });

  it("renders one line per redaction with the path and the reason", () => {
    renderEntry(
      transcriptEntry({
        kind: "model_call",
        request: null,
        response: transcriptBody({
          redactions: [
            {
              path: "$.messages[0].content",
              reason: "email address",
              originalDigest: `sha256:${"1".repeat(64)}`,
            },
            {
              path: "$.headers.authorization",
              reason: "bearer token",
              originalDigest: `sha256:${"2".repeat(64)}`,
            },
          ],
        }),
      }),
    );
    const list = screen.getByTestId("entry-redactions");
    const lines = within(list).getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent(
      "removed $.messages[0].content: email address",
    );
    expect(lines[1]).toHaveTextContent(
      "removed $.headers.authorization: bearer token",
    );
  });

  it("renders the no-halves line and no half at all when neither half was recorded (negative)", () => {
    renderEntry(
      transcriptEntry({ kind: "policy", request: null, response: null }),
    );
    expect(screen.getByTestId("entry-no-halves")).toHaveTextContent(
      "Neither half of this exchange was recorded. The frames it folds are on the Frames tab.",
    );
    expect(screen.queryByTestId("transcript-half")).toBeNull();
  });

  it("carries aria-current step on the entry at the playhead", () => {
    renderEntry(transcriptEntry({ seq: "11" }), true);
    expect(screen.getByTestId("transcript-entry")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it("carries no aria-current on an entry the playhead is not on (negative)", () => {
    renderEntry(transcriptEntry({ seq: "11" }), false);
    expect(screen.getByTestId("transcript-entry")).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("passes an axe check", async () => {
    const { container } = renderEntry(
      transcriptEntry({
        kind: "tool_call",
        at: new Date(NOW).toISOString(),
        request: transcriptBody({ seq: "11", text: "input" }),
        response: transcriptBody({ seq: "12", text: "output" }),
      }),
      true,
    );
    await expectNoAxe(container);
  });

  it("prints the running total as a figure, not only as the words beside it", () => {
    const { container } = renderEntry(
      transcriptEntry({
        cost: {
          micros: "18240",
          currency: "USD",
          basis: "gateway_observed",
        },
        cumulativeCost: {
          micros: "4131265",
          currency: "USD",
          basis: "gateway_observed",
        },
      }),
    );
    const line = screen.getByTestId("entry-cumulative");
    // `t.rich` silently drops a value passed as a function when the message
    // carries a plain `{cost}` placeholder, and the line still reads "so far"
    // without the money. Assert the figure itself.
    expect(within(line).getByTestId("money")).toHaveTextContent(/\d/);
    expect(line).toHaveTextContent("so far");
    expect(container).toBeTruthy();
  });
});
