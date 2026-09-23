// @vitest-environment jsdom
// What the record page says when something did not answer (#3395), and what it
// says when a field the mockup shows was never recorded.
//
// record.test.tsx proves the page a healthy read draws. This file covers the
// other side: the sentence a refused revision shows, the sentence a panel
// shows when its own read failed, and the blanks the lineage panel prints
// rather than inventing a value. Each rendered case ends in an axe check
// (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RecordKind } from "@/data/contracts/steering";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { LINEAGE, publishedRecord, recordDetail } from "@/test/steering-views";
import { KindPanel } from "./kind-panel";
import { LineagePanel } from "./lineage-panel";
import { RecordReadFailure } from "./read-failure";
import { Related } from "./related";
import { useReviseFailure } from "./revise-failure";

const at = { org: "acme", ws: "core-platform", lineage: LINEAGE };

type Refusal = Parameters<ReturnType<typeof useReviseFailure>>[0];

/** Reads the hook the way the statement editor does, and prints its sentence. */
function Refused({ failure }: { failure: Refusal }) {
  const say = useReviseFailure();
  return <p data-testid="refusal">{say(failure)}</p>;
}

function refusalText(failure: Refusal): string {
  render(
    <IntlProvider>
      <Refused failure={failure} />
    </IntlProvider>,
  );
  return screen.getByTestId("refusal").textContent;
}

/** Each refusal the editor can receive, with the sentence it has to show. */
const REFUSALS: [Refusal, string][] = [
  [
    { ok: false, reason: "denied", code: "org_role_required" },
    "Your role cannot propose a change to this record.",
  ],
  [
    { ok: false, reason: "denied", code: "no_principal" },
    "Oxagen could not tell who is signed in.",
  ],
  [
    { ok: false, reason: "not_found", code: "record_not_found" },
    "This workspace holds no record on that lineage.",
  ],
  [
    { ok: false, reason: "conflict", code: "record_unclassified" },
    "This record states no kind, force or scope",
  ],
  [
    { ok: false, reason: "conflict", code: "constraint_effect_unknown" },
    "This constraint records no require or forbid effect.",
  ],
  [
    { ok: false, reason: "conflict", code: "lineage_pr_open" },
    "A change is already open on this record.",
  ],
  [
    { ok: false, reason: "denied", code: "workspace_repository_missing" },
    "This workspace has no repository bound",
  ],
  [
    { ok: false, reason: "denied", code: "governance_unreadable" },
    "Oxagen could not read governance.toml on the production branch.",
  ],
  [
    { ok: false, reason: "denied", code: "github_refused" },
    "GitHub refused the write.",
  ],
];

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

// `revise_context_record` refuses on its own two reasons and then hands the
// proposal to `open_context_pr`, so every reason that call throws reaches the
// editor too. Each one has to name what the reader can do next.
describe("useReviseFailure › the reason the write gives", () => {
  it.each(REFUSALS)("names what %j means", (failure, sentence) => {
    expect(refusalText(failure)).toContain(sentence);
  });

  // A code nobody has written a sentence for is printed with the code
  // attached. The code is what a reader pastes into an incident, so flattening
  // it into "something went wrong" would throw away the only useful part.
  it("prints an unknown code rather than flattening it", () => {
    const text = refusalText({
      ok: false,
      reason: "conflict",
      code: "shard_rebalancing",
    });
    expect(text).toContain("shard_rebalancing");
  });

  it("asks you to check the statement when the input was invalid", () => {
    expect(
      refusalText({ ok: false, reason: "invalid", code: "statement_empty" }),
    ).toContain("Oxagen refused the statement.");
  });

  it("names the access request when the write parked for approval", () => {
    const text = refusalText({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "acr_7k2m9q4x",
    });
    expect(text).toContain("acr_7k2m9q4x");
  });

  it("names the code when the workspace is out of GAUs", () => {
    const text = refusalText({
      ok: false,
      reason: "exhausted",
      code: "budget_exceeded",
    });
    expect(text).toContain("budget_exceeded");
  });

  it("names the code when the write did not answer at all", () => {
    const text = refusalText({
      ok: false,
      reason: "unavailable",
      code: "action_failed",
    });
    expect(text).toContain("action_failed");
  });
});

// A panel whose own read did not answer replaces its body, never the page, so
// the record still reads when the panel beside it could not be filled.
describe("RecordReadFailure › the sentence a panel shows", () => {
  it("names the permission a denied read needed", () => {
    render(
      <IntlProvider>
        <RecordReadFailure
          read={{ ok: false, reason: "denied", permission: "steering.read" }}
          section="Related records"
        />
      </IntlProvider>,
    );
    const text = screen.getByText(/Related records/);
    expect(text).toHaveAttribute("data-reason", "denied");
    expect(text.textContent).toContain("steering.read");
  });

  it("names the access request a parked read is waiting on", () => {
    render(
      <IntlProvider>
        <RecordReadFailure
          read={{
            ok: false,
            reason: "pending_approval",
            accessRequestId: "acr_3v8p1n6b",
          }}
          section="Related records"
        />
      </IntlProvider>,
    );
    const text = screen.getByText(/Related records/);
    expect(text).toHaveAttribute("data-reason", "pending_approval");
    expect(text.textContent).toContain("acr_3v8p1n6b");
  });

  it("names the code an errored read answered", () => {
    render(
      <IntlProvider>
        <RecordReadFailure
          read={readError("steering_unavailable", 503)}
          section="Related records"
        />
      </IntlProvider>,
    );
    const text = screen.getByText(/Related records/);
    expect(text).toHaveAttribute("data-reason", "error");
    expect(text.textContent).toContain("steering_unavailable");
  });
});

