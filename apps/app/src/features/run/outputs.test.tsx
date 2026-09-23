// @vitest-environment jsdom
// The Run page's spine (macanderson/oxagen#3609). Four rules hold it to what
// the stores recorded, because breaking any one of them is how a console
// starts overstating a run:
//
// 1. A read is a mark, never a change. It never counts as an artifact and it
//    never carries a diff stat, however many lines its row counted.
// 2. A ledger change names the locator the ledger recorded and says in words
//    that the ledger keeps no path, rather than passing `rpl_…` off as a file
//    name.
// 3. A gate sits where it stopped the run, with the held call under it.
// 4. A run that produced nothing says so.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { OutputsSpine } from "./outputs";
import { runOutputNode, runOutputs } from "./run.builders";

// `next/link` needs a router it has no reason to have here; the spine's links
// are hrefs, and the hrefs are what these tests read.
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

afterEach(cleanup);

const PLACE = { org: "acme", ws: "core-platform", runId: "tse_7k2m9q" };

function renderSpine(
  read: Parameters<typeof OutputsSpine>[0]["read"],
  view: { reads?: string; spine?: string } = {},
) {
  return render(
    <IntlProvider>
      <OutputsSpine
        read={read}
        reads={view.reads ?? null}
        spine={view.spine ?? null}
        {...PLACE}
      />
    </IntlProvider>,
  );
}

/** The nodes, in the order the spine drew them, as `kind:name`. */
function spineOrder(): string[] {
  return [
    ...screen.getByTestId("run-outputs").querySelectorAll("li[data-kind]"),
  ].map(
    (li) =>
      `${li.getAttribute("data-kind") ?? "?"}:${li.querySelector("b")?.textContent ?? ""}`,
  );
}

