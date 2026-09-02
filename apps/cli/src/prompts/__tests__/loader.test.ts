import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrompts, getPrompt } from "../loader.js";

let dir: string;
let userDir: string;

function writePrompt(rel: string, body: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
}

const load = () => loadPrompts({ cwd: dir, userPromptsDir: userDir });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-prompts-"));
  userDir = join(dir, "user-prompts");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadPrompts", () => {
  it("loads a prompt with frontmatter and body text", () => {
    writePrompt(
      ".oxagen/prompts/triage.md",
      "---\ndescription: Triage a bug report\nargument-hint: <ticket>\n---\nTriage the ticket carefully.",
    );
    const prompt = load().get("triage");
    expect(prompt?.description).toBe("Triage a bug report");
    expect(prompt?.argumentHint).toBe("<ticket>");
    expect(prompt?.body).toBe("Triage the ticket carefully.");
  });

  it("defaults the name to the filename", () => {
    writePrompt(".oxagen/prompts/standup.md", "Write my standup update.");
    expect(load().get("standup")?.name).toBe("standup");
  });

  it(".oxagen overrides .claude overrides user", () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "x.md"), "user body");
    writePrompt(".claude/prompts/x.md", "claude body");
    expect(load().get("x")?.body).toBe("claude body");
    writePrompt(".oxagen/prompts/x.md", "oxagen body");
    expect(load().get("x")?.body).toBe("oxagen body");
  });

  it("ignores files with an empty body", () => {
    writePrompt(".oxagen/prompts/empty.md", "---\ndescription: d\n---\n");
    expect(load().has("empty")).toBe(false);
  });

  it("returns an empty registry when nothing is defined", () => {
    expect(load().size).toBe(0);
  });

  it("getPrompt returns one prompt or null", () => {
    writePrompt(".oxagen/prompts/solo.md", "solo body");
    expect(getPrompt("solo", { cwd: dir, userPromptsDir: userDir })?.name).toBe(
      "solo",
    );
    expect(getPrompt("nope", { cwd: dir, userPromptsDir: userDir })).toBeNull();
  });
});