describe("Related › a read that did not answer", () => {
  it("replaces the panel body and leaves the panel standing", () => {
    render(
      <IntlProvider>
        <Related
          at={at}
          kind="constraint"
          read={readError("steering_unavailable", 503)}
        />
      </IntlProvider>,
    );
    const panel = screen.getByTestId("record-related");
    expect(within(panel).getByText(/could not be loaded/)).toHaveAttribute(
      "data-reason",
      "error",
    );
  });

  // A record no Context PR classified carries no statement, so the card falls
  // back to the title. Without the fallback the card would draw an empty line.
  it("falls back to the title on a record with no statement", () => {
    render(
      <IntlProvider>
        <Related
          at={at}
          kind="constraint"
          read={readOk({
            records: [
              publishedRecord(),
              publishedRecord({
                id: "ctr_untitled",
                lineage: "ctx.other.unstated",
                statement: null,
                title: "Read CHANGELOG.md once per run",
              }),
            ],
            total: 2,
          })}
        />
      </IntlProvider>,
    );
    const panel = screen.getByTestId("record-related");
    expect(panel.textContent).toContain("Read CHANGELOG.md once per run");
  });
});

// Each kind panel states a fact the record does not carry as not recorded.
// A panel that guessed instead would read as something the repository said.
describe("KindPanel › a field the record never stated", () => {
  /** The detail a panel of `kind` reads, with everything unrecorded. */
  const bare = (kind: RecordKind) =>
    recordDetail({
      record: {
        ...publishedRecord({
          kind,
          force: null,
          constraintEffect: null,
          statement: null,
          publishedAt: null,
        }),
        status: "active",
      },
      provenance: null,
      effect: null,
    });

  const renderPanel = (kind: RecordKind) =>
    render(
      <IntlProvider>
        <KindPanel detail={bare(kind)} />
      </IntlProvider>,
    );

  it("cannot place a rule whose force is unstated", () => {
    renderPanel("rule");
    const placement = document.querySelector("[data-placement]");
    expect(placement).toHaveAttribute("data-placement", "relevance");
    expect(placement?.textContent).toContain("no force");
  });

  it("reads a constraint with no effect as an unknown boundary", () => {
    renderPanel("constraint");
    expect(screen.getByTestId("record-boundary")).toHaveAttribute(
      "data-effect",
      "unknown",
    );
  });

  it("draws no steps for a procedure with no statement", () => {
    renderPanel("procedure");
    expect(screen.queryByTestId("record-steps")).toBeNull();
    expect(
      document.querySelector('[data-state="not-recorded"]'),
    ).not.toBeNull();
  });

  const DATED: RecordKind[] = ["fact", "memory"];

  it.each(DATED)(
    "leaves the %s panel's date and count blank rather than zero",
    (kind) => {
      renderPanel(kind);
      const when = document.querySelector(
        kind === "fact" ? '[data-fact="valid-from"]' : '[data-fact="when"]',
      );
      const count = document.querySelector(
        kind === "fact" ? '[data-fact="read"]' : '[data-fact="recalled"]',
      );
      expect(when?.textContent).not.toContain("1970");
      expect(count?.textContent).not.toMatch(/\b0\b/);
    },
  );
});

// A blank is honest where a value was never recorded. An invented "unknown"
// author or a zero version would read as a fact the repository never stated.
describe("LineagePanel › what was never recorded", () => {
  it("says so for the path, the author's login, the summary, and the version", () => {
    render(
      <IntlProvider>
        <LineagePanel
          detail={recordDetail({
            record: {
              ...publishedRecord({ path: null, version: null }),
              status: "active",
            },
            provenance: {
              commit: "4d5e6f7a8b9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e",
              authorName: "Dana Reyes",
              authorLogin: null,
              committedAt: "2026-09-12T09:16:40.000Z",
              summary: "",
            },
          })}
        />
      </IntlProvider>,
    );
    const panel = screen.getByTestId("record-lineage");
    expect(
      within(panel)
        .getByText(
          (_, node) => node?.getAttribute("data-state") === "not-recorded",
        )
        .closest("[data-fact]"),
    ).toHaveAttribute("data-fact", "path");
    // The author reads as the name alone, with no login in parentheses.
    const author = within(panel).getByText("Dana Reyes").closest("[data-fact]");
    expect(author).toHaveAttribute("data-fact", "author");
    expect(author?.textContent).not.toContain("(");
    // A blank summary and a null version draw no fact at all.
    expect(panel.querySelector('[data-fact="summary"]')).toBeNull();
    expect(panel.querySelector('[data-fact="version"]')).toBeNull();
  });
});
