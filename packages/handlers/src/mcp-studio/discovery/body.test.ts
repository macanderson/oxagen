// body.test.ts: the title, body, and commit message of a sync steering PR
// (lane M10, #4682). Each case builds a tool surface diff by hand and checks
// the lines that carry meaning, so no case pins the whole body.
import { describe, expect, it } from "vitest";
import type {
  BreakingChange,
  ServerSource,
  ToolSurfaceDiff,
  ToolSurfaceDiffEntry,
} from "@oxagen/mcp-studio";
import {
  renderDiff,
  syncBody,
  syncCommitMessage,
  syncTitle,
  type DroppedTool,
  type SyncPullRequestText,
} from "./body";
import type { DiscoveryTrigger } from "./types";

type ChangedEntry = Extract<ToolSurfaceDiffEntry, { change: "changed" }>;
type RemovedEntry = Extract<ToolSurfaceDiffEntry, { change: "removed" }>;

const ORIGIN = "openapi.yaml changed at aintel/billing-service@4be91d2";
const HEADER = `tools/servers/billing  ${ORIGIN}`;
const DEFINITIONS =
  "Definitions: 6,120 → 6,410 tokens per request (budget 8,000)";
const CURRENCY = "new required input: currency (string, ISO 4217)";
const NOT_WITHHELD =
  "No tool is withheld. The gateway serves the locked definitions until this PR merges.";
const WITHHELD_INTRO =
  "The gateway withholds these tools until this PR merges, because a call built for the old definition may do something else:";
const DROPPED_INTRO =
  "tools.toml still imports these tools, and they no longer compile against what the source offers. The new lock leaves them out. Change or remove each one in tools.toml on this branch before merge, or the compile check fails:";
const OFFERED_NOTE =
  "New tools are listed and left unimported. To import one, add it to tools.toml on this branch.";
const INTRO =
  "Discovery found that the source of Billing API (`tools/servers/billing`) no longer matches its lock. This steering PR carries the new lock.";
const RUN = "Discovery ran on the server's schedule at 2026-09-26 03:00 UTC.";

// ── Builders ─────────────────────────────────────────────────────────────────

function breaking(
  detail: string,
  reason: BreakingChange["reason"] = "new_required_input",
): BreakingChange {
  return { reason, detail };
}

function offered(upstream: string): ToolSurfaceDiffEntry {
  return { change: "offered", upstream };
}

function added(key: string, version = 1): ToolSurfaceDiffEntry {
  return { change: "added", key, tool: `billing__${key}`, version };
}

function changed(
  key: string,
  overrides: Partial<Omit<ChangedEntry, "change" | "key" | "tool">> = {},
): ChangedEntry {
  return {
    change: "changed",
    key,
    tool: `billing__${key}`,
    version: { served: 3, proposed: 3 },
    breaking: [],
    description: undefined,
    notes: [],
    ...overrides,
  };
}

function removed(
  key: string,
  overrides: Partial<Omit<RemovedEntry, "change" | "key" | "tool">> = {},
): RemovedEntry {
  return {
    change: "removed",
    key,
    tool: `billing__${key}`,
    breaking: [
      breaking("operation removed from the document", "removed_tool"),
    ],
    notes: [],
    ...overrides,
  };
}

function diffOf(
  entries: ToolSurfaceDiffEntry[],
  tokens = { served: 6120, proposed: 6410, budget: 8000 },
): ToolSurfaceDiff {
  return {
    server: "billing",
    entries,
    tokens,
    breaking: entries.some(
      (entry) => "breaking" in entry && entry.breaking.length > 0,
    ),
  };
}

function textOf(
  overrides: Partial<SyncPullRequestText> = {},
): SyncPullRequestText {
  return {
    server: "billing",
    label: "Billing API",
    sourceType: "openapi",
    origin: ORIGIN,
    diff: diffOf([]),
    withheld: [],
    dropped: [],
    version: undefined,
    trigger: "schedule",
    at: new Date("2026-09-26T03:00:00Z"),
    machine: null,
    ...overrides,
  };
}

