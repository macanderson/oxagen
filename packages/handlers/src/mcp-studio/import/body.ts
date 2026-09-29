// body.ts: the steering PR's title, commit message, and body for a Review
// (lane M11, ADR-224).
//
// The body lists every tool the PR imports, removes, and reclassifies, the
// definition token total against the budget, and the tool checks' findings.
// It is built from the BuiltFolder alone: tool keys, classifications, and
// lint messages. A lint message names a credential by its reference, such as
// oxagen:credential/billing, and never holds a secret.
import type { BuiltFolder, StudioClassification } from "./build";

/** GitHub refuses a PR body above 65,536 characters. */
export const PR_BODY_MAX = 60_000;

/** The most list items one section shows before it says how many more follow. */
const SECTION_ITEMS = 200;
/** The most findings the body shows before it says how many more follow. */
const FINDINGS_SHOWN = 100;

export function reviewTitle(folder: Pick<BuiltFolder, "server" | "isNew">): string {
  return folder.isNew ? `Add the ${folder.server} server` : `Update tools for ${folder.server}`;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function reviewCommitMessage(folder: BuiltFolder, revision: number): string {
  const parts = [
    `${folder.imported.length} imported`,
    `${folder.removed.length} removed`,
    `${folder.reclassified.length} reclassified`,
  ];
  return `${reviewTitle(folder)}\n\nStudio draft revision ${revision}: ${parts.join(", ")}.`;
}

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

/** A bullet list, cut at `max` items with a line that says how many more follow. */
function bullets(items: readonly string[], max: number, none: string): string {
  if (items.length === 0) return none;
  const shown = items.slice(0, max).map((item) => `- ${item}`);
  if (items.length > max) shown.push(`- ${count(items.length - max, "more tool follows", "more tools follow")}.`);
  return shown.join("\n");
}

function classificationText(c: StudioClassification): string {
  const impacts = c.impacts.length === 0 ? "no impacts" : `impacts ${c.impacts.join(", ")}`;
  return `risk ${c.risk}, side effect ${c.sideEffect}, egress ${c.egress}, ${impacts}`;
}

function tokensText(tokens: BuiltFolder["tokens"]): string {
  const total = `The imported tools' definitions come to ${tokens.definitions} tokens against a budget of ${tokens.budget}.`;
  if (tokens.definitions <= tokens.budget) return total;
  return `${total} The folder is ${tokens.definitions - tokens.budget} tokens over budget.`;
}

function findingText(finding: BuiltFolder["findings"][number]): string {
  const at = [finding.tool, finding.field].filter((part) => part !== null).join(".");
  const where = at === "" ? "" : ` on ${code(at)}`;
  return `**${finding.level}** ${code(finding.rule)}${where}: ${finding.message} Fix: ${finding.fix}`;
}

function findingsText(findings: BuiltFolder["findings"], max: number): string {
  if (findings.length === 0) return "The tool checks found nothing.";
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...findings].sort((a, b) => order[a.level] - order[b.level]);
  const shown = sorted.slice(0, max).map((finding) => `- ${findingText(finding)}`);
  if (sorted.length > max) {
    shown.push(`- ${count(sorted.length - max, "more finding follows", "more findings follow")} in the Oxagen steering check.`);
  }
  return shown.join("\n");
}

function render(folder: BuiltFolder, revision: number, items: number, findings: number): string {
  const sections = [
    `Studio's draft for ${code(folder.server)}, revision ${revision}. This steering PR writes ${code(`tools/servers/${folder.server}/`)}.`,
    `## Imported tools\n\n${bullets(folder.imported.map(code), items, "None.")}`,
    `## Removed tools\n\n${bullets(folder.removed.map(code), items, "None.")}`,
    `## Reclassified tools\n\n${bullets(
      folder.reclassified.map(
        (change) =>
          `${code(change.tool)} from ${classificationText(change.before)} to ${classificationText(change.after)}`,
      ),
      items,
      "None.",
    )}`,
  ];
  if (folder.described.length > 0) {
    sections.push(`## Changed descriptions\n\n${bullets(folder.described.map(code), items, "None.")}`);
  }
  if (folder.tested.length > 0) {
    sections.push(`## Saved tests\n\n${bullets(folder.tested.map(code), items, "None.")}`);
  }
  sections.push(`## Definition tokens\n\n${tokensText(folder.tokens)}`);
  sections.push(`## Findings\n\n${findingsText(folder.findings, findings)}`);
  return `${sections.join("\n\n")}\n`;
}

/**
 * The PR body. A folder with thousands of tools or findings gets shorter lists,
 * so the body stays under PR_BODY_MAX.
 */
export function reviewBody(folder: BuiltFolder, revision: number): string {
  const full = render(folder, revision, SECTION_ITEMS, FINDINGS_SHOWN);
  if (full.length <= PR_BODY_MAX) return full;
  const short = render(folder, revision, 20, 10);
  if (short.length <= PR_BODY_MAX) return short;
  const cut = "\n\nThe body stops here because it is too long for GitHub. The Oxagen steering check lists every finding.\n";
  return `${short.slice(0, PR_BODY_MAX - cut.length)}${cut}`;
}
