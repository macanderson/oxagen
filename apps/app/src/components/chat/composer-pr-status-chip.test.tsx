// @vitest-environment jsdom
/**
 * composer-pr-status-chip.test.tsx
 *
 * Covers:
 *   - deriveComposerPr: picks the latest completed edit_repo_file / open_pr,
 *     ignores pending/failed/non-PR calls, reads owner/repo from input and the
 *     head ref from output (edit) or input (open_pr), returns null when none.
 *   - ComposerPrStatusChip: renders "PR #123" linking to the PR, fetches CI from
 *     the scoped endpoint, and reflects the aggregated verdict on the status dot.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

afterEach(cleanup);

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// Popover shim: render trigger + popup inline so we can assert both without
// Base UI portals / hover machinery.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({
    render: renderEl,
    children,
  }: {
    render: React.ReactElement;
    children: React.ReactNode;
  }) => (
    <>
      {renderEl}
      <div>{children}</div>
    </>
  ),
  PopoverPopup: ({ children, ...rest }: { children: React.ReactNode }) => (
    <div {...rest}>{children}</div>
  ),
}));

// CiStatusSummary shim — assert it's fed the fetched CI shape.
vi.mock("./registry-components/ci-status-summary", () => ({
  CiStatusSummary: ({
    overall,
    counts,
  }: {
    overall: string;
    counts: { total: number };
  }) => (
    <div
      data-testid="ci-summary"
      data-overall={overall}
      data-total={counts.total}
    />
  ),
}));

import {
  deriveComposerPr,
  ComposerPrStatusChip,
  type PrDerivationToolCall,
} from "./composer-pr-status-chip";

function tc(over: Partial<PrDerivationToolCall>): PrDerivationToolCall {
  return {
    capability: "edit_repo_file",
    status: "completed",
    inputPreview: { owner: "acme", repo: "widgets" },
    output: {
      prNumber: 42,
      prUrl: "https://github.com/acme/widgets/pull/42",
      branch: "feat/x",
    },
    ...over,
  };
}

describe("deriveComposerPr", () => {
  it("returns null when there are no tool calls", () => {
    expect(deriveComposerPr([])).toBeNull();
  });

  it("reads a completed edit_repo_file PR (owner/repo from input, headRef from output branch)", () => {
    const pr = deriveComposerPr([tc({})]);
    expect(pr).toEqual({
      owner: "acme",
      name: "widgets",
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      headRef: "feat/x",
    });
  });

  it("reads a completed open_pr (number/htmlUrl from output, headRef from input head)", () => {
    const pr = deriveComposerPr([
      tc({
        capability: "open_pr",
        inputPreview: { owner: "acme", repo: "api", head: "feature/y" },
        output: { number: 7, htmlUrl: "https://github.com/acme/api/pull/7" },
      }),
    ]);
    expect(pr).toEqual({
      owner: "acme",
      name: "api",
      number: 7,
      url: "https://github.com/acme/api/pull/7",
      headRef: "feature/y",
    });
  });

  it("ignores pending/failed calls and non-PR capabilities", () => {
    expect(
      deriveComposerPr([
        tc({ status: "running" }),
        tc({ capability: "read_file", output: { contents: "x" } }),
      ]),
    ).toBeNull();
  });

  it("returns the LAST PR when several were opened", () => {
    const pr = deriveComposerPr([
      tc({ output: { prNumber: 1, prUrl: "u1", branch: "b1" } }),
      tc({ output: { prNumber: 2, prUrl: "u2", branch: "b2" } }),
    ]);
    expect(pr?.number).toBe(2);
    expect(pr?.headRef).toBe("b2");
  });

  it("skips a call missing owner/repo in its input", () => {
    expect(
      deriveComposerPr([tc({ inputPreview: { repo: "widgets" } })]),
    ).toBeNull();
  });
});

const PR = {
  owner: "acme",
  name: "widgets",
  number: 42,
  url: "https://github.com/acme/widgets/pull/42",
  headRef: "feat/x",
};

describe("ComposerPrStatusChip", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the PR link with number and href", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    render(
      <ComposerPrStatusChip pr={PR} orgSlug="acme" workspaceSlug="main" />,
    );
    const link = screen.getByTestId("composer-pr-link");
    expect(link).toHaveTextContent("PR #42");
    expect(link).toHaveAttribute("href", PR.url);
  });

  it("fetches CI from the scoped endpoint and reflects the verdict on the dot", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        overall: "passing",
        counts: {
          total: 3,
          passed: 3,
          failed: 0,
          pending: 0,
          skipped: 0,
          neutral: 0,
        },
        runs: [
          {
            name: "build",
            status: "completed",
            conclusion: "success",
            url: null,
            startedAt: null,
            completedAt: null,
            durationMs: 1200,
            app: "GitHub Actions",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ComposerPrStatusChip pr={PR} orgSlug="acme" workspaceSlug="main" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("composer-ci-dot")).toHaveAttribute(
        "data-overall",
        "passing",
      );
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "/api/v1/acme/main/repos/ci/status?owner=acme&repo=widgets&ref=feat%2Fx",
    );
    expect(screen.getByTestId("ci-summary")).toHaveAttribute("data-total", "3");
  });

  it("does not fetch when the PR has no head ref", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ComposerPrStatusChip
        pr={{ ...PR, headRef: null }}
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("composer-ci-dot")).toHaveAttribute(
      "data-overall",
      "unknown",
    );
  });
});