function linesOf(input: SyncPullRequestText): string[] {
  return renderDiff(input).split("\n");
}

/** The spec's example: one new operation, and one breaking change the gateway withholds. */
const SPEC_EXAMPLE = textOf({
  diff: diffOf([
    changed("create_refund", {
      version: { served: 3, proposed: 4 },
      breaking: [breaking(CURRENCY)],
    }),
    offered("list_disputes"),
  ]),
  withheld: ["billing__create_refund"],
});

// ── renderDiff ───────────────────────────────────────────────────────────────

describe("renderDiff", () => {
  it("renders the spec's example line for line", () => {
    expect(linesOf(SPEC_EXAMPLE)).toEqual([
      HEADER,
      "",
      "  + list_disputes            new operation, not imported",
      "  ~ billing__create_refund   3 → 4   breaking, withheld until merge",
      `      ${CURRENCY}`,
      "",
      DEFINITIONS,
    ]);
  });

  it("shows a description change as the served text and the proposed text", () => {
    const lines = linesOf(
      textOf({
        diff: diffOf([
          changed("create_refund", {
            description: {
              served: "Refund a charge.",
              proposed: "Refund a charge, fully or in part.",
            },
          }),
        ]),
      }),
    );

    expect(lines.slice(2, 5)).toEqual([
      "  ~ billing__create_refund   description changed, serving the locked one",
      "      - Refund a charge.",
      "      + Refund a charge, fully or in part.",
    ]);
  });

  it.each<[string, Partial<ChangedEntry>, readonly string[], string]>([
    [
      "a breaking change the gateway still serves",
      { version: { served: 3, proposed: 4 }, breaking: [breaking(CURRENCY)] },
      [],
      "3 → 4   breaking",
    ],
    [
      "a breaking change at the same version",
      { breaking: [breaking(CURRENCY)] },
      ["billing__create_refund"],
      "breaking, withheld until merge",
    ],
    [
      "a withheld tool with no breaking change",
      {},
      ["billing__create_refund"],
      "input changed, withheld until merge",
    ],
    [
      "a version move alone",
      { version: { served: 3, proposed: 4 } },
      [],
      "3 → 4",
    ],
    [
      "a breaking change and a new description",
      {
        breaking: [breaking(CURRENCY)],
        description: { served: "Old.", proposed: "New." },
      },
      [],
      "breaking",
    ],
  ])("summarizes %s", (_label, overrides, withheld, summary) => {
    const lines = linesOf(
      textOf({
        diff: diffOf([changed("create_refund", overrides)]),
        withheld,
      }),
    );

    expect(lines[2]).toBe(`  ~ billing__create_refund   ${summary}`);
  });

  it("lists a tool the proposed lock adds, with its version", () => {
    const lines = linesOf(textOf({ diff: diffOf([added("list_disputes")]) }));

    expect(lines[2]).toBe(
      "  + billing__list_disputes   new in the lock, version 1",
    );
    expect(lines[3]).toBe("");
  });

  it.each<[string, readonly string[], string]>([
    ["withheld", ["billing__void_invoice"], "breaking, withheld until merge"],
    ["served", [], "breaking"],
  ])(
    "lists a removed tool the gateway has %s, with why",
    (_label, withheld, summary) => {
      const lines = linesOf(
        textOf({
          diff: diffOf([
            removed("void_invoice", {
              notes: ["tools.toml imports it as void_invoice"],
            }),
          ]),
          withheld,
        }),
      );

      expect(lines.slice(2, 5)).toEqual([
        `  - billing__void_invoice   ${summary}`,
        "      operation removed from the document",
        "      tools.toml imports it as void_invoice",
      ]);
    },
  );

  it("says no tool changed when the diff is empty", () => {
    expect(linesOf(textOf())).toEqual([
      HEADER,
      "",
      "  (no tool changed)",
      "",
      DEFINITIONS,
    ]);
  });

  it("sorts new, added, changed, then removed, by name, and aligns every summary", () => {
    const lines = linesOf(
      textOf({
        diff: diffOf([
          removed("void_invoice"),
          changed("create_refund", { version: { served: 3, proposed: 4 } }),
          offered("list_disputes"),
          added("get_balance"),
          offered("export_ledger"),
        ]),
      }),
    );
    const rows = lines.slice(2, 7);

    // The longest name is billing__create_refund, so each summary starts at
    // column 29: the four-character prefix, 22 characters, and a gap of 3.
    expect(rows.map((row) => row.slice(0, 29).trimEnd())).toEqual([
      "  + export_ledger",
      "  + list_disputes",
      "  + billing__get_balance",
      "  ~ billing__create_refund",
      "  - billing__void_invoice",
    ]);
    expect(rows.map((row) => row.slice(29))).toEqual([
      "new operation, not imported",
      "new operation, not imported",
      "new in the lock, version 1",
      "3 → 4",
      "breaking",
    ]);
    expect(lines[7]).toBe("      operation removed from the document");
  });

  it("prints a changed tool with nothing to summarize as its name alone", () => {
    const note = "response field data[].fee added (not in select, not returned)";
    const lines = linesOf(
      textOf({ diff: diffOf([changed("list_charges", { notes: [note] })]) }),
    );

    expect(lines.slice(2, 4)).toEqual([
      "  ~ billing__list_charges",
      `      ${note}`,
    ]);
  });

  it("folds whitespace in a description and cuts one past 240 characters", () => {
    const lines = linesOf(
      textOf({
        diff: diffOf([
          changed("create_refund", {
            description: {
              served: "  Refund\n  a   charge.\t",
              proposed: "x".repeat(300),
            },
          }),
          changed("list_charges", {
            description: { served: "y".repeat(240), proposed: undefined },
          }),
        ]),
      }),
    );

    expect(lines).toContain("      - Refund a charge.");
    expect(lines).toContain(`      + ${"x".repeat(239)}…`);
    expect(lines).toContain(`      - ${"y".repeat(240)}`);
    expect(lines).toContain("      + (none)");
  });

  it("writes (none) for an empty origin", () => {
    expect(linesOf(textOf({ origin: "  " }))[0]).toBe(
      "tools/servers/billing  (none)",
    );
  });

  it("writes token counts with thousands separators", () => {
    const lines = linesOf(
      textOf({
        diff: diffOf([], { served: 12000, proposed: 1234567, budget: 8000 }),
      }),
    );

    expect(lines.at(-1)).toBe(
      "Definitions: 12,000 → 1,234,567 tokens per request (budget 8,000)",
    );
  });

  it.each<[ServerSource["type"], string]>([
    ["openapi", "operation"],
    ["graphql", "field"],
    ["grpc", "method"],
    ["remote", "tool"],
    ["registry", "tool"],
    ["local", "tool"],
  ])("names a new entry from the %s source with the word %s", (sourceType, noun) => {
    const lines = linesOf(
      textOf({ sourceType, diff: diffOf([offered("list_disputes")]) }),
    );

    expect(lines[2]).toBe(`  + list_disputes   new ${noun}, not imported`);
  });
});

