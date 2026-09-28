// session-skills.test.ts: the daemon writes a session's published skills
// where its harness reads them, removes them when the session ends, and
// never fails a hook over either.
//
// Each test uses a fresh temp folder as the home directory and passes `now`,
// so no test touches this user's skills folders or reads the clock.
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeSkill, type SessionSkill } from "../skills";
import type { BundleSkill } from "../wire";
import { sessionSkills } from "./session-skills";

const NOW = new Date("2026-09-27T01:00:00.000Z");
const SESSION = "c0ffee00-0000-4000-8000-000000000001";

function skill(name: string): BundleSkill {
  const decoded: SessionSkill = {
    lineage: `a-intel.${name}`,
    name,
    description: `The ${name} skill.`,
    body: `# ${name}\n`,
    files: [],
    source: "workspace",
    version: 3,
  };
  return encodeSkill(decoded);
}

let home: string;
let lines: string[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "session-skills-"));
  lines = [];
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function subject() {
  return sessionSkills({
    home,
    now: () => NOW,
    log: (line) => lines.push(line),
  });
}

async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

describe("sessionSkills", () => {
  it("writes a Claude Code session's skills under ~/.claude/skills and removes them at its end", async () => {
    const skills = subject();
    const root = join(home, ".claude", "skills");
    await skills.place("claude-code", SESSION, [skill("brand-voice"), skill("release")], {});
    expect(await entries(root)).toEqual(["brand-voice", "release"]);
    await skills.remove("claude-code", SESSION, {});
    expect(await entries(root)).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("writes where the harness's own env points, and removes from there with no env", async () => {
    const skills = subject();
    const codexHome = join(home, "codex-home");
    await skills.place("codex", SESSION, [skill("brand-voice")], { CODEX_HOME: codexHome });
    expect(await entries(join(codexHome, "skills"))).toEqual(["brand-voice"]);
    expect(await entries(join(home, ".agents", "skills"))).toEqual([]);
    // The sweep ends a session with no hook env to read.
    await skills.remove("codex", SESSION);
    expect(await entries(join(codexHome, "skills"))).toEqual([]);
  });

  it("removes from the harness's default folder when this daemon placed nothing for the session", async () => {
    await subject().place("stella", SESSION, [skill("brand-voice")], {});
    const root = join(home, ".stella", "skills");
    expect(await entries(root)).toEqual(["brand-voice"]);
    // A restarted daemon has no record of where the start wrote.
    await subject().remove("stella", SESSION);
    expect(await entries(root)).toEqual([]);
  });

  it("places nothing for Cursor or Claude Desktop, which read no skills folder", async () => {
    const skills = subject();
    await skills.place("cursor", SESSION, [skill("brand-voice")], {});
    await skills.place("claude-desktop", SESSION, [skill("brand-voice")], {});
    await skills.remove("cursor", SESSION, {});
    expect(await entries(home)).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("does nothing for a bundle with no skills", async () => {
    await subject().place("claude-code", SESSION, [], {});
    expect(await entries(home)).toEqual([]);
  });

  it("logs a write that fails and lets the session start", async () => {
    // A file where the folder should be makes every write under it fail.
    await writeFile(join(home, ".claude"), "not a folder");
    await expect(
      subject().place("claude-code", SESSION, [skill("brand-voice")], {}),
    ).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`skills: session ${SESSION} starts without its skills`);
    expect(lines[0]).toContain(join(home, ".claude", "skills"));
  });

  it("logs a removal that fails and lets the session end", async () => {
    await mkdir(join(home, ".claude"));
    await writeFile(join(home, ".claude", "skills"), "not a folder");
    await expect(subject().remove("claude-code", SESSION, {})).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`skills: session ${SESSION} ended with its skills still in`);
  });
});
