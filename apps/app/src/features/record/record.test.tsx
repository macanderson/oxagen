// @vitest-environment jsdom
// The record page over a fake DataSource (#3395): the address it accepts, the
// six kinds each drawing their own panel, the provenance it reads from the
// publishing commit, the counters it refuses to zero, and the one write it
// offers. Each render carries an axe check (INV-26).
//
// What the write does is proven in packages/handlers/src/context.record.page.test.ts,
// where a pull request opens, changes one file and merges. This suite is about
// what the page renders and what it declines to claim.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
vi.mock("./actions", () => ({ reviseRecord: vi.fn() }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Record, RecordLoading } = await import("./record");
const { Related, RELATED_SHOWN } = await import("./related");

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
  // builder's default proposal is on this same lineage, which would withhold
  // the write on every render.
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

/** The record's detail with its kind swapped, for the six-panel sweep. */
function ofKind(kind: RecordKind): RecordDetail {
  return recordDetail({
    record: {
      ...publishedRecord({
        kind,
        constraintEffect: kind === "constraint" ? "forbid" : null,
      }),
      status: "active",
    },
  });
}

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Record › the address", () => {
  it("reads the one record the lineage names", async () => {
    const { calls } = await renderRecord();
    expect(calls.record).toEqual([[ctx, LINEAGE]]);
  });

  it("asks only for the proposals raised on this lineage", async () => {
    const { calls } = await renderRecord();
    expect(calls.proposals).toEqual([[ctx, { offset: 0, lineage: LINEAGE }]]);
  });

  // DoD 1: a lineage that could never name a record is refused before a read.
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

  // DoD 1: a well-formed lineage nothing holds is a 404, not a page error.
  it("raises a not-found when neither the file nor the registry holds it", async () => {
    const { source } = steeringSource({
      record: readError("record_not_found", 404),
    });
    await expect(
      Record({ ctx, source, lineage: "ctx.nothing.holds-this" }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("Record › the record", () => {
  it("makes the statement the headline", async () => {
    await renderRecord();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Do not re-read CHANGELOG.md after the first read in a run.",
      }),
    ).toBeInTheDocument();
  });

  it("reads the kind, force, effect and scope as chips beside it", async () => {
    await renderRecord();
    const terms = ["kind", "force", "constraint-effect", "scope"];
    for (const term of terms) {
      expect(document.querySelector(`[data-term="${term}"]`)).not.toBeNull();
    }
  });

  it("reads a retired record as archived", async () => {
    await renderRecord({
      record: readOk(
        recordDetail({
          record: { ...publishedRecord(), status: "retired" },
        }),
      ),
    });
    expect(document.querySelector('[data-term="status"]')).toHaveAttribute(
      "data-status",
      "retired",
    );
  });
});

// DoD 2: every kind draws a panel of its own. A kind that fell through to a
// generic view would repeat the same panel six times, so the test asserts the
// panel's kind and its own sentence, not just that a panel exists.
describe("Record › the six kinds", () => {
  it.each(RECORD_KINDS)(
    "draws the %s panel and no generic one",
    async (kind) => {
      await renderRecord({ record: readOk(ofKind(kind)) });
      const panel = screen.getByTestId("record-kind-panel");
      expect(panel).toHaveAttribute("data-kind", kind);
      // Each kind states what it can never do, in its own words.
      const never = within(panel).getByTestId("record-kind-never").textContent;
      expect(never).toBeTruthy();
      expect(never).not.toContain("undefined");
    },
  );

  it("draws six different panels across the six kinds", async () => {
    const sentences = new Set<string>();
    for (const kind of RECORD_KINDS) {
      await renderRecord({ record: readOk(ofKind(kind)) });
      sentences.add(screen.getByTestId("record-kind-never").textContent);
      cleanup();
    }
    expect(sentences.size).toBe(RECORD_KINDS.length);
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
    expect(screen.getByTestId("record-kind-panel")).toHaveAttribute(
      "data-kind",
      "unclassified",
    );
  });
});

// DoD 3: provenance is the publishing commit, read from the file's history.
describe("Record › provenance", () => {
  it("names the commit, its author and when it landed", async () => {
    await renderRecord();
    const facts = screen.getByTestId("record-lineage").textContent;
    expect(facts).toContain("4d5e6f7a8b9c");
    expect(facts).toContain("Dana Reyes");
  });

  it("says the history is not recorded rather than showing an empty commit", async () => {
    await renderRecord({ record: readOk(recordDetail({ provenance: null })) });
    const unknown = within(screen.getByTestId("record-lineage")).getByText(
      /could not reach its commit history/,
    );
    expect(unknown).toHaveAttribute("data-state", "not-recorded");
  });

  // DoD 4: the file is the backing, and the page says when it was not.
  it("says the registry answered when the repository could not", async () => {
    await renderRecord({
      record: readOk(recordDetail({ backing: "registry" })),
    });
    expect(screen.getByTestId("record-lineage").textContent).toContain(
      "the repository holds no file",
    );
  });
});

// DoD 7: a counter with no rollup behind it is named, never zeroed. A zero
// would read as every run ignoring the record.
describe("Record › counters", () => {
  it("counts the runs that rendered and cited it", async () => {
    await renderRecord();
    const meters = screen.getByTestId("record-meters").textContent;
    expect(meters).toContain("214");
    expect(meters).toContain("37");
  });

  it("says effect is not recorded when the workspace has no rollup", async () => {
    await renderRecord({ record: readOk(recordDetail({ effect: null })) });
    expect(screen.getByTestId("record-meters")).toHaveAttribute(
      "data-state",
      "not-recorded",
    );
  });
});

// DoD 5: the write is a pull request, and it is offered only where it would be
// accepted. The gate mirrors `revise_context_record` (INV-29).
describe("Record › the write", () => {
  /** Types into the statement, which is what moves the draft off what is in force. */
  async function revise(text = " Always.") {
    const editor = screen.getByRole("textbox", { name: /statement/ });
    await userEvent.type(editor, text);
  }

  // The page opens on the statement in force, so there is nothing to propose
  // until a word changes. Offering the action on an unchanged draft would open
  // a pull request that changes no file.
  it("withholds the write until the statement changes", async () => {
    await renderRecord();
    expect(screen.getByTestId("record-propose-open")).toBeDisabled();
    expect(screen.getByTestId("draft-state").textContent).toContain(
      "Matches what is in force",
    );
  });

  it("offers the change to an org Admin who edited the statement", async () => {
    await renderRecord();
    await revise();
    expect(screen.getByTestId("record-propose-open")).toBeEnabled();
    expect(screen.getByTestId("draft-state").textContent).toContain("Modified");
  });

  it("offers it to a workspace Member whose org role only reads", async () => {
    await renderRecord({}, { as: viewer("viewer", "member") });
    await revise();
    expect(screen.getByTestId("record-propose-open")).toBeEnabled();
  });

  it("refuses it to a role that can read and not change", async () => {
    await renderRecord({}, { as: viewer("viewer", "viewer") });
    await revise();
    expect(screen.getByTestId("record-propose-open")).toBeDisabled();
  });

  // One pull request per lineage: the handler refuses a second, so the page
  // names the open branch instead of offering a write that would be refused.
  it("names the open branch and withholds the write while one is open", async () => {
    await renderRecord({
      proposals: readOk({
        proposals: [proposal({ status: "checks_running" })],
        total: 1,
      }),
    });
    await revise();
    expect(screen.getByTestId("record-propose-open")).toBeDisabled();
    expect(screen.getByTestId("record-pending-note").textContent).toContain(
      `context/${LINEAGE}`,
    );
    expect(document.querySelector('[data-term="pending"]')).not.toBeNull();
  });

  it("offers the write again once the proposal merged", async () => {
    await renderRecord({
      proposals: readOk({
        proposals: [proposal({ status: "merged" })],
        total: 1,
      }),
    });
    await revise();
    expect(screen.getByTestId("record-propose-open")).toBeEnabled();
    expect(screen.queryByTestId("record-pending-note")).toBeNull();
  });

  // A proposal on another lineage is not a change open on this record.
  it("ignores a proposal raised on another lineage", async () => {
    await renderRecord({
      proposals: readOk({
        proposals: [proposal({ lineage: "ctx.other.record" })],
        total: 1,
      }),
    });
    expect(screen.queryByTestId("record-pending-note")).toBeNull();
  });

  // DoD 5: the dialog names the file the pull request changes and the six
  // checks it runs, before anything is opened.
  it("shows the diff and the six checks before it opens anything", async () => {
    await renderRecord();
    await revise();
    await userEvent.click(screen.getByTestId("record-propose-open"));
    const dialog = screen.getByTestId("record-propose");
    expect(within(dialog).getByTestId("record-diff")).toBeInTheDocument();
    for (const check of [
      "schema",
      "lineage_uniqueness",
      "record_hash",
      "secret_pii_scan",
      "conflict_against_active",
      "constraint_effect",
    ]) {
      expect(dialog.querySelector(`[data-check="${check}"]`)).not.toBeNull();
    }
  });
});

// The related panel suspends on its own read, so the record the route names
// never waits on it. It is rendered here directly: an async component inside
// Suspense resolves on the server, and this environment renders the fallback.
describe("Record › other records of this kind", () => {
  const at = { org: "acme", ws: "core-platform", lineage: LINEAGE };

  it("shows up to three others and leaves this record out", () => {
    const others = ["a", "b", "c", "d"].map((suffix) =>
      publishedRecord({
        id: `ctr_${suffix}`,
        lineage: `ctx.other.${suffix}`,
        statement: `Statement ${suffix}.`,
      }),
    );
    render(
      <IntlProvider>
        <Related
          at={at}
          kind="constraint"
          read={readOk({
            records: [publishedRecord(), ...others],
            total: 5,
          })}
        />
      </IntlProvider>,
    );
    const panel = screen.getByTestId("record-related");
    expect(within(panel).getAllByRole("listitem")).toHaveLength(RELATED_SHOWN);
    expect(panel.textContent).not.toContain("CHANGELOG.md");
  });

  it("says this is the only one when no other of the kind is in force", () => {
    render(
      <IntlProvider>
        <Related
          at={at}
          kind="constraint"
          read={readOk({ records: [publishedRecord()], total: 1 })}
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("record-related").textContent).toContain(
      "the only constraint in force",
    );
  });

  it("has nothing to compare an unclassified record with", () => {
    render(
      <IntlProvider>
        <Related at={at} kind={null} read={null} />
      </IntlProvider>,
    );
    const panel = screen.getByTestId("record-related");
    expect(within(panel).getByText(/carries no kind/)).toHaveAttribute(
      "data-state",
      "not-recorded",
    );
  });
});

describe("Record › the not-loaded states", () => {
  it("names the permission a denied read needs", async () => {
    await renderRecord({
      record: { ok: false, reason: "denied", permission: "steering.read" },
    });
    const panel = screen.getByTestId("record-denied");
    expect(panel.textContent).toContain("steering.read");
  });

  it("says a parked read is waiting, and names the request", async () => {
    await renderRecord({
      record: {
        ok: false,
        reason: "pending_approval",
        accessRequestId: "acr_01k5ru4a",
      },
    });
    expect(screen.getByTestId("record-pending").textContent).toContain(
      "acr_01k5ru4a",
    );
  });

  it("prints the code and the instant of a failed read", async () => {
    await renderRecord({ record: readError("upstream_unavailable", 503) });
    const panel = screen.getByTestId("record-error");
    expect(panel.textContent).toContain("upstream_unavailable");
    expect(panel.textContent).toContain("503");
  });

  it("draws a textless skeleton while the read is in flight", () => {
    render(
      <IntlProvider>
        <RecordLoading />
      </IntlProvider>,
    );
    const skeleton = screen.getByRole("status");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton.textContent).toBe("");
  });
});
