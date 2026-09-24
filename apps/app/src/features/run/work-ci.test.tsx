// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { IssuesSection } from "./issues";
import {
  runDetail,
  runOutputNode,
  runOutputs,
  runRow,
  runSource,
  runTranscript,
  runWork,
} from "./run.builders";
import { ChangesPanel } from "./work";
import { branchUrl, checksOf, pullForBranch, repositoriesOf } from "./work-ci";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode; href: string }) => (
    <a {...props}>{children}</a>
  ),
}));
Element.prototype.scrollIntoView = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../run-outcomes/actions", () => ({
  setRunOutcomesConsentAction: vi.fn(),
}));
vi.mock("./actions", () => ({
  haltRun: vi.fn(),
  steerRun: vi.fn(),
  summarizeRun: vi.fn(),
  exportRun: vi.fn(),
  readRunExport: vi.fn(),
}));
vi.mock("next-intl/server", async () => {
  const { translator } = await import("@/test/intl");
  return { getTranslations: (namespace?: string) => translator(namespace) };
});
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Run } = await import("./run");

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

afterEach(cleanup);

const place = { org: "acme", ws: "core-platform", runId: "tse_7k2m9q" };
const work = runWork();
const pull = work.pullRequests[0];
if (pull === undefined) throw new Error("the builder names one pull request");
const repo = pull.repository;

describe("the work helpers", () => {
  it("lists each repository once, checkouts first", () => {
    const other = {
      ...repo,
      name: "docs",
      url: "https://github.com/acme/docs",
    };
    const value = runWork({
      pullRequests: [
        pull,
        { ...pull, repository: other, url: `${other.url}/pull/3` },
      ],
    });
    expect(repositoriesOf(value).map((r) => r.url)).toEqual([
      repo.url,
      other.url,
    ]);
    expect(repositoriesOf(null)).toEqual([]);
  });

  it("links a branch that heads a pull request to the pull request, never to refs/pull", () => {
    expect(pullForBranch(work, "release/4.11.0-notes")).toBe(pull);
    expect(branchUrl(repo, "release/4.11.0-notes", pull)).toBe(pull.url);
    expect(branchUrl(repo, "fix/a b", null)).toBe(
      "https://github.com/acme/platform/tree/fix/a%20b",
    );
    expect(branchUrl(repo, "refs/pull/482/head", null)).toBeNull();
    expect(branchUrl(null, "main", null)).toBeNull();
  });

  it("reads the checks from the first pull request that reported any", () => {
    expect(checksOf(work)?.overall).toBe("failing");
    expect(checksOf(runWork({ pullRequests: [{ ...pull, ci: null }] }))).toBe(
      null,
    );
    expect(checksOf(null)).toBeNull();
  });
});