// ── syncTitle ────────────────────────────────────────────────────────────────

describe("syncTitle", () => {
  it("names the source, or the version a registry server moves to", () => {
    expect(syncTitle(textOf())).toBe("Sync billing with its source");
    expect(
      syncTitle(textOf({ version: { from: "1.4.0", to: "1.5.0" } })),
    ).toBe("Sync billing with version 1.5.0");
  });
});

// ── syncBody ─────────────────────────────────────────────────────────────────

describe("syncBody", () => {
  it("opens with the server's label and folder, then the diff in a text fence", () => {
    const body = syncBody(SPEC_EXAMPLE);

    expect(body.startsWith(`${INTRO}\n\n\`\`\`text\n${HEADER}\n`)).toBe(true);
    expect(body).toContain(`\`\`\`text\n${renderDiff(SPEC_EXAMPLE)}\n\`\`\``);
  });

  it("names each withheld tool and says why the gateway withholds it", () => {
    const body = syncBody(SPEC_EXAMPLE);

    expect(body).toContain(
      `${WITHHELD_INTRO}\n\n- \`billing__create_refund\``,
    );
    expect(body).not.toContain(NOT_WITHHELD);
  });

  it("names every withheld tool in its own bullet", () => {
    const body = syncBody(
      textOf({
        diff: diffOf([
          changed("create_refund", { breaking: [breaking(CURRENCY)] }),
          removed("void_invoice"),
        ]),
        withheld: ["billing__create_refund", "billing__void_invoice"],
      }),
    );

    expect(body).toContain(
      "- `billing__create_refund`\n- `billing__void_invoice`",
    );
  });

  it("says no tool is withheld when none is", () => {
    const body = syncBody(textOf());

    expect(body).toContain(NOT_WITHHELD);
    expect(body).not.toContain(WITHHELD_INTRO);
  });

  it("lists each dropped tools.toml entry with every reason", () => {
    const dropped: DroppedTool[] = [
      {
        key: "void_invoice",
        reasons: [
          "The operation voidInvoice is gone.",
          "Remove it from tools.toml.",
        ],
      },
      { key: "list_refunds", reasons: ["select names refund.fee."] },
    ];
    const body = syncBody(
      textOf({ diff: diffOf([removed("void_invoice")]), dropped }),
    );

    expect(body).toContain(
      [
        DROPPED_INTRO,
        "",
        "- `void_invoice`: The operation voidInvoice is gone. Remove it from tools.toml.",
        "- `list_refunds`: select names refund.fee.",
      ].join("\n"),
    );
  });

  it("leaves out the dropped section when nothing is dropped", () => {
    expect(syncBody(SPEC_EXAMPLE)).not.toContain(DROPPED_INTRO);
  });

  it("adds a note on importing only when the source offers a new tool", () => {
    expect(syncBody(SPEC_EXAMPLE)).toContain(OFFERED_NOTE);
    expect(
      syncBody(textOf({ diff: diffOf([added("list_disputes")]) })),
    ).not.toContain(OFFERED_NOTE);
  });

  it("says a registry server's version moves with the lock", () => {
    const input = textOf({
      sourceType: "registry",
      origin: "the registry catalog moved io.github.aintel/billing to 1.5.0",
      version: { from: "1.4.0", to: "1.5.0" },
      trigger: "registry_version",
    });
    const body = syncBody(input);

    expect(
      body.startsWith(
        `${INTRO} It also moves source.version in server.toml from 1.4.0 to 1.5.0, so the lock and the version change together.\n\n`,
      ),
    ).toBe(true);
    expect(body.split("\n\n").at(-1)).toBe(
      "Discovery ran on a new version in the registry catalog at 2026-09-26 03:00 UTC.\n",
    );
    expect(syncCommitMessage(input).split("\n")[0]).toBe(
      "Sync billing with version 1.5.0",
    );
  });

  it("puts the sections in order, each once, with one blank line between them", () => {
    const input = textOf({
      diff: diffOf([
        offered("list_disputes"),
        changed("create_refund", { breaking: [breaking(CURRENCY)] }),
        removed("void_invoice"),
      ]),
      withheld: ["billing__create_refund"],
      dropped: [{ key: "void_invoice", reasons: ["It is gone."] }],
    });
    const body = syncBody(input);
    const sections = [
      INTRO,
      "```text",
      WITHHELD_INTRO,
      DROPPED_INTRO,
      OFFERED_NOTE,
      RUN,
    ];
    const at = sections.map((section) => body.indexOf(section));

    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const section of sections) {
      expect(body.split(section)).toHaveLength(2);
    }
    expect(body).not.toContain("\n\n\n");
    expect(body).toContain(`\n\`\`\`\n\n${WITHHELD_INTRO}\n\n- `);
    expect(body).toContain(`\`billing__create_refund\`\n\n${DROPPED_INTRO}`);
    expect(body).toContain(`It is gone.\n\n${OFFERED_NOTE}\n\n${RUN}\n`);
    expect(body.endsWith(`${RUN}\n`)).toBe(true);
  });

  it("uses a fence longer than any run of backticks in the diff", () => {
    const input = textOf({
      diff: diffOf([
        changed("create_refund", { notes: ["the example ````json```` moved"] }),
      ]),
    });

    expect(syncBody(input)).toContain(
      `\`\`\`\`\`text\n${renderDiff(input)}\n\`\`\`\`\`\n`,
    );
  });

  it.each<[DiscoveryTrigger, string]>([
    ["schedule", "the server's schedule"],
    ["list_changed", "the server's tools/list_changed notification"],
    ["push", "a push that changed the definition"],
    ["registry_version", "a new version in the registry catalog"],
    ["manual", "a request from Studio"],
    ["lock_merged", "a merged steering PR for this server"],
  ])("ends with the run line for the %s trigger", (trigger, text) => {
    const body = syncBody(
      textOf({ trigger, at: new Date("2026-09-26T03:00:59.999Z") }),
    );

    expect(body.split("\n\n").at(-1)).toBe(
      `Discovery ran on ${text} at 2026-09-26 03:00 UTC.\n`,
    );
  });

  it("names the machine that reported a local server's tools", () => {
    const body = syncBody(
      textOf({ sourceType: "local", machine: "mac-studio-7" }),
    );

    expect(body.split("\n\n").at(-1)).toBe(
      `${RUN} Machine mac-studio-7 reported the tools.\n`,
    );
  });
});

