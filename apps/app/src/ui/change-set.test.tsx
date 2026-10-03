// @vitest-environment jsdom
// The change set (change-set.tsx, ADR-292): the pull requests a scope
// produced, each with its state and its stored revision, then the files
// rolled up by repository. Opening a file reads it once from each pull
// request that changed it and draws each one's hunks under its own name,
// never joined. A count the forge did not report reads as not recorded. The
// disclosure reads a change set only when a person opens it. Every test ends
// in an axe check.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChangeSet as ChangeSetView,
  RevisionDiff,
} from "@/data/contracts/changes";
import {
  changePull,
  changeRepo,
  changeSet,
  emptyChangeSet,
  revisionDiff,
  secondPull,
} from "@/test/change-views";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  type Answer,
  ChangeSet,
  ChangeSetDisclosure,
  type LoadDiff,
} from "./change-set";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

const ok = <T,>(value: T): Answer<T> => ({ ok: true, value });

/** A loader that answers each revision's read with a one-line hunk naming it. */
function diffLoader() {
  return vi.fn((revisionId: string, paths: string[]) =>
    Promise.resolve<Answer<RevisionDiff>>(
      ok(
        revisionDiff(
          revisionId,
          paths[0] ?? "",
          `@@ -1,1 +1,1 @@\n-before ${revisionId}\n+after ${revisionId}`,
        ),
      ),
    ),
  );
}

function show(set = changeSet(), loadDiff: LoadDiff = diffLoader()) {
  render(
    <IntlProvider>
      <ChangeSet changeSet={set} loadDiff={loadDiff} />
    </IntlProvider>,
  );
}

