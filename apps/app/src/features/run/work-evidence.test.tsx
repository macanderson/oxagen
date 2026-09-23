// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { RunWork as RunWorkView } from "@/data/contracts/run-work";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runDetail, runSource } from "./run.builders";
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode; href: string }) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { RunWork } = await import("./work-evidence");
const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "app",
  wsName: "App",
  wsRole: "member",
});
afterEach(cleanup);
const repo = {
  host: "github.com",
  owner: "acme",
  name: "app",
  url: "https://github.com/acme/app",
  connected: true,
};
const value: RunWorkView = {
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
async function renderWork(read: Read<RunWorkView>) {
  const { source } = runSource({ detail: readOk(runDetail()) });
  source.runs.work = () => Promise.resolve(read);
  const element = await RunWork({
    ctx,
    source,
    org: "acme",
    ws: "app",
    runId: value.runId,
  });
  return render(<IntlProvider>{element}</IntlProvider>).container;
}
it("puts failed CI beside actionable checkout and PR evidence without claiming authorship", async () => {
  const container = await renderWork(readOk(value));
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
  await expectNoAxe(container);
});
it("does not substitute zero work for an unavailable read", async () => {
  const container = await renderWork(readError("unavailable", 503));
  expect(screen.queryByTestId("run-work")).toBeNull();
  expect(screen.getByText(/unavailable/)).toBeInTheDocument();
  await expectNoAxe(container);
});