// ── syncCommitMessage ────────────────────────────────────────────────────────

describe("syncCommitMessage", () => {
  it("counts changed, removed, added, and offered tools in that order", () => {
    const message = syncCommitMessage(
      textOf({
        diff: diffOf([
          offered("list_disputes"),
          added("get_balance"),
          offered("export_ledger"),
          removed("void_invoice"),
          changed("create_refund", { breaking: [breaking(CURRENCY)] }),
          offered("list_payouts"),
          changed("list_charges", { version: { served: 1, proposed: 2 } }),
        ]),
      }),
    );

    expect(message.split("\n")[2]).toBe(
      "Tools: 2 changed, 1 removed, 1 added, 3 offered and not imported.",
    );
  });

  it("names the withheld tools after the counts", () => {
    expect(syncCommitMessage(SPEC_EXAMPLE)).toBe(
      "Sync billing with its source\n\nTools: 1 changed, 1 offered and not imported.\nWithheld until merge: billing__create_refund.\n",
    );
  });

  it("joins two withheld tools with a comma", () => {
    const message = syncCommitMessage(
      textOf({
        diff: diffOf([
          changed("create_refund", { breaking: [breaking(CURRENCY)] }),
          removed("void_invoice"),
        ]),
        withheld: ["billing__create_refund", "billing__void_invoice"],
      }),
    );

    expect(message.split("\n").slice(2)).toEqual([
      "Tools: 1 changed, 1 removed.",
      "Withheld until merge: billing__create_refund, billing__void_invoice.",
      "",
    ]);
  });

  it("says the lock records the new source when no tool changed", () => {
    expect(syncCommitMessage(textOf())).toBe(
      "Sync billing with its source\n\nNo tool changed. The lock records the new source.\n",
    );
  });

  it("leaves out the withheld line when nothing is withheld", () => {
    expect(
      syncCommitMessage(
        textOf({ diff: diffOf([added("list_disputes")]) }),
      ),
    ).toBe("Sync billing with its source\n\nTools: 1 added.\n");
  });
});