describe("ChangeSet", () => {
  it("says no pull request is on record when there is none", () => {
    show(emptyChangeSet("work_item"));
    expect(screen.getByTestId("change-set-empty")).toHaveTextContent(
      "No pull request is on record yet.",
    );
    expect(screen.queryByRole("heading", { name: "Pull requests" })).toBeNull();
  });

  it("states the net change rule once, above both lists", () => {
    show();
    expect(
      screen.getAllByText(
        "Each pull request shows its change from its merge base to its latest head.",
      ),
    ).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "Pull requests", level: 4 }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Files changed", level: 4 }),
    ).toBeTruthy();
  });

  it("lists each pull request with its link, state, and stored revision's counts", () => {
    show();
    const rows = screen.getAllByTestId("change-pull");
    expect(rows.map((row) => row.getAttribute("data-state"))).toEqual([
      "open",
      "merged",
    ]);
    const [first, second] = rows;
    if (first === undefined || second === undefined)
      throw new Error("two pull requests");
    const link = within(first).getByRole("link", {
      name: "acme/platform#482",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/platform/pull/482",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(within(first).getByText("open")).toBeTruthy();
    expect(within(first).getByText("Release 3.2")).toBeTruthy();
    expect(within(first).getByText("+12")).toBeTruthy();
    expect(within(first).getByText("−3")).toBeTruthy();
    expect(within(first).getByText("2 files")).toBeTruthy();
    expect(within(second).getByText("merged")).toBeTruthy();
    expect(within(second).queryByTestId("change-left-out")).toBeNull();
  });

  it("lists a pull request closed without merging and says it is left out of the totals", () => {
    show(
      changeSet({
        pullRequests: [
          changePull(),
          secondPull({ state: "closed", mergedAt: null }),
        ],
        repositories: [
          changeRepo({
            pullRequests: 1,
            files: [
              {
                path: "src/app.ts",
                pullRequestIds: ["fpr_482"],
                additions: 10,
                deletions: 3,
              },
            ],
          }),
        ],
      }),
    );
    const closed = screen
      .getAllByTestId("change-pull")
      .find((row) => row.getAttribute("data-state") === "closed");
    if (closed === undefined) throw new Error("a closed pull request");
    expect(within(closed).getByTestId("change-left-out")).toHaveTextContent(
      "Closed without merging, so its files are left out of the totals.",
    );
    const [file] = screen.getAllByTestId("change-file");
    expect(file).toHaveTextContent("#482");
    expect(file).not.toHaveTextContent("#490");
  });

  it("says when no revision is captured, names a diff that is not kept, and never prints a count the forge did not report (negative)", () => {
    show(
      changeSet({
        pullRequests: [
          changePull({ revision: null }),
          secondPull({
            revision: {
              id: "prv_490a",
              headSha: "77aa88bb",
              mergeBaseSha: null,
              diffStatus: "too_large",
              complete: false,
              limitations: [],
              filesChanged: null,
              additions: null,
              deletions: null,
              capturedAt: "2026-10-03T10:00:01.000Z",
            },
          }),
        ],
        repositories: [changeRepo({ additions: null, deletions: null })],
      }),
    );
    const [first, second] = screen.getAllByTestId("change-pull");
    if (first === undefined || second === undefined)
      throw new Error("two pull requests");
    expect(
      within(first).getByText(
        "Oxagen has not captured this pull request's diff yet.",
      ),
    ).toBeTruthy();
    expect(
      within(second).getByText(
        "Oxagen did not keep this diff because it was too large.",
      ),
    ).toBeTruthy();
    expect(within(second).getByText("line counts not recorded")).toBeTruthy();
    const [repository] = screen.getAllByTestId("change-repository");
    expect(repository).toHaveTextContent("line counts not recorded");
    expect(repository).not.toHaveTextContent("+0");
  });

  it("rolls the files up by repository, naming each pull request that changed a path", () => {
    show();
    const [repository] = screen.getAllByTestId("change-repository");
    if (repository === undefined) throw new Error("a repository");
    expect(repository).toHaveTextContent("acme/platform");
    expect(repository).toHaveTextContent("2 files from 2 pull requests");
    const files = within(repository).getAllByTestId("change-file");
    expect(files.map((row) => row.textContent)).toEqual([
      expect.stringContaining("src/app.ts#482 #490+14 −4"),
      expect.stringContaining("CHANGELOG.md#482+2 −0"),
    ]);
  });

  it("reads an opened file once from each pull request's revision and draws each one's hunks under its own name", async () => {
    const user = userEvent.setup();
    const loadDiff = diffLoader();
    show(changeSet(), loadDiff);
    expect(loadDiff).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: /src\/app\.ts/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(loadDiff.mock.calls).toEqual([
      ["prv_482a", ["src/app.ts"]],
      ["prv_490a", ["src/app.ts"]],
    ]);
    const parts = await screen.findAllByTestId("change-file-pull");
    expect(parts).toHaveLength(2);
    const [first, second] = parts;
    if (first === undefined || second === undefined)
      throw new Error("two pull requests' hunks");
    expect(
      await within(first).findByText("+after prv_482a"),
    ).toBeTruthy();
    expect(within(first).getByText("acme/platform#482")).toBeTruthy();
    expect(within(first).queryByText(/prv_490a/)).toBeNull();
    expect(
      await within(second).findByText("+after prv_490a"),
    ).toBeTruthy();
    expect(within(second).getByText("acme/platform#490")).toBeTruthy();
    // Closing and opening again shows what the first read answered.
    await user.click(button);
    await user.click(button);
    expect(loadDiff).toHaveBeenCalledTimes(2);
  });

  it("notes a cut list, an incomplete stored diff, a pull request it cannot link, and no counted files", () => {
    const stored = changePull().revision;
    if (stored === null) throw new Error("a stored revision");
    show(
      changeSet({
        pullRequests: [
          changePull({
            url: "https://example.com/acme/platform/pull/482",
            revision: { ...stored, complete: false },
          }),
          secondPull({ state: "closed", mergedAt: null }),
        ],
        morePullRequests: true,
        repositories: [],
      }),
    );
    const [first] = screen.getAllByTestId("change-pull");
    if (first === undefined) throw new Error("a pull request");
    expect(within(first).queryByRole("link")).toBeNull();
    expect(within(first).getByText("acme/platform#482")).toBeTruthy();
    expect(
      within(first).getByText("The stored diff is incomplete."),
    ).toBeTruthy();
    expect(
      screen.getByText("More pull requests are linked than this list shows."),
    ).toBeTruthy();
    expect(
      screen.getByText("No open or merged pull request changed a file."),
    ).toBeTruthy();
  });

  it("says a repository lists more files than it shows, a pull request past the list, and a path the revision lacks", async () => {
    const user = userEvent.setup();
    show(
      changeSet({
        pullRequests: [changePull()],
        morePullRequests: true,
        repositories: [
          changeRepo({
            moreFiles: true,
            files: [
              {
                path: "src/app.ts",
                pullRequestIds: ["fpr_482", "fpr_999"],
                additions: 14,
                deletions: 4,
              },
            ],
          }),
        ],
      }),
      () =>
        Promise.resolve<Answer<RevisionDiff>>(
          ok(revisionDiff("prv_482a", "src/other.ts", "@@ -1 +1 @@\n+x")),
        ),
    );
    expect(
      screen.getByText(
        "This repository has more changed files than this list shows.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /src\/app\.ts/ }));
    expect(
      await screen.findByText("This revision holds no change to this file."),
    ).toBeTruthy();
    expect(
      screen.getByText("This pull request is past the end of the list above."),
    ).toBeTruthy();
  });

  it.each([
    [
      { ok: false, reason: "pending_approval", accessRequestId: "acr_7" },
      "This read waits on access request acr_7.",
    ],
    [
      { ok: false, reason: "unavailable", code: "diff_digest_mismatch" },
      "Oxagen could not read these changes. The read answered diff_digest_mismatch.",
    ],
  ] as const)(
    "names a read that waits or fails in its own words (negative)",
    async (failure, sentence) => {
      const user = userEvent.setup();
      show(changeSet({ pullRequests: [changePull()] }), () =>
        Promise.resolve<Answer<RevisionDiff>>(failure),
      );
      await user.click(
        screen.getByRole("button", { name: /CHANGELOG\.md/ }),
      );
      expect(await screen.findByTestId("change-failure")).toHaveTextContent(
        sentence,
      );
    },
  );

  it("names a refused diff read and a read that never answered (negative)", async () => {
    const user = userEvent.setup();
    const loadDiff: LoadDiff = (revisionId) =>
      revisionId === "prv_482a"
        ? Promise.resolve<Answer<RevisionDiff>>({
            ok: false,
            reason: "denied",
            code: "run.read",
          })
        : Promise.reject(new Error("network"));
    show(changeSet(), loadDiff);
    await user.click(screen.getByRole("button", { name: /src\/app\.ts/ }));
    await waitFor(() => {
      expect(screen.getAllByTestId("change-failure")).toHaveLength(2);
    });
    const failures = screen.getAllByTestId("change-failure");
    expect(failures.map((failure) => failure.textContent)).toEqual([
      "You cannot read these changes. Your roles do not include run.read.",
      "Oxagen could not reach the server. Reload the page to try again.",
    ]);
  });
});

describe("ChangeSetDisclosure", () => {
  it("reads the change set only when opened, once, and draws it", async () => {
    const user = userEvent.setup();
    const load = vi.fn(() => Promise.resolve(ok(changeSet())));
    render(
      <IntlProvider>
        <ChangeSetDisclosure
          label="Changes from send 1"
          load={load}
          loadDiff={diffLoader()}
          testId="send-changes"
        />
      </IntlProvider>,
    );
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByTestId("change-set")).toBeNull();
    const button = screen.getByRole("button", { name: "Changes from send 1" });
    await user.click(button);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("change-set")).toBeTruthy();
    await user.click(button);
    await user.click(button);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("names a refusal in place of the change set (negative)", async () => {
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <ChangeSetDisclosure
          label="Changes for acme/platform#12"
          load={() =>
            Promise.resolve<Answer<ChangeSetView>>({
              ok: false,
              reason: "not_found",
              code: "not_found",
            })
          }
          loadDiff={diffLoader()}
        />
      </IntlProvider>,
    );
    await user.click(
      screen.getByRole("button", { name: "Changes for acme/platform#12" }),
    );
    expect(await screen.findByTestId("change-failure")).toHaveTextContent(
      "Oxagen has no record of these changes.",
    );
    expect(screen.queryByTestId("change-set")).toBeNull();
  });
});