describe("the spine", () => {
  it("draws what the run produced in the order it produced it", async () => {
    const { container } = renderSpine(
      readOk(
        runOutputs([
          runOutputNode({ seq: "40", name: "src/cut.ts", state: "created" }),
          runOutputNode({
            seq: "62",
            kind: "commit",
            name: "9f3c1de",
            state: "pushed",
            where: "acme/release",
            note: "3 files changed",
            stat: null,
          }),
        ]),
      ),
    );
    const spine = screen.getByTestId("run-outputs");
    expect(within(spine).getByText("src/cut.ts")).toBeTruthy();
    expect(within(spine).getByText("9f3c1de")).toBeTruthy();
    expect(within(spine).getByText("created")).toBeTruthy();
    expect(within(spine).getByText("pushed")).toBeTruthy();
    // The frame chip opens the Frames tab on the frame that produced the node.
    expect(
      within(spine).getByRole("link", { name: "fr 40" }).getAttribute("href"),
    ).toBe("/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=40");
    expect(screen.getByTestId("run-outputs-tally")).toHaveTextContent(
      "2 artifacts",
    );
    await expectNoAxe(container);
  });

  it("counts a read, and never draws it as a change", () => {
    renderSpine(
      readOk(
        runOutputs([
          runOutputNode({
            seq: "12",
            kind: "read",
            name: "README.md",
            state: "read",
            note: "3 reads",
            stat: null,
          }),
          runOutputNode({ seq: "40", name: "src/cut.ts" }),
        ]),
      ),
    );
    const tally = screen.getByTestId("run-outputs-tally");
    expect(tally).toHaveTextContent("1 artifact");
    expect(tally).toHaveTextContent("1 read");
    // The read is a mark, not a node: it draws no state badge of its own.
    const mark = screen
      .getByTestId("run-outputs")
      .querySelector('li[data-kind="read"]');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toContain("README.md");
    expect(mark?.querySelector("[data-state]")).toBeNull();
  });

  it("hides the read marks on ?reads=hide, and keeps counting them", () => {
    const spine = runOutputs([
      runOutputNode({ seq: "12", kind: "read", name: "README.md", stat: null }),
      runOutputNode({ seq: "40", name: "src/cut.ts" }),
    ]);
    renderSpine(readOk(spine), { reads: "hide" });
    expect(
      screen.getByTestId("run-outputs").querySelector('li[data-kind="read"]'),
    ).toBeNull();
    // The tally is the run's, not the view's: hiding a read does not unmake it.
    expect(screen.getByTestId("run-outputs-tally")).toHaveTextContent("1 read");
    expect(
      screen.getByRole("link", { name: "Show reads" }).getAttribute("href"),
    ).toBe("/acme/core-platform/runs/tse_7k2m9q");
  });

  it("offers Hide reads only when the run read something", () => {
    renderSpine(readOk(runOutputs([runOutputNode()])));
    expect(screen.queryByRole("link", { name: "Hide reads" })).toBeNull();
    cleanup();
    renderSpine(
      readOk(
        runOutputs([
          runOutputNode({ kind: "read", name: "README.md", stat: null }),
        ]),
      ),
    );
    expect(
      screen.getByRole("link", { name: "Hide reads" }).getAttribute("href"),
    ).toBe("/acme/core-platform/runs/tse_7k2m9q?reads=hide");
  });

  it("says the ledger kept no path rather than passing a locator off as one", () => {
    renderSpine(
      readOk(
        runOutputs(
          [
            runOutputNode({
              seq: "88",
              kind: "change",
              name: "rpl_01k5rq4b9c7xtn2p",
              nameIsLocator: true,
              where: null,
              state: "written",
              note: "policy",
              stat: null,
            }),
          ],
          { source: "ledger" },
        ),
      ),
    );
    const node = screen
      .getByTestId("run-outputs")
      .querySelector('li[data-kind="change"]');
    expect(node?.textContent).toContain("rpl_01k5rq4b9c7xtn2p");
    expect(node?.textContent).toContain(
      "The ledger recorded this change without its path.",
    );
    // It is still an artifact: a run that changed a file changed a file, even
    // where the ledger cannot say which one.
    expect(screen.getByTestId("run-outputs-tally")).toHaveTextContent(
      "1 artifact",
    );
  });

  it("puts the gate where it stopped the run, with the call it held under it", async () => {
    const { container } = renderSpine(
      readOk(
        runOutputs([
          runOutputNode({ seq: "40", name: "src/cut.ts" }),
          runOutputNode({
            seq: null,
            kind: "gate",
            name: "push_to_remote",
            where: "oxagen",
            state: "awaiting",
            note: null,
            stat: null,
          }),
          runOutputNode({
            seq: null,
            kind: "would",
            name: "push_to_remote",
            where: null,
            state: "withheld",
            note: null,
            stat: null,
          }),
        ]),
      ),
    );
    expect(spineOrder()).toEqual([
      "file:src/cut.ts",
      "gate:push_to_remote",
      "would:push_to_remote",
    ]);
    expect(screen.getByTestId("run-outputs-tally")).toHaveTextContent("1 gate");
    expect(
      screen
        .getByRole("link", { name: "Review the approval" })
        .getAttribute("href"),
    ).toBe("/acme/core-platform/runs/tse_7k2m9q?tab=actions");
    // A gate the record gave no frame carries no frame chip, rather than one
    // pointing at a frame it was not recorded on.
    const gate = screen
      .getByTestId("run-outputs")
      .querySelector('li[data-kind="gate"]');
    expect(gate?.querySelector('a[href*="body="]')).toBeNull();
    await expectNoAxe(container);
  });

  it("folds a long stretch of one kind, and ?spine= opens it", () => {
    const files = ["a", "b", "c", "d", "e"].map((name, i) =>
      runOutputNode({ seq: String(40 + i), name: `src/${name}.ts` }),
    );
    renderSpine(readOk(runOutputs(files)));
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.queryByText("src/e.ts")).toBeNull();
    const more = screen.getByRole("link", { name: "3 more file writes" });
    expect(more.getAttribute("href")).toBe(
      "/acme/core-platform/runs/tse_7k2m9q?spine=0",
    );
    cleanup();
    renderSpine(readOk(runOutputs(files)), { spine: "0" });
    expect(screen.getByText("src/e.ts")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Fold these back" })).toBeTruthy();
  });

  it("says a run produced nothing rather than drawing an empty list", async () => {
    const { container } = renderSpine(readOk(runOutputs()));
    expect(screen.getByTestId("run-outputs")).toHaveTextContent(
      "Nothing recorded. This run read nothing and changed nothing.",
    );
    expect(screen.getByTestId("run-outputs-tally")).toHaveTextContent(
      "0 artifacts",
    );
    await expectNoAxe(container);
  });

  it("says the spine ends early when the read was cut", () => {
    renderSpine(readOk(runOutputs([runOutputNode()], { complete: false })));
    expect(screen.getByTestId("run-outputs")).toHaveTextContent(
      "the spine ends early",
    );
  });

  it("replaces itself with the reason when the read did not return", () => {
    renderSpine(readError("frame_store_unreachable", 502));
    expect(screen.queryByTestId("run-outputs")).toBeNull();
    expect(screen.getByText(/frame_store_unreachable/).textContent).toContain(
      "What this run produced",
    );
  });
});
