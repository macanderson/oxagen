// restoreManagedBlock: the file a steering PR changed, with the production
// branch's managed block put back (#4518). The production files are the ones
// Oxagen writes in a steering repo's first commit.
import {
  agentsMdTemplate,
  claudeMdTemplate,
  readManagedBlock,
} from "@oxagen/oxagen/steering-repo/templates";
import { describe, expect, it } from "vitest";
import { restoreManagedBlock } from "./managed-block";

const AGENTS = agentsMdTemplate({
  provider: "github",
  organization: "acme",
  repository: "acme/oxagen-core",
  scope: { kind: "workspace", slug: "core", label: "Core" },
});
const CLAUDE = claudeMdTemplate();

/** The production block's lines, markers included. */
function blockOf(text: string): string {
  const read = readManagedBlock(text);
  if (!read.ok || read.block === null) throw new Error("no block");
  return text
    .split("\n")
    .slice(read.block.begin_line - 1, read.block.end_line)
    .join("\n");
}

function restored(production: string | null, head: string | null): string {
  const outcome = restoreManagedBlock(production, head);
  if (outcome.kind !== "restored") throw new Error(`nothing restored: ${outcome.kind}`);
  return outcome.text;
}

describe("restoreManagedBlock", () => {
  it("replaces an edited block in place and keeps the notes below it", () => {
    const edited = AGENTS.replace("Write down", "Write").replace(
      "Run `oxagen check` before you push.",
      "Push straight to main.",
    );
    const head = `${edited}- Our own note stays.\n`;
    const text = restored(AGENTS, head);
    expect(text).toBe(`${AGENTS}- Our own note stays.\n`);
    const read = readManagedBlock(text);
    expect(read.ok && read.block?.intact).toBe(true);
  });

  it("puts a removed block back at the top", () => {
    const text = restored(CLAUDE, "Team notes only.\n");
    expect(text).toBe(`${blockOf(CLAUDE)}\n\nTeam notes only.\n`);
    expect(text.startsWith("<!-- oxagen:begin managed sha256:")).toBe(true);
  });

  it("brings back a file the PR deleted, as production holds it", () => {
    expect(restored(CLAUDE, null)).toBe(CLAUDE);
  });

  it("replaces broken markers and the text between them, and keeps a note after a lone end", () => {
    const block = blockOf(CLAUDE);
    const head = [
      "Intro line.",
      "<!-- oxagen:begin managed sha256:0000000000000000 -->",
      "@SOMETHING-ELSE.md",
      "<!-- oxagen:end managed -->",
      "<!-- oxagen:begin managed sha256:1111111111111111 -->",
      "Kept note after a begin with no end.",
      "",
    ].join("\n");
    expect(restored(CLAUDE, head)).toBe(
      ["Intro line.", block, "Kept note after a begin with no end.", ""].join("\n"),
    );
  });

  it("refuses a block that already matches production (negative)", () => {
    expect(restoreManagedBlock(AGENTS, `${AGENTS}More notes.\n`)).toEqual({ kind: "intact" });
  });

  it("has nothing to restore from when production holds no block (negative)", () => {
    expect(restoreManagedBlock("# Plain file\n", "# Plain file\nedited\n")).toEqual({
      kind: "no_block",
    });
    expect(restoreManagedBlock(null, "anything")).toEqual({ kind: "no_block" });
  });
});
