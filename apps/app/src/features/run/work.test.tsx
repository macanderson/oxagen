// @vitest-environment jsdom
// The Changes panel's Base row (#3890): the branch each pull request merges
// into, as GitHub records it, linked to its page on the forge. A run with no
// pull request, or whose work read failed, says the base is not recorded
// rather than naming the repository's default branch as a guess.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { type ReactNode, Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunWork } from "@/data/contracts/run-work";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runOutputs, runRow, runWork } from "./run.builders";
import { ChangesPanel, basesOf } from "./work";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

afterEach(cleanup);

type Pull = RunWork["pullRequests"][number];

function pull(overrides: Partial<Pull> = {}): Pull {
  const [first] = runWork().pullRequests;
  if (first === undefined) throw new Error("the builder holds a pull request");
  return { ...first, ...overrides };
}

const mobile = {
  host: "github.com",
  owner: "acme",
  name: "mobile",
  url: "https://github.com/acme/mobile",
  connected: true,
};

async function renderChanges(work: Read<RunWork>): Promise<HTMLElement> {
  await act(async () => {
    render(
      <IntlProvider>
        <Suspense fallback={null}>
          <ChangesPanel
            work={Promise.resolve(work)}
            outputs={readOk(runOutputs([]))}
            run={runRow()}
            place={{ org: "acme", ws: "core-platform", runId: "tse_7k2m9q" }}
          />
        </Suspense>
      </IntlProvider>,
    );
    await Promise.resolve();
  });
  return screen.findByTestId("run-changes");
}

/** The Base row's value, as the definition list pairs it with its term. */
function baseRow(panel: HTMLElement): HTMLElement {
  const term = within(panel)
    .getAllByRole("term")
    .find((node) => node.textContent === "Base");
  const value = term?.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error("expected a Base row");
  return value;
}

describe("basesOf", () => {
  it("names each base branch once, linked to its tree on the forge", () => {
    expect(
      basesOf([pull(), pull({ number: 483 }), pull({ number: 484 })]),
    ).toEqual([
      {
        key: "https://github.com/acme/platform#main",
        label: "main",
        url: "https://github.com/acme/platform/tree/main",
      },
    ]);
  });

  it("names the repository when the pull requests span more than one", () => {
    const labels = basesOf([
      pull(),
      pull({ repository: mobile, number: 12, baseRef: "develop" }),
    ]).map((base) => base.label);
    expect(labels).toEqual(["acme/platform:main", "acme/mobile:develop"]);
  });

  it("keeps a slash in a branch name as a path and escapes what a URL must", () => {
    const [slash] = basesOf([pull({ baseRef: "release/3.x" })]);
    expect(slash?.url).toBe(
      "https://github.com/acme/platform/tree/release/3.x",
    );
    const [hash] = basesOf([pull({ baseRef: "fix#1" })]);
    expect(hash?.url).toBe("https://github.com/acme/platform/tree/fix%231");
  });

  it("names no base for a pull request whose base GitHub left empty, and none for no pull request (negative)", () => {
    expect(basesOf([pull({ baseRef: "" })])).toEqual([]);
    expect(basesOf([])).toEqual([]);
  });

  it("names a base on a forge it cannot link as text (negative)", () => {
    const [base] = basesOf([
      pull({
        repository: {
          ...mobile,
          host: "gitlab.com",
          url: "https://gitlab.com/acme/mobile",
        },
      }),
    ]);
    expect(base).toMatchObject({ label: "main", url: null });
  });
});

describe("the Changes panel's Base row", () => {
  it("prints the branch the pull request merges into, linked to its tree", async () => {
    const panel = await renderChanges(readOk(runWork()));
    const base = within(baseRow(panel));
    expect(base.getByRole("link", { name: "main" }).getAttribute("href")).toBe(
      "https://github.com/acme/platform/tree/main",
    );
    await expectNoAxe(panel);
  });

  it("says the base is not recorded when the run opened no pull request (negative)", async () => {
    const panel = await renderChanges(readOk(runWork({ pullRequests: [] })));
    expect(baseRow(panel).textContent).toBe("not recorded");
  });

  it("names a failed read once, on the pull request row, and not on Base (negative)", async () => {
    const panel = await renderChanges(readError("github_unreachable", 502));
    expect(baseRow(panel).textContent).toBe("not recorded");
    expect(within(panel).getAllByText(/github_unreachable/)).toHaveLength(1);
  });
});

type Release = NonNullable<RunWork["releases"]>[number];

function release(overrides: Partial<Release> = {}): Release {
  return {
    repository: {
      host: "github.com",
      owner: "acme",
      name: "platform",
      url: "https://github.com/acme/platform",
      connected: true,
    },
    tag: "v4.11.0",
    name: "4.11.0",
    url: "https://github.com/acme/platform/releases/tag/untagged-1",
    state: "draft",
    frameSeq: "31",
    observedAt: "2026-09-26T10:00:05.000Z",
    ...overrides,
  };
}

/** The terms the Changes panel's definition list draws, in order. */
function terms(panel: HTMLElement): (string | null)[] {
  return within(panel)
    .getAllByRole("term")
    .map((node) => node.textContent);
}

// #3890: pages/run.md draws Release only when one exists, "v4.11.0 · draft".
describe("the Changes panel's Release row", () => {
  it("draws each release the session created, linked, with GitHub's state", async () => {
    const panel = await renderChanges(
      readOk(
        runWork({
          releases: [
            release(),
            release({
              tag: "v4.10.4",
              state: "published",
              url: "https://github.com/acme/platform/releases/tag/v4.10.4",
            }),
          ],
        }),
      ),
    );
    expect(terms(panel)).toContain("Release");
    const row = within(screen.getByTestId("run-release"));
    expect(row.getByRole("link", { name: "v4.11.0" })).toHaveAttribute(
      "href",
      "https://github.com/acme/platform/releases/tag/untagged-1",
    );
    expect(row.getByText("draft")).toBeTruthy();
    expect(row.getByRole("link", { name: "v4.10.4" })).toBeTruthy();
    expect(row.getByText("published")).toBeTruthy();
    await expectNoAxe(panel);
  });

  it("says the state was not read when GitHub gave none, and links nothing it cannot name (negative)", async () => {
    const panel = await renderChanges(
      readOk(runWork({ releases: [release({ state: null, url: null })] })),
    );
    const row = within(screen.getByTestId("run-release"));
    expect(row.getByText("v4.11.0")).toBeTruthy();
    expect(row.queryByRole("link")).toBeNull();
    expect(row.getByText("state not read")).toBeTruthy();
    await expectNoAxe(panel);
  });

  it("draws no Release row when the session created no release (negative)", async () => {
    for (const work of [
      runWork({ releases: [] }),
      // An answer from before the field says nothing about releases.
      runWork({ releases: undefined }),
    ]) {
      const panel = await renderChanges(readOk(work));
      expect(terms(panel)).not.toContain("Release");
      expect(screen.queryByTestId("run-release")).toBeNull();
      cleanup();
    }
  });
});