describe("the Changes panel", () => {
  it("names the pull request as a forge link with its state, every check, and the diff", async () => {
    const { container } = render(
      <IntlProvider>
        <ChangesPanel
          read={readOk(runOutputs())}
          work={readOk(work)}
          place={place}
        />
      </IntlProvider>,
    );
    expect(
      screen.getByRole("link", {
        name: pull.repository.owner + "/platform#482",
      }),
    ).toHaveAttribute("href", pull.url);
    const row = screen.getByTestId("run-changes-pr");
    expect(within(row).getByText("open")).toBeInTheDocument();
    const checks = screen.getByTestId("run-checks");
    expect(within(checks).getByRole("link", { name: "unit" })).toHaveAttribute(
      "href",
      "https://github.com/acme/platform/actions/runs/2",
    );
    expect(within(checks).getByText("failure")).toBeInTheDocument();
    expect(
      screen.getByText("1 passed · 1 failed · 0 pending"),
    ).toBeInTheDocument();
    // The outputs recorded no file change, so the diff is the pull request's.
    expect(screen.getByTestId("run-changes-diff")).toHaveTextContent(
      "+20 −0 in 1 file",
    );
    expect(screen.getByText("release/4.11.0-notes.md")).toBeInTheDocument();
    await expectNoAxe(container);
  });

  it("prefers the files the frames recorded and says a capped read is a prefix", () => {
    render(
      <IntlProvider>
        <ChangesPanel
          read={readOk(runOutputs([runOutputNode()], { complete: false }))}
          work={readOk(work)}
          place={place}
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("run-changes-diff")).toHaveTextContent(
      "+41+ −6+ in 1 file",
    );
    expect(screen.queryByText("release/4.11.0-notes.md")).toBeNull();
  });

  it("falls back to the spine's pull requests when the work read failed, and prints no check", () => {
    render(
      <IntlProvider>
        <ChangesPanel
          read={readOk(
            runOutputs([
              runOutputNode({
                kind: "pr",
                name: "#482",
                state: "open",
                stat: null,
              }),
            ]),
          )}
          work={readError("unavailable", 503)}
          place={place}
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("run-changes-pr")).toHaveTextContent("#482");
    expect(screen.queryByRole("link", { name: /#482/ })).toBeNull();
    expect(screen.getByText("none reported")).toBeInTheDocument();
  });
});

describe("Linked work", () => {
  it("lists the repository with the frame that recorded it and counts a branch match as inferred", () => {
    const matched = { ...pull, association: "branch" as const };
    render(
      <IntlProvider>
        <IssuesSection
          run={runRow()}
          outputs={readOk(runOutputs())}
          work={readOk(runWork({ pullRequests: [matched] }))}
          place={place}
        />
      </IntlProvider>,
    );
    const repository = screen.getByTestId("run-linked-repository");
    expect(
      within(repository).getByRole("link", { name: "acme/platform" }),
    ).toHaveAttribute("href", repo.url);
    expect(within(repository).getByText("observed")).toBeInTheDocument();
    expect(within(repository).getByText("fr 1")).toBeInTheDocument();
    const linked = screen.getByTestId("run-linked-pr");
    expect(
      within(linked).getByRole("link", { name: "acme/platform#482" }),
    ).toHaveAttribute("href", pull.url);
    expect(within(linked).getByText("inferred")).toBeInTheDocument();
    expect(screen.getByText(/1 of 2$/)).toBeInTheDocument();
  });
});

describe("one read names one pull request", () => {
  it("draws the same pull request in the checkout strip and the Changes panel, and copies the recorded path", async () => {
    const { source } = runSource({
      detail: readOk(runDetail()),
      transcript: readOk(runTranscript()),
      work: readOk(work),
    });
    const page = await Run({
      ctx,
      source,
      runId: "tse_7k2m9q",
      tab: null,
      zoom: null,
      kinds: null,
      frames: null,
      body: null,
      reads: null,
      spine: null,
      now: Date.parse("2026-09-15T09:00:00.000Z"),
    });
    // The strip and the panel suspend on the work read; letting the settled
    // read through inside act renders what it carries.
    await act(async () => {
      render(<IntlProvider>{page}</IntlProvider>);
      await Promise.resolve();
    });
    const strip = await screen.findByTestId("run-checkout");
    expect(await within(strip).findByText("acme/platform")).toBeInTheDocument();
    const branch = within(strip).getByTestId("run-checkout-branch");
    expect(branch.closest("a")).toHaveAttribute("href", pull.url);
    const stripPull = within(strip).getByTestId("run-checkout-pr");
    expect(stripPull).toHaveTextContent("acme/platform#482");
    const changes = await screen.findByTestId("run-changes-pr");
    expect(changes).toHaveTextContent("acme/platform#482");
    const machine = within(strip).getByTestId("run-machine");
    expect(machine).toHaveTextContent("mbell-mbp-16:~/src/platform");
    expect(within(machine).queryByText("derived")).toBeNull();

    // A browser that refuses the clipboard says so and does not throw.
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(within(machine).getByRole("button"));
    expect(await within(machine).findByRole("status")).toHaveTextContent(
      "Copy failed",
    );
    expect(writeText).toHaveBeenCalledWith("mbell-mbp-16:~/src/platform");
  });
});
