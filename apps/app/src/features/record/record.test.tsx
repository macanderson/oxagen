// @vitest-environment jsdom
// The record page over a fake DataSource (#3395; mockups/pages/record.md): the
// address it accepts, the header that leads with the statement, the editor,
// the six kinds each drawing their own panel, the proposal and archive
// dialogs, the related records, and the not-loaded states in the design's
// words. Each render carries an axe check (INV-26).
//
// What the write does is proven in packages/handlers/src/context.record.page.test.ts,
// where a pull request opens, changes one file and merges. This suite is about
// what the page renders and what it declines to claim.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "@/data/contracts/common";
import {
  RECORD_KINDS,
  type RecordDetail,
  type RecordKind,
} from "@/data/contracts/steering";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  LINEAGE,
  proposal,
  publishedRecord,
  recordDetail,
  steeringSource,
} from "@/test/steering-views";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
const revise = vi.fn<(...args: unknown[]) => unknown>();
vi.mock("./actions", () => ({
  reviseRecord: (...args: unknown[]) => revise(...args),
}));
const session = vi.fn<() => unknown>();
vi.mock("@/server/session", () => ({
  getSession: () => session(),
}));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Record, RecordLoading } = await import("./record");
const { Related } = await import("./related");
const { ArchiveDialog } = await import("./archive-dialog");
const { KindPanel } = await import("./kind-panel");

const viewer = (orgRole: OrgRole, wsRole: OrgRole) =>
  unsafeMint(WsCtx, {
    userId: "usr_marcusbell",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme",
    orgRole,
    workspaceId: "7b000000-0000-4000-8000-000000000001",
    wsSlug: "core-platform",
    wsName: "Core platform",
    wsRole,
  });

const ctx = viewer("admin", "member");

type Reads = Parameters<typeof steeringSource>[0];

async function renderRecord(
  reads: Reads = {},
  options: { lineage?: string; as?: typeof ctx } = {},
) {
  // No proposal is open on the record unless a test raises one: the shared
  // builder's default proposal is on this same lineage.
  const { source, calls } = steeringSource({
    proposals: readOk({ proposals: [], total: 0 }),
    ...reads,
  });
  const element = await Record({
    ctx: options.as ?? ctx,
    source,
    lineage: options.lineage ?? LINEAGE,
  });
  const view = render(<IntlProvider>{element}</IntlProvider>);
  return { calls, ...view };
}

function ofKind(kind: RecordKind, statement?: string): RecordDetail {
  return recordDetail({
    record: {
      ...publishedRecord({
        kind,
        force: kind === "preference" ? "may" : "must",
        constraintEffect: kind === "constraint" ? "forbid" : null,
        ...(statement === undefined ? {} : { statement }),
      }),
      status: "active",
    },
  });
}

