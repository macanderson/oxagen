// @vitest-environment jsdom
/**
 * pr-stats-card.test.tsx
 *
 * Covers:
 *   - relativeTime helper across buckets
 *   - header state labels (open/draft/merged/closed)
 *   - number, title link, author, stat row (branches, +/-, files, commits)
 *   - comment count summary, expansion, review-comment path, truncation notice
 *   - "No comments" empty state
 *   - embedded CI checks section (+ empty checks message)
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import PrStatsCard, {
  relativeTime,
  type PrStatsCardProps,
} from "./pr-stats-card";

afterEach(cleanup);

function props(overrides: Partial<PrStatsCardProps> = {}): PrStatsCardProps {
  return {
    number: 42,
    title: "Add repo CI cards",
    url: "https://github.com/acme/repo/pull/42",
    state: "open",
    draft: false,
    author: "octocat",
    authorAvatarUrl: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    body: "PR body",
    baseRef: "main",
    headRef: "feat/cards",
    headSha: "deadbeef",
    additions: 120,
    deletions: 8,
    changedFiles: 5,
    commits: 3,
    commentCount: 2,
    reviewCommentCount: 1,
    comments: [
      {
        id: "c1",
        author: "octocat",
        authorAvatarUrl: null,
        body: "Looks good",
        createdAt: new Date().toISOString(),
        url: null,
        kind: "issue",
        path: null,
      },
      {
        id: "c2",
        author: "hubot",
        authorAvatarUrl: null,
        body: "nit here",
        createdAt: new Date().toISOString(),
        url: null,
        kind: "review",
        path: "src/index.ts",
      },
    ],
    ci: {
      overall: "passing",
      counts: {
        total: 1,
        passed: 1,
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
          durationMs: null,
          app: null,
        },
      ],
    },
    ...overrides,
  };
}

describe("relativeTime", () => {
  const now = Date.parse("2026-07-06T12:00:00.000Z");

  it("returns 'just now' for very recent times", () => {
    expect(relativeTime("2026-07-06T11:59:40.000Z", now)).toBe("just now");
  });

  it("formats minutes, hours, and days", () => {
    expect(relativeTime("2026-07-06T11:30:00.000Z", now)).toBe("30m ago");
    expect(relativeTime("2026-07-06T09:00:00.000Z", now)).toBe("3h ago");
    expect(relativeTime("2026-07-04T12:00:00.000Z", now)).toBe("2d ago");
    expect(relativeTime("2026-06-28T12:00:00.000Z", now)).toBe("1w ago");
  });

  it("passes through an unparseable value", () => {
    expect(relativeTime("not-a-date", now)).toBe("not-a-date");
  });
});

describe("PrStatsCard header", () => {
  it("renders the number and title linking to the PR url", () => {
    render(<PrStatsCard {...props()} />);
    expect(screen.getByText("#42")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Add repo CI cards/ });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/repo/pull/42",
    );
  });

  it("renders a success-toned Open label for an open non-draft PR", () => {
    render(<PrStatsCard {...props({ state: "open", draft: false })} />);
    expect(screen.getByText("Open").className).toContain("text-success");
  });

  it("renders a muted Draft label for a draft PR", () => {
    render(<PrStatsCard {...props({ state: "open", draft: true })} />);
    expect(screen.getByText("Draft").className).toContain(
      "text-muted-foreground",
    );
  });

  it("renders a Merged label for a merged PR", () => {
    render(<PrStatsCard {...props({ state: "merged" })} />);
    expect(screen.getByText("Merged").className).toContain("text-foreground");
  });

  it("renders a destructive-toned Closed label for a closed PR", () => {
    render(<PrStatsCard {...props({ state: "closed" })} />);
    expect(screen.getByText("Closed").className).toContain("text-destructive");
  });
});

describe("PrStatsCard stat row", () => {
  it("renders base/head branches and change counts", () => {
    render(<PrStatsCard {...props()} />);
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("feat/cards")).toBeInTheDocument();
    expect(screen.getByText("+120")).toBeInTheDocument();
    expect(screen.getByText("−8")).toBeInTheDocument();
    expect(screen.getByText("5 files")).toBeInTheDocument();
    expect(screen.getByText("3 commits")).toBeInTheDocument();
  });

  it("singularizes single file/commit labels", () => {
    render(<PrStatsCard {...props({ changedFiles: 1, commits: 1 })} />);
    expect(screen.getByText("1 file")).toBeInTheDocument();
    expect(screen.getByText("1 commit")).toBeInTheDocument();
  });
});

describe("PrStatsCard comments", () => {
  it("shows the total comment count (issue + review)", () => {
    render(
      <PrStatsCard {...props({ commentCount: 2, reviewCommentCount: 1 })} />,
    );
    expect(screen.getByText("3 comments")).toBeInTheDocument();
  });

  it("expands to show comment bodies, authors, and a review path", () => {
    render(<PrStatsCard {...props()} />);
    expect(screen.getByText("Looks good")).toBeInTheDocument();
    expect(screen.getByText("nit here")).toBeInTheDocument();
    expect(screen.getByText("hubot")).toBeInTheDocument();
    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText("issue")).toBeInTheDocument();
  });

  it("shows a 'latest N of M' notice when comments are truncated", () => {
    render(
      <PrStatsCard {...props({ commentCount: 40, reviewCommentCount: 12 })} />,
    );
    // total 52, only 2 fetched
    expect(screen.getByText(/Showing latest 2 of 52/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "view all on GitHub" }),
    ).toHaveAttribute("href", "https://github.com/acme/repo/pull/42");
  });

  it("shows 'No comments' with no disclosure when there are none", () => {
    render(
      <PrStatsCard
        {...props({ commentCount: 0, reviewCommentCount: 0, comments: [] })}
      />,
    );
    expect(screen.getByText("No comments")).toBeInTheDocument();
    // No expandable "N comments" disclosure summary should render.
    expect(screen.queryByText(/^\d+ comments?$/)).not.toBeInTheDocument();
  });
});

describe("PrStatsCard CI section", () => {
  it("renders the embedded CI summary under a Checks label", () => {
    render(<PrStatsCard {...props()} />);
    expect(screen.getByText("Checks")).toBeInTheDocument();
    expect(screen.getByText("Passing")).toBeInTheDocument();
    expect(screen.getByText("build")).toBeInTheDocument();
  });

  it("shows an empty checks message when there are no CI runs", () => {
    render(
      <PrStatsCard
        {...props({
          ci: {
            overall: "unknown",
            counts: {
              total: 0,
              passed: 0,
              failed: 0,
              pending: 0,
              skipped: 0,
              neutral: 0,
            },
            runs: [],
          },
        })}
      />,
    );
    expect(
      screen.getByText("No CI checks reported for this PR."),
    ).toBeInTheDocument();
  });
});

describe("PrStatsCard author avatar", () => {
  it("renders an avatar image when a url is present", () => {
    const { container } = render(
      <PrStatsCard
        {...props({ authorAvatarUrl: "https://avatars.example.com/u/1.png" })}
      />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://avatars.example.com/u/1.png");
  });

  it("falls back to an initial tile when no avatar url", () => {
    const { container } = render(
      <PrStatsCard {...props({ author: "octocat" })} />,
    );
    // Header meta-row author chip carries the title attr for the initial tile.
    const meta = within(container).getAllByTitle("octocat");
    expect(meta.length).toBeGreaterThan(0);
  });
});
