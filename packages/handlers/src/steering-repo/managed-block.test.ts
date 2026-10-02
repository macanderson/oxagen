// restoreManagedBlock: the file a steering PR changed, with the production
// branch's managed block put back (#4518). The production files are the ones
// Oxagen writes in a steering repo's first commit.
import {
  agentsMdTemplate,
  claudeMdTemplate,
  readManagedBlock,
} from "@oxagen/oxagen/steering-repo/templates";
import { describe, expect, it } from "vitest";
import { managedBlockFinding, restoreManagedBlock } from "./managed-block";

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

describe("managedBlockFinding (#4518 item 7)", () => {
  const blockLine = () => {
    const read = readManagedBlock(AGENTS);
    if (!read.ok || read.block === null) throw new Error("no block");
    return read.block.begin_line;
  };

  it("names an edited block at its begin line", () => {
    const edited = AGENTS.replace(
      "Run `oxagen check` before you push.",
      "Push straight to main.",
    );
    expect(managedBlockFinding("AGENTS.md", AGENTS, edited)).toEqual({
      rule: "managed-block",
      path: "AGENTS.md",
      line: blockLine(),
      message: "The managed block in AGENTS.md was edited.",
    });
  });

  it("names a removed block, a deleted file, and broken markers", () => {
    const notes = "# Agents\n\nOur own notes.\n";
    expect(managedBlockFinding("AGENTS.md", AGENTS, notes)).toMatchObject({
      line: 1,
      message: "This steering PR removes the managed block from AGENTS.md.",
    });
    expect(managedBlockFinding("AGENTS.md", AGENTS, null)).toMatchObject({
      line: null,
      message:
        "This steering PR removes AGENTS.md and the managed block Oxagen writes in it.",
    });
    const doubled = `${AGENTS}\n${blockOf(AGENTS)}\n`;
    expect(managedBlockFinding("AGENTS.md", AGENTS, doubled)).toMatchObject({
      rule: "managed-block",
      message: expect.stringContaining(
        "The managed block markers in AGENTS.md are broken",
      ),
    });
  });

  it("finds nothing when the block matches the production branch (negative)", () => {
    expect(
      managedBlockFinding("AGENTS.md", AGENTS, `${AGENTS}- A note.\n`),
    ).toBeNull();
    expect(managedBlockFinding("CLAUDE.md", CLAUDE, CLAUDE)).toBeNull();
  });

  it("finds nothing when the production branch holds no block to restore from (negative)", () => {
    expect(managedBlockFinding("README.md", "# Platform\n", "# Changed\n")).toBeNull();
    expect(managedBlockFinding("README.md", null, "# Changed\n")).toBeNull();
  });
});
