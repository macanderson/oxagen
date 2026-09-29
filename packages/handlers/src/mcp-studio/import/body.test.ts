// body.test.ts: the steering PR's title, commit message, and body.
import { describe, expect, it } from "vitest";
import type { BuiltFolder } from "./build";
import { PR_BODY_MAX, reviewBody, reviewCommitMessage, reviewTitle } from "./body";

function folder(fields: Partial<BuiltFolder> = {}): BuiltFolder {
  return {
    server: "billing",
    isNew: false,
    files: new Map(),
    imported: [],
    removed: [],
    reclassified: [],
    described: [],
    tested: [],
    tokens: { definitions: 1200, budget: 8000 },
    findings: [],
    tools: {},
    offered: [],
    ...fields,
  };
}

type Finding = BuiltFolder["findings"][number];

function finding(fields: Partial<Finding> = {}): Finding {
  return {
    rule: "description-missing",
    level: "info",
    tool: "list_charges",
    field: "description",
    message: "The tool has no description.",
    fix: "Describe the tool.",
    ...fields,
  };
}

describe("reviewTitle and reviewCommitMessage", () => {
  it("name a new server and an update apart", () => {
    expect(reviewTitle({ server: "stripe", isNew: true })).toBe("Add the stripe server");
    expect(reviewTitle({ server: "billing", isNew: false })).toBe("Update tools for billing");
  });

  it("count the imports, removals, and reclassifications", () => {
    const built = folder({ imported: ["a", "b"], removed: ["c"] });
    expect(reviewCommitMessage(built, 4)).toBe(
      "Update tools for billing\n\nStudio draft revision 4: 2 imported, 1 removed, 0 reclassified.",
    );
  });
});

describe("reviewBody", () => {
  it("says None for an empty section and leaves out the optional ones", () => {
    const body = reviewBody(folder(), 2);
    expect(body).toContain("Studio's draft for `billing`, revision 2. This steering PR writes `tools/servers/billing/`.");
    expect(body).toContain("## Imported tools\n\nNone.");
    expect(body).toContain("## Removed tools\n\nNone.");
    expect(body).toContain("## Reclassified tools\n\nNone.");
    expect(body).not.toContain("## Changed descriptions");
    expect(body).not.toContain("## Saved tests");
    expect(body).toContain(
      "## Definition tokens\n\nThe imported tools' definitions come to 1200 tokens against a budget of 8000.",
    );
    expect(body).toContain("## Findings\n\nThe tool checks found nothing.");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("lists each reclassification with both classifications", () => {
    const body = reviewBody(
      folder({
        reclassified: [
          {
            tool: "create_refund",
            before: { risk: "high", sideEffect: "irreversible", egress: "org_tenant", impacts: ["moves_money"] },
            after: { risk: "medium", sideEffect: "write", egress: "org_tenant", impacts: [] },
          },
        ],
        described: ["create_refund"],
        tested: ["list_charges"],
      }),
      3,
    );
    expect(body).toContain(
      "- `create_refund` from risk high, side effect irreversible, egress org_tenant, impacts moves_money to risk medium, side effect write, egress org_tenant, no impacts",
    );
    expect(body).toContain("## Changed descriptions\n\n- `create_refund`");
    expect(body).toContain("## Saved tests\n\n- `list_charges`");
  });

  it("says how far a folder is over its definition budget", () => {
    const body = reviewBody(folder({ tokens: { definitions: 9000, budget: 8000 } }), 1);
    expect(body).toContain("come to 9000 tokens against a budget of 8000. The folder is 1000 tokens over budget.");
  });

  it("lists errors before warnings before info", () => {
    const body = reviewBody(
      folder({
        findings: [
          finding({ level: "info", rule: "info-rule" }),
          finding({ level: "error", rule: "error-rule", tool: null, field: null }),
          finding({ level: "warning", rule: "warning-rule", field: null }),
        ],
      }),
      1,
    );
    const at = (rule: string) => body.indexOf(`\`${rule}\``);
    expect(at("error-rule")).toBeLessThan(at("warning-rule"));
    expect(at("warning-rule")).toBeLessThan(at("info-rule"));
    expect(body).toContain("- **error** `error-rule`: The tool has no description. Fix: Describe the tool.");
    expect(body).toContain("- **warning** `warning-rule` on `list_charges`:");
    expect(body).toContain("- **info** `info-rule` on `list_charges.description`:");
  });

  it("shows 200 tools in a section and says how many more follow", () => {
    const imported = Array.from({ length: 201 }, (_, i) => `tool_${i}`);
    const body = reviewBody(folder({ imported }), 1);
    expect(body).toContain("- `tool_199`");
    expect(body).not.toContain("- `tool_200`");
    expect(body).toContain("- 1 more tool follows.");
  });

  it("shortens the lists when the full body is too long for GitHub", () => {
    // Three sections of 200 shown tools at about 210 characters each come to
    // about 126,000 characters. Twenty each come to about 13,000.
    const names = Array.from({ length: 1500 }, (_, i) => `tool_${i}_${"x".repeat(200)}`);
    const body = reviewBody(folder({ imported: names, removed: names, described: names }), 1);
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect(body).toContain("- 1480 more tools follow.");
    expect(body).toContain("## Findings");
    expect(body).not.toContain("The body stops here");
  });

  it("cuts the body when even the short lists are too long", () => {
    // Ten shown findings of 7,000 characters each come to 70,000 characters.
    const findings = Array.from({ length: 200 }, (_, i) => finding({ rule: `rule_${i}`, message: "m".repeat(7000) }));
    const body = reviewBody(folder({ findings }), 1);
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect(body.endsWith("The Oxagen steering check lists every finding.\n")).toBe(true);
  });
});