beforeEach(() => {
  revise.mockReset();
  session.mockReset();
  session.mockResolvedValue({
    user: { name: "Marcus Bell", email: "marcus@acme.test" },
  });
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Record › the address", () => {
  it("reads the one record the lineage names, its proposals and the freshness", async () => {
    const { calls } = await renderRecord();
    expect(calls.record).toEqual([[ctx, LINEAGE]]);
    expect(calls.proposals).toEqual([[ctx, { offset: 0, lineage: LINEAGE }]]);
    expect(calls.freshness).toEqual([[ctx]]);
  });

  it("counts every published record for a constraint's conflict note", async () => {
    const { calls } = await renderRecord();
    expect(calls.records).toContainEqual([ctx, { kind: null, offset: 0 }]);
  });

  it.each(["Upper.Case", "-leading", "trailing-", "has space", ""])(
    "raises a not-found for %j without reading",
    async (lineage) => {
      const { source, calls } = steeringSource();
      await expect(Record({ ctx, source, lineage })).rejects.toThrow(
        "NEXT_NOT_FOUND",
      );
      expect(calls.record).toEqual([]);
    },
  );

  it("raises a not-found when neither the file nor the registry holds it", async () => {
    const { source } = steeringSource({
      record: readError("record_not_found", 404),
    });
    await expect(
      Record({ ctx, source, lineage: "ctx.nothing.holds-this" }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("Record › the header", () => {
  it("makes the statement the h1", async () => {
    await renderRecord();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Do not re-read CHANGELOG.md after the first read in a run.",
    );
  });

  it("links Steering in the eyebrow back to the records", async () => {
    await renderRecord();
    const header = screen.getByTestId("record-header");
    const link = within(header).getByRole("link", { name: "Steering" });
    expect(link.getAttribute("href")).toContain("/acme/core-platform/steering");
    expect(header.textContent).toContain("record");
  });

  it("draws the chips in order: kind, force, effect, scope, published", async () => {
    await renderRecord();
    const chips = screen.getByTestId("record-chips");
    const terms = Array.from(chips.querySelectorAll("[data-term]")).map(
      (chip) => chip.getAttribute("data-term"),
    );
    expect(terms).toEqual([
      "kind",
      "force",
      "constraint-effect",
      "scope",
      "status",
    ]);
    expect(chips.textContent).toContain("constraint");
    expect(chips.textContent).toContain("must");
    expect(chips.textContent).toContain("forbid");
    expect(chips.textContent).toContain("workspace");
    expect(chips.textContent).toContain("published");
  });

  it("gives the kind a glyph as well as a hue", async () => {
    await renderRecord();
    const badge = screen
      .getByTestId("record-chips")
      .querySelector('[data-term="kind"]');
    expect(badge?.querySelector("svg")).not.toBeNull();
    expect(badge?.className).toContain("text-kind-constraint");
  });

  it("reads a retired record as archived and offers no Archive", async () => {
    await renderRecord({
      record: readOk(
        recordDetail({ record: { ...publishedRecord(), status: "retired" } }),
      ),
    });
    expect(
      screen.getByTestId("record-chips").querySelector('[data-term="status"]')
        ?.textContent,
    ).toBe("archived");
    expect(screen.queryByTestId("record-archive-open")).toBeNull();
  });

  it("says it is in force because its commit merged", async () => {
    await renderRecord();
    expect(screen.getByTestId("record-in-force").textContent).toBe(
      "A hard boundary: require or forbid. It is in force because 4d5e6f7 merged, and it stops being in force the same way.",
    );
  });

  it("says the commit merged without naming one it could not read", async () => {
    await renderRecord({
      record: readOk(
        recordDetail({
          provenance: null,
          record: { ...publishedRecord({ commit: null }), status: "active" },
        }),
      ),
    });
    expect(screen.getByTestId("record-in-force").textContent).toContain(
      "because the commit that published it merged",
    );
  });

  it("shows the pending branch while a proposal is open on the lineage", async () => {
    await renderRecord({
      proposals: readOk({
        proposals: [
          proposal({
            lineage: LINEAGE,
            status: "checks_running",
            pr: {
              number: 522,
              repository: "acme/platform",
              branch: `context/${LINEAGE}`,
            },
          }),
        ],
        total: 1,
      }),
    });
    const pending = screen
      .getByTestId("record-chips")
      .querySelector('[data-term="pending"]');
    expect(pending?.textContent).toBe(`context/${LINEAGE}`);
  });

  it("ignores a proposal on another lineage and one already merged", async () => {
    await renderRecord({
      proposals: readOk({
        proposals: [
          proposal({ lineage: "ctx.other.thing", status: "pr_open" }),
          proposal({ lineage: LINEAGE, status: "merged" }),
        ],
        total: 2,
      }),
    });
    expect(
      screen.getByTestId("record-chips").querySelector('[data-term="pending"]'),
    ).toBeNull();
  });

  it("carries exactly one gold action", async () => {
    await renderRecord();
    const gold = document.querySelectorAll(".bg-button-primary-bg");
    expect(gold).toHaveLength(1);
    expect(gold[0]?.textContent).toBe("Propose a change");
  });
});

describe("Record › the statement editor", () => {
  it("holds the statement and nothing else, under the file and field", async () => {
    await renderRecord();
    const editor = screen.getByTestId("record-editor");
    expect(editor.textContent).toContain(
      `.oxagen/rules/${LINEAGE}.toml · statement`,
    );
    const area = screen.getByTestId<HTMLTextAreaElement>("record-statement");
    expect(area.value).toBe(
      "Do not re-read CHANGELOG.md after the first read in a run.",
    );
    expect(area.value).not.toContain("kind =");
  });

  it("numbers one gutter row per line of the statement", async () => {
    await renderRecord({
      record: readOk(ofKind("procedure", "1. Freeze main\n2. Tag\n3. Publish")),
    });
    expect(screen.getByTestId("record-gutter").children).toHaveLength(3);
  });

  it("paints markdown: code, bold and list markers each take a token", async () => {
    await renderRecord({
      record: readOk(
        ofKind("rule", "- Run `pnpm check` before **every** push"),
      ),
    });
    const paint = screen.getByTestId("record-paint");
    const kinds = Array.from(paint.querySelectorAll("[data-token]")).map(
      (span) => span.getAttribute("data-token"),
    );
    expect(kinds).toEqual(["marker", "code", "strong"]);
  });

  it("prints the status line: position, grammar, counts, line ending, encoding", async () => {
    await renderRecord();
    expect(screen.getByTestId("record-caret").textContent).toBe("Ln 1, Col 1");
    expect(screen.getByTestId("record-grammar").textContent).toBe("Markdown");
    expect(screen.getByTestId("record-counts").textContent).toBe(
      "1 line · 58 chars",
    );
    expect(screen.getByText("LF")).toBeDefined();
    expect(screen.getByText("UTF-8")).toBeDefined();
  });

  it("names the bundle tokens as not recorded rather than guessing", async () => {
    await renderRecord();
    expect(
      screen
        .getByTestId("record-editor")
        .querySelector('[data-state="not-recorded"]')?.textContent,
    ).toBe("bundle tokens not recorded");
  });

  it("counts matches in Find", async () => {
    await renderRecord();
    const find = screen.getByTestId("record-find");
    fireEvent.change(find, { target: { value: "re" } });
    expect(screen.getByTestId("record-find-count").textContent).toBe("3");
    fireEvent.change(find, { target: { value: "zzz" } });
    expect(screen.getByTestId("record-find-count").textContent).toBe("0");
  });

  it("indents with Tab rather than leaving the field", async () => {
    const user = userEvent.setup();
    await renderRecord();
    const area = screen.getByTestId<HTMLTextAreaElement>("record-statement");
    area.focus();
    area.setSelectionRange(0, 0);
    await user.keyboard("{Tab}");
    expect(area.value.startsWith("  Do not")).toBe(true);
    expect(document.activeElement).toBe(area);
  });

  it("marks the draft modified and Discard returns it to what is in force", async () => {
    const user = userEvent.setup();
    await renderRecord();
    const discard = screen.getByTestId("record-discard");
    expect(discard.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("draft-state").textContent).toBe("unchanged");
    const area = screen.getByTestId<HTMLTextAreaElement>("record-statement");
    await user.type(area, " Ever.");
    expect(screen.getByTestId("draft-state").textContent).toBe("modified");
    expect(discard.hasAttribute("disabled")).toBe(false);
    await user.click(discard);
    expect(area.value).toBe(
      "Do not re-read CHANGELOG.md after the first read in a run.",
    );
    expect(discard.hasAttribute("disabled")).toBe(true);
  });

  it("notes that the rest of the file changes by a pull request on the main repo", async () => {
    await renderRecord();
    expect(screen.getByTestId("record-editor-note").textContent).toContain(
      "a pull request against acme/platform.",
    );
  });
});

describe("Record › the lineage panel", () => {
  it("names the lineage, the file on the main repo, the commit, the effect and the schema", async () => {
    await renderRecord();
    const panel = screen.getByTestId("record-lineage");
    expect(panel.textContent).toContain(
      "the graph remembers everything; git decides what is in force",
    );
    const fact = (name: string) =>
      panel.querySelector(`[data-fact="${name}"]`)?.textContent;
    expect(fact("lineage")).toBe(LINEAGE);
    expect(fact("file")).toBe(`.oxagen/rules/${LINEAGE}.toml on acme/platform`);
    expect(fact("published")).toMatch(/^4d5e6f7 on /);
    expect(fact("effect")).toBe(
      "rendered 214 · cited 37 · violated not recorded",
    );
    expect(fact("schema")).toBe("context-record/v0.1");
  });

  it("says never rendered for a record no run carried, and not recorded with no rollup", async () => {
    await renderRecord({
      record: readOk(recordDetail({ effect: { rendered: 0, cited: 0 } })),
    });
    expect(
      screen.getByTestId("record-lineage").querySelector('[data-fact="effect"]')
        ?.textContent,
    ).toBe("never rendered");
    cleanup();
    await renderRecord({ record: readOk(recordDetail({ effect: null })) });
    expect(
      screen.getByTestId("record-lineage").querySelector('[data-fact="effect"]')
        ?.textContent,
    ).toContain("not recorded");
  });
});

describe("Record › the six kinds", () => {
  it.each(RECORD_KINDS)(
    "draws the %s panel opening on how it reaches a run and ending on what it can never do",
    async (kind) => {
      await renderRecord({ record: readOk(ofKind(kind)) });
      const panel = screen.getByTestId("record-kind-panel");
      expect(panel.getAttribute("data-kind")).toBe(kind);
      expect(within(panel).getByTestId("record-deliver").textContent).toMatch(
        /^How it reaches a run/,
      );
      const never = within(panel).getByTestId("record-kind-never");
      expect(never.textContent).toMatch(/^What it can never do\. /);
      expect(panel.lastElementChild?.lastElementChild).toBe(never);
    },
  );

  it("draws six different panels across the six kinds", async () => {
    const openings = new Set<string>();
    for (const kind of RECORD_KINDS) {
      await renderRecord({ record: readOk(ofKind(kind)) });
      openings.add(
        screen.getByTestId("record-kind-panel").textContent.slice(0, 90),
      );
      cleanup();
    }
    expect(openings.size).toBe(6);
  });

  it("draws the boundary block on a constraint and on nothing else", async () => {
    for (const kind of RECORD_KINDS) {
      await renderRecord({ record: readOk(ofKind(kind)) });
      expect(screen.queryByTestId("record-boundary") !== null).toBe(
        kind === "constraint",
      );
      cleanup();
    }
  });

  it("says a forbid with no grant compiles to text and gates nothing", async () => {
    await renderRecord();
    const block = screen.getByTestId("record-boundary");
    expect(block.getAttribute("data-effect")).toBe("forbid");
    expect(block.getAttribute("data-grant")).toBe("none");
    expect(block.textContent).toContain(
      "Nothing refuses a call because of it until a grant compiles a gate.",
    );
    expect(block.textContent).not.toContain("Gates");
  });

  it("says a require stops the run at the point that needs it", async () => {
    await renderRecord({
      record: readOk(
        recordDetail({
          record: {
            ...publishedRecord({ constraintEffect: "require" }),
            status: "active",
          },
        }),
      ),
    });
    expect(screen.getByTestId("record-boundary").textContent).toContain(
      "cannot proceed past the point that needs it",
    );
  });

  it("counts the published records the conflict check runs across", async () => {
    await renderRecord({
      records: readOk({ records: [publishedRecord()], total: 59 }),
    });
    expect(screen.getByTestId("record-kind-panel").textContent).toContain(
      "across all 59 published records",
    );
  });

  it("lists a procedure's steps in order, one per row", async () => {
    await renderRecord({
      record: readOk(
        ofKind(
          "procedure",
          "Cut a release in this order: freeze main, dry-run the migrations, tag, then publish the notes.",
        ),
      ),
    });
    const steps = within(screen.getByTestId("record-steps")).getAllByRole(
      "listitem",
    );
    expect(steps.map((step) => step.textContent)).toEqual([
      "Freeze main",
      "Dry-run the migrations",
      "Tag",
      "Publish the notes",
    ]);
  });

  it("names a fact's valid_from from its commit and what steers it", async () => {
    await renderRecord({ record: readOk(ofKind("fact")) });
    const panel = screen.getByTestId("record-kind-panel");
    expect(
      panel.querySelector('[data-fact="valid-from"]')?.textContent,
    ).toMatch(/the merge time of 4d5e6f7$/);
    expect(panel.textContent).toContain("nothing by itself");
    expect(panel.textContent).toContain("Falsifiable by");
  });

  it("says a memory is never pinned and nothing decays it", async () => {
    await renderRecord({ record: readOk(ofKind("memory")) });
    const panel = screen.getByTestId("record-kind-panel");
    expect(panel.querySelector('[data-fact="selection"]')?.textContent).toBe(
      "by relevance, never pinned: 37 of 214 runs that carried it actually used it",
    );
    expect(panel.querySelector('[data-fact="decay"]')?.textContent).toMatch(
      /^none automatic\./,
    );
  });

  it("reads a preference's third count as not followed, in grey", async () => {
    await renderRecord({ record: readOk(ofKind("preference")) });
    const panel = screen.getByTestId("record-kind-panel");
    expect(panel.textContent).toContain("not followed");
    const third = panel.querySelector('[data-meter="third"] i');
    expect(third?.className).toContain("bg-rule");
    expect(third?.className).not.toContain("bg-error");
  });

  it("draws the meters as shares of the rendered total", async () => {
    await renderRecord({ record: readOk(ofKind("rule")) });
    const meter = (name: string) =>
      document.querySelector(`[data-meter="${name}"]`)?.textContent;
    expect(meter("rendered")).toBe("Runs it was rendered into214 of 214");
    expect(meter("cited")).toBe("Runs that cited it37 of 214");
    expect(meter("third")).toBe("Runs that went against itnot recorded");
  });

  it("never labels a counter a score, a verdict or a proof", async () => {
    await renderRecord({ record: readOk(ofKind("rule")) });
    const text = document.body.textContent.toLowerCase();
    for (const word of ["score", "verdict", "proven", "proof"])
      expect(text).not.toContain(word);
  });

  it("names the bundle version on a rule and its share as not recorded", async () => {
    await renderRecord({ record: readOk(ofKind("rule")) });
    expect(screen.getByTestId("record-kind-panel").textContent).toContain(
      "v12 · this record's tokens are not recorded yet",
    );
  });

  it("says a record with no kind is unclassified rather than guessing one", async () => {
    await renderRecord({
      record: readOk(
        recordDetail({
          record: {
            ...publishedRecord({ kind: null, constraintEffect: null }),
            status: "active",
          },
        }),
      ),
    });
    expect(
      screen.getByTestId("record-kind-panel").getAttribute("data-kind"),
    ).toBe("unclassified");
  });

  it("states the rule's force it cannot place as not recorded", () => {
    render(
      <IntlProvider>
        <KindPanel
          detail={recordDetail({
            record: {
              ...publishedRecord({
                kind: "rule",
                force: null,
                constraintEffect: null,
              }),
              status: "active",
            },
            effect: null,
          })}
          bundleVersion={null}
          publishedTotal={null}
        />
      </IntlProvider>,
    );
    const panel = screen.getByTestId("record-kind-panel");
    expect(panel.querySelector('[data-placement="unknown"]')).not.toBeNull();
    expect(screen.getByTestId("record-meters").getAttribute("data-state")).toBe(
      "not-recorded",
    );
  });
});

describe("Record › Propose a change", () => {
  async function openProposal(reads: Reads = {}, as = ctx) {
    const user = userEvent.setup();
    const view = await renderRecord(reads, { as });
    await user.click(screen.getByTestId("record-propose-open"));
    return { user, ...view };
  }

  it("opens with the lead, the branch, the diff count and the six checks", async () => {
    await openProposal();
    const dialog = screen.getByTestId("record-propose");
    expect(
      within(dialog).getByText("Propose a change to this record"),
    ).toBeDefined();
    expect(dialog.textContent).toContain(
      "A published record is changed the way it was published: a branch, a pull request, the same six checks, and a merge. Nothing here edits what is in force.",
    );
    expect(dialog.textContent).toContain(`context/${LINEAGE}`);
    expect(within(dialog).getByTestId("record-diff-stat").textContent).toBe(
      "+0 −0",
    );
    expect(dialog.textContent).toContain("Nothing changed yet.");
    const checks = Array.from(dialog.querySelectorAll("[data-check] b")).map(
      (b) => b.textContent,
    );
    expect(checks).toEqual([
      "Schema",
      "Lineage",
      "record_hash recomputation",
      "Secret and PII scan",
      "Conflict against active records",
      "constraint_effect",
    ]);
  });

  it("disables the primary until the statement changed", async () => {
    await openProposal();
    expect(
      screen.getByTestId("record-propose-submit").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("shows the line diff and opens the pull request, leaving the record in force", async () => {
    revise.mockResolvedValue({
      ok: true,
      value: { status: "checks_running", prNumber: 528, prUrl: null },
    });
    const user = userEvent.setup();
    await renderRecord();
    const area = screen.getByTestId<HTMLTextAreaElement>("record-statement");
    await user.clear(area);
    await user.type(area, "Read CHANGELOG.md once.");
    await user.click(screen.getByTestId("record-propose-open"));
    expect(screen.getByTestId("record-diff-stat").textContent).toBe("+1 −1");
    expect(
      screen.getByTestId("record-diff").querySelectorAll('[data-side="add"]'),
    ).toHaveLength(1);
    await user.click(screen.getByTestId("record-propose-submit"));
    expect(revise).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      LINEAGE,
      "Read CHANGELOG.md once.",
      "",
    );
    expect(screen.getByTestId("record-propose-done").textContent).toContain(
      `acme/platform#528 opened. ${LINEAGE} changes when it merges; until then every run still gets the words that are in force now.`,
    );
    // The dialog is modal, so the page behind it is hidden from the
    // accessibility tree; the h1 is read from the document.
    expect(document.querySelector("h1")?.textContent).toBe(
      "Do not re-read CHANGELOG.md after the first read in a run.",
    );
    expect(
      screen.getByTestId("record-chips").querySelector('[data-term="pending"]')
        ?.textContent,
    ).toBe(`context/${LINEAGE}`);
  });

  it("names the refusal when the write is refused", async () => {
    revise.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "lineage_pr_open",
    });
    const user = userEvent.setup();
    await renderRecord();
    await user.type(screen.getByTestId("record-statement"), " Ever.");
    await user.click(screen.getByTestId("record-propose-open"));
    await user.click(screen.getByTestId("record-propose-submit"));
    expect(screen.getByTestId("record-propose-failure").textContent).toBe(
      "A change is already open on this record. Merge or close that pull request first.",
    );
  });

  it("says a role that only reads cannot propose, and disables the primary", async () => {
    const user = userEvent.setup();
    await renderRecord({}, { as: viewer("member", "viewer") });
    await user.type(screen.getByTestId("record-statement"), " Ever.");
    await user.click(screen.getByTestId("record-propose-open"));
    expect(screen.getByTestId("record-propose-read-only")).toBeDefined();
    expect(
      screen.getByTestId("record-propose-submit").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("names the open branch and withholds a second proposal", async () => {
    const user = userEvent.setup();
    await renderRecord({
      proposals: readOk({
        proposals: [proposal({ lineage: LINEAGE, status: "pr_open" })],
        total: 1,
      }),
    });
    await user.type(screen.getByTestId("record-statement"), " Ever.");
    await user.click(screen.getByTestId("record-propose-open"));
    expect(screen.getByTestId("record-propose-pending")).toBeDefined();
    expect(
      screen.getByTestId("record-propose-submit").hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("Record › Archive", () => {
  it("says archiving is a pull request, names the gate that goes with it, and cannot open one yet", async () => {
    const user = userEvent.setup();
    await renderRecord();
    await user.click(screen.getByTestId("record-archive-open"));
    const dialog = screen.getByTestId("record-archive");
    expect(within(dialog).getByText(`Archive ${LINEAGE}?`)).toBeDefined();
    expect(dialog.textContent).toContain(
      `Archiving is a pull request that sets status = "archived" on .oxagen/rules/${LINEAGE}.toml.`,
    );
    expect(
      within(dialog).getByTestId("record-archive-gate").textContent,
    ).toContain("forbid");
    expect(dialog.textContent).toContain("Nothing is deleted.");
    const submit = within(dialog).getByTestId("record-archive-submit");
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(submit.getAttribute("data-gap")).toBe("#3867");
    expect(within(dialog).getByText("Keep it in force")).toBeDefined();
  });

  it("says a record with a pull request open already has one", () => {
    render(
      <IntlProvider>
        <ArchiveDialog
          open
          onOpenChange={vi.fn()}
          lineage={LINEAGE}
          path={`.oxagen/rules/${LINEAGE}.toml`}
          repository="acme/platform"
          archived={false}
          pendingBranch={`context/${LINEAGE}`}
          constraintEffect="forbid"
        />
      </IntlProvider>,
    );
    expect(
      screen.getByText(`${LINEAGE} already has a pull request open`),
    ).toBeDefined();
    expect(screen.queryByTestId("record-archive-submit")).toBeNull();
  });

  it("says an archived record is already archived", () => {
    render(
      <IntlProvider>
        <ArchiveDialog
          open
          onOpenChange={vi.fn()}
          lineage={LINEAGE}
          path={`.oxagen/rules/${LINEAGE}.toml`}
          repository={null}
          archived
          pendingBranch={null}
          constraintEffect={null}
        />
      </IntlProvider>,
    );
    expect(screen.getByText(`${LINEAGE} is already archived`)).toBeDefined();
  });
});

describe("Record › related records", () => {
  const at = { org: "acme", ws: "core-platform", lineage: LINEAGE };
  const others = [
    publishedRecord({ id: "ctr_a1", lineage: "ctx.a.one", statement: "Beta" }),
    publishedRecord({ id: "ctr_a2", lineage: "ctx.a.two", statement: "Alpha" }),
    publishedRecord({
      id: "ctr_a3",
      lineage: "ctx.a.three",
      statement: "Gamma",
    }),
    publishedRecord({
      id: "ctr_a4",
      lineage: "ctx.a.four",
      statement: "Delta",
    }),
  ];

  it("shows up to three others of the kind, each with an Open link, under the list controls", () => {
    render(
      <IntlProvider>
        <Related
          at={at}
          workspace="Core platform"
          kind="constraint"
          read={readOk({
            records: [publishedRecord(), ...others],
            total: 5,
          })}
        />
      </IntlProvider>,
    );
    const panel = screen.getByTestId("record-related");
    expect(
      within(panel).getByRole("heading", { name: "Related records" }),
    ).toBeDefined();
    const opens = within(panel).getAllByRole("link", { name: "Open" });
    expect(opens.map((link) => link.getAttribute("href"))).toEqual([
      "/acme/core-platform/steering/records/ctx.a.one",
      "/acme/core-platform/steering/records/ctx.a.two",
      "/acme/core-platform/steering/records/ctx.a.three",
    ]);
    expect(within(panel).getByLabelText("Search records")).toBeDefined();
    expect(within(panel).getByText("Sort")).toBeDefined();
    expect(within(panel).getByText("Rows")).toBeDefined();
    expect(panel.textContent).toContain("1–3 of 3");
  });

  it("searches and sorts the cards on screen", async () => {
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <Related
          at={at}
          workspace="Core platform"
          kind="constraint"
          read={readOk({ records: others, total: 4 })}
        />
      </IntlProvider>,
    );
    const list = () =>
      Array.from(
        screen
          .getByTestId("record-related-list")
          .querySelectorAll("li p:first-of-type"),
      ).map((p) => p.textContent);
    await user.selectOptions(screen.getByLabelText("Sort"), "Statement A–Z");
    expect(list()).toEqual(["Alpha", "Beta", "Gamma"]);
    await user.type(screen.getByLabelText("Search records"), "gam");
    expect(list()).toEqual(["Gamma"]);
  });

  it("says this is the only one of its kind in the workspace", () => {
    render(
      <IntlProvider>
        <Related
          at={at}
          workspace="Core platform"
          kind="constraint"
          read={readOk({ records: [publishedRecord()], total: 1 })}
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("record-related").textContent).toContain(
      "None. This is the only constraint in Core platform.",
    );
  });

  it("has nothing to compare an unclassified record with", () => {
    render(
      <IntlProvider>
        <Related at={at} workspace="Core platform" kind={null} read={null} />
      </IntlProvider>,
    );
    expect(
      screen
        .getByTestId("record-related")
        .querySelector('[data-state="not-recorded"]'),
    ).not.toBeNull();
  });
});

describe("Record › the not-loaded states", () => {
  it("names the permission a denied read needs, with the design's actions", async () => {
    await renderRecord({
      record: { ok: false, reason: "denied", permission: "steering.read" },
    });
    const denied = screen.getByTestId("record-denied");
    expect(within(denied).getByRole("heading").textContent).toBe(
      "You cannot see this record",
    );
    expect(denied.textContent).toContain(
      "Your roles on Acme do not include steering.read on core-platform.",
    );
    const request = within(denied).getByRole("button", {
      name: "Request access",
    });
    expect(request.hasAttribute("disabled")).toBe(true);
    expect(
      within(denied)
        .getByRole("link", { name: "Back to Fleet" })
        .getAttribute("href"),
    ).toBe("/acme/core-platform");
    expect(denied.textContent).toContain("Signed in as");
    expect(denied.textContent).toContain("Marcus Bell · workspace.member");
    expect(denied.textContent).toContain("deny wins over every allow");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("says a parked read is waiting, and names the request", async () => {
    await renderRecord({
      record: {
        ok: false,
        reason: "pending_approval",
        accessRequestId: "arq_01k5",
      },
    });
    expect(screen.getByTestId("record-pending").textContent).toContain(
      "arq_01k5",
    );
  });

  it("names the code, says nothing changed, and offers Try again and Open an incident", async () => {
    await renderRecord({
      record: readError("record_index_unavailable", 503),
    });
    const error = screen.getByTestId("record-error");
    expect(within(error).getByRole("heading").textContent).toBe(
      "This record could not be loaded",
    );
    expect(error.textContent).toContain(
      "The control plane answered 503 record_index_unavailable. Nothing was changed. Runs kept recording while this page was down.",
    );
    expect(
      within(error)
        .getByRole("link", { name: "Try again" })
        .getAttribute("href"),
    ).toBe(`/acme/core-platform/steering/records/${LINEAGE}`);
    expect(
      within(error)
        .getByRole("button", { name: "Open an incident" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByTestId("record-error-trace").textContent).toMatch(
      /^trace not recorded · /,
    );
  });

  it("draws a textless skeleton while the read is in flight", () => {
    render(
      <IntlProvider>
        <RecordLoading />
      </IntlProvider>,
    );
    const loading = screen.getByRole("status");
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.textContent).toBe("");
    // Every bone is the design's shimmer, as on every other page, and none pulses.
    expect(loading.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    expect(loading.querySelector(".animate-pulse")).toBeNull();
  });
});

describe("Record › reads that did not answer and facts a record lacks", () => {
  it("says the pull request goes to the main repo, and names the file alone, when the freshness read failed", async () => {
    const user = userEvent.setup();
    await renderRecord({
      freshness: readError("steering_unavailable", 503),
      proposals: readError("proposals_unavailable", 503),
    });
    expect(screen.getByTestId("record-editor-note").textContent).toContain(
      "a pull request against the main repo.",
    );
    expect(
      screen.getByTestId("record-lineage").querySelector('[data-fact="file"]')
        ?.textContent,
    ).toBe(`.oxagen/rules/${LINEAGE}.toml`);
    // A proposals read that failed is no open proposal.
    expect(
      screen.getByTestId("record-chips").querySelector('[data-term="pending"]'),
    ).toBeNull();
    await user.click(screen.getByTestId("record-archive-open"));
    expect(
      screen.getByTestId("record-archive").querySelector("#record-archive-gap")
        ?.textContent,
    ).not.toContain("acme/platform");
  });

  it("names the branch it would open for a proposal whose pull request has not opened", async () => {
    await renderRecord({
      proposals: readOk({
        proposals: [
          proposal({ lineage: LINEAGE, status: "proposed", pr: null }),
        ],
        total: 1,
      }),
    });
    expect(
      screen.getByTestId("record-chips").querySelector('[data-term="pending"]')
        ?.textContent,
    ).toBe(`context/${LINEAGE}`);
  });

  it("counts no published records for a constraint when that list read failed", async () => {
    const { calls } = await renderRecord({
      record: readOk(ofKind("constraint")),
      records: readError("records_unavailable", 503),
    });
    expect(calls.records).toHaveLength(2);
    const panel = screen.getByTestId("record-kind-panel");
    expect(panel.textContent).toContain(
      "Every merge re-runs the conflict check across every published record.",
    );
    expect(panel.textContent).not.toMatch(/across all \d+ published records/);
  });

  it("leads with the title and the file's usual path when the record states no statement, force or path", async () => {
    await renderRecord({
      record: readOk(
        recordDetail({
          record: {
            ...publishedRecord({ statement: null, force: null, path: null }),
            status: "active",
          },
        }),
      ),
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Read CHANGELOG.md once per run",
    );
    expect(
      screen.getByTestId("record-chips").querySelector('[data-term="force"]'),
    ).toBeNull();
    expect(
      screen.getByTestId<HTMLTextAreaElement>("record-statement").value,
    ).toBe("");
    expect(
      screen.getByTestId("record-editor").getAttribute("aria-label"),
    ).toContain(`.oxagen/rules/${LINEAGE}.toml`);
  });

  it("prints the commit alone when the record carries no publication date", async () => {
    await renderRecord({
      record: readOk(
        recordDetail({
          provenance: null,
          record: {
            ...publishedRecord({ publishedAt: null }),
            status: "active",
          },
        }),
      ),
    });
    expect(
      screen
        .getByTestId("record-lineage")
        .querySelector('[data-fact="published"]')?.textContent,
    ).toBe("4d5e6f7");
  });

  it("names the viewer by email, then by id, when the session has no name (negative)", async () => {
    session.mockResolvedValue({
      user: { name: null, email: "marcus@acme.test" },
    });
    await renderRecord({
      record: { ok: false, reason: "denied", permission: "steering.read" },
    });
    expect(screen.getByTestId("record-denied").textContent).toContain(
      "marcus@acme.test · workspace.member",
    );
    cleanup();
    session.mockResolvedValue(null);
    await renderRecord({
      record: { ok: false, reason: "denied", permission: "steering.read" },
    });
    expect(screen.getByTestId("record-denied").textContent).toContain(
      "usr_marcusbell · workspace.member",
    );
  });

  it("draws a rule's constraint effect in its own tone, forbid apart from require", () => {
    const rule = (constraintEffect: "forbid" | "require") => (
      <KindPanel
        detail={recordDetail({
          record: {
            ...publishedRecord({ kind: "rule", constraintEffect }),
            status: "active",
          },
        })}
        bundleVersion={4}
        publishedTotal={null}
      />
    );
    const view = render(<IntlProvider>{rule("forbid")}</IntlProvider>);
    const panel = screen.getByTestId("record-kind-panel");
    expect(panel.textContent).toContain("forbid");
    view.rerender(<IntlProvider>{rule("require")}</IntlProvider>);
    expect(screen.getByTestId("record-kind-panel").textContent).toContain(
      "require",
    );
  });

  it("dates a fact from its publication without a commit it cannot read", () => {
    render(
      <IntlProvider>
        <KindPanel
          detail={recordDetail({
            provenance: null,
            record: {
              ...publishedRecord({ kind: "fact", commit: null }),
              status: "active",
            },
          })}
          bundleVersion={null}
          publishedTotal={null}
        />
      </IntlProvider>,
    );
    const validFrom = screen
      .getByTestId("record-kind-panel")
      .querySelector('[data-fact="valid-from"]');
    expect(validFrom?.textContent).toContain("Sep 12, 2026");
    expect(validFrom?.textContent).not.toContain("4d5e6f7");
  });
});
