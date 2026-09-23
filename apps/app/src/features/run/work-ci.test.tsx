// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { RunWork } from "@/data/contracts/run-work";
import { readError, readOk } from "@/data/read";
import { IntlProvider } from "@/test/intl";
import { RunWorkSection } from "./work-ci";
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode; href: string }) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
afterEach(cleanup);
const repo = {
  host: "github.com",
  owner: "acme",
  name: "app",
  url: "https://github.com/acme/app",
  connected: true,
};
const value: RunWork = {
  runId: "tse_example",
  machine: { name: "MacBook" },
  checkouts: [
    {
      ref: "one",
      path: "/work/app",
      branch: "fix/work",
      headSha: "abc",
      remoteDigest: null,
      repository: repo,
      firstSeq: "1",
      lastSeq: "9",
    },
  ],
  diffs: [
    {
      checkoutRef: "one",
      seq: "9",
      baseSha: null,
      headSha: "abc",
      digest: "sha256:record",
      bodyAvailable: false,
      completeness: "not_retained",
      limitations: [],
      observedAt: "2026-09-23",
    },
  ],
  pullRequests: [
    {
      repository: repo,
      number: 42,
      url: `${repo.url}/pull/42`,
      title: "Repair",
      state: "open",
      headSha: "abc",
      headRef: "fix/work",
      association: "branch",
      checkoutRefs: ["one"],
      observedAt: "2026-09-23",
      current: true,
      diff: null,
      ci: {
        overall: "failing",
        complete: false,
        counts: {
          total: 1,
          passed: 0,
          failed: 1,
          pending: 0,
          skipped: 0,
          neutral: 0,
        },
        runs: [
          {
            name: "Build",
            status: "completed",
            conclusion: "failure",
            url: `${repo.url}/actions/runs/1`,
            startedAt: null,
            completedAt: null,
            durationMs: null,
            app: "Actions",
          },
        ],
      },
    },
  ],
  complete: false,
  warnings: ["ci_check_limit"],
};
it("puts failed CI beside actionable checkout and PR evidence without claiming authorship", () => {
  render(
    <IntlProvider>
      <RunWorkSection
        read={readOk(value)}
        org="acme"
        ws="app"
        runId={value.runId}
      />
    </IntlProvider>,
  );
  expect(
    screen.getByRole("heading", { name: "1 failing check" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Build" })).toHaveAttribute(
    "href",
    `${repo.url}/actions/runs/1`,
  );
  expect(screen.getByText("/work/app")).toBeInTheDocument();
  expect(screen.getByText("On MacBook")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Copy location" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/Matches recorded branch/)).toBeInTheDocument();
  expect(screen.getByText(/Check list is incomplete/)).toBeInTheDocument();
  expect(
    screen.getByText(/Digest recorded; bytes not retained/),
  ).toBeInTheDocument();
});
it("does not substitute zero work for an unavailable read", () => {
  render(
    <IntlProvider>
      <RunWorkSection
        read={readError("unavailable", 503)}
        org="acme"
        ws="app"
        runId={value.runId}
      />
    </IntlProvider>,
  );
  expect(screen.queryByTestId("run-work")).toBeNull();
  expect(screen.getByText(/unavailable/)).toBeInTheDocument();
});
