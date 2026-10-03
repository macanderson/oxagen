// @vitest-environment jsdom
// The diff view (diff-view.tsx): a file's unified hunks as numbered rows, a
// header row for each hunk, added and removed lines in their hues, and the
// one sentence a file with no hunks draws instead, which names why. Every
// test ends in an axe check.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RevisionDiff } from "@/data/contracts/changes";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { DiffView, PatchLines } from "./diff-view";

type DiffFile = RevisionDiff["files"][number];

const PATCH = [
  "@@ -10,2 +10,3 @@",
  " context",
  "-old line",
  "+new line",
  "+added line",
  "\\ No newline at end of file",
  "@@ -40,1 +41,1 @@ function tail()",
  "-return 1;",
  "+return 2;",
].join("\n");

function file(over: Partial<DiffFile> = {}): DiffFile {
  return {
    path: "src/app.ts",
    previousPath: null,
    status: "modified",
    additions: 3,
    deletions: 2,
    patch: PATCH,
    binary: false,
    truncated: false,
    ...over,
  };
}

/** Each drawn row as its kind and its three cells. */
function rows(container: HTMLElement): string[][] {
  return [...container.querySelectorAll("[data-line]")].map((row) => [
    row.getAttribute("data-line") ?? "",
    ...[...row.children].map((cell) => cell.textContent),
  ]);
}

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("PatchLines", () => {
  it("numbers each line on its side, opens each hunk with its header, and skips the no-newline marker", () => {
    const { container } = render(<PatchLines patch={PATCH} />);
    expect(rows(container)).toEqual([
      ["hunk", "", "", " @@ -10,2 +10,3 @@"],
      ["ctx", "10", "10", " context"],
      ["del", "11", "", "−old line"],
      ["add", "", "11", "+new line"],
      ["add", "", "12", "+added line"],
      ["hunk", "", "", " @@ -40,1 +41,1 @@ function tail()"],
      ["del", "40", "", "−return 1;"],
      ["add", "", "41", "+return 2;"],
    ]);
  });

  it("draws added lines in the allowed hue and removed lines in the denied hue", () => {
    const { container } = render(<PatchLines patch={PATCH} />);
    const added = container.querySelector('[data-line="add"]');
    const removed = container.querySelector('[data-line="del"]');
    expect(added?.className).toContain("bg-success/15");
    expect(removed?.className).toContain("bg-warning/15");
    expect(
      container.querySelector('[data-line="ctx"]')?.className,
    ).not.toContain("bg-");
  });
});

describe("DiffView", () => {
  it("draws a stored file's hunks with no note under them", () => {
    const { container } = render(
      <IntlProvider>
        <DiffView file={file()} diffStatus="stored" />
      </IntlProvider>,
    );
    expect(rows(container)).toHaveLength(8);
    expect(container.querySelector("[data-diff-state]")).toBeNull();
  });

  it.each([
    [
      "too_large",
      "Oxagen did not keep this diff because it was too large.",
    ],
    [
      "unreadable",
      "Oxagen could not read this diff with the workspace's GitHub or GitLab connection.",
    ],
    [
      "unconfigured",
      "Oxagen did not keep this diff because no diff storage was set up when it arrived.",
    ],
  ] as const)(
    "names why a %s revision has no hunks, and draws none (negative)",
    (status, sentence) => {
      const { container } = render(
        <IntlProvider>
          <DiffView file={file({ patch: null })} diffStatus={status} />
        </IntlProvider>,
      );
      expect(screen.getByText(sentence)).toHaveAttribute(
        "data-diff-state",
        status,
      );
      expect(rows(container)).toEqual([]);
    },
  );

  it("names a binary file instead of drawing lines", () => {
    const { container } = render(
      <IntlProvider>
        <DiffView
          file={file({ binary: true, patch: null })}
          diffStatus="stored"
        />
      </IntlProvider>,
    );
    expect(
      screen.getByText("This is a binary file, so it has no lines to show."),
    ).toBeTruthy();
    expect(rows(container)).toEqual([]);
  });

  it("says when the answer ran out of room before the file", () => {
    render(
      <IntlProvider>
        <DiffView file={file({ patch: null })} diffStatus="stored" />
      </IntlProvider>,
    );
    expect(
      screen.getByText("This file's lines did not fit in the answer."),
    ).toHaveAttribute("data-diff-state", "no_room");
  });

  it("draws the hunks that fit and says the rest was cut", () => {
    const { container } = render(
      <IntlProvider>
        <DiffView file={file({ truncated: true })} diffStatus="stored" />
      </IntlProvider>,
    );
    expect(rows(container)).toHaveLength(8);
    expect(
      screen.getByText("This file's lines stop at the size limit."),
    ).toHaveAttribute("data-diff-state", "truncated");
  });

  it("names the path a renamed file had before", () => {
    render(
      <IntlProvider>
        <DiffView
          file={file({ path: "docs/new.md", previousPath: "docs/old.md" })}
          diffStatus="stored"
        />
      </IntlProvider>,
    );
    expect(screen.getByText("Renamed from docs/old.md")).toBeTruthy();
  });
});
