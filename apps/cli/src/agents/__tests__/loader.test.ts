import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgents, getAgent, parseFrontmatter } from "../loader.js";
import { clearSettingsCache } from "../../settings/resolve.js";

let dir: string;
let userDir: string;
let userSettings: string;

function writeAgent(rel: string, body: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function load() {
  return loadAgents({
    cwd: dir,
    userAgentsDir: userDir,
    settingsOptions: { userSettingsPath: userSettings },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-agents-"));
  userDir = join(dir, "user-agents");
  userSettings = join(dir, "user-settings.json");
  clearSettingsCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearSettingsCache();
});

describe("parseFrontmatter", () => {
  it("splits frontmatter and body", () => {
    const { data, body } = parseFrontmatter("---\nname: x\ndescription: hi\n---\nThe prompt.");
    expect(data["name"]).toBe("x");
    expect(data["description"]).toBe("hi");
    expect(body).toBe("The prompt.");
  });

  it("treats content without frontmatter as all body", () => {
    expect(parseFrontmatter("just a prompt").body).toBe("just a prompt");
  });

  it("strips quotes from values", () => {
    expect(parseFrontmatter('---\nmodel: "a/b"\n---\nx').data["model"]).toBe("a/b");
  });
});

describe("loadAgents", () => {
  it("loads an agent from .oxagen/agents and parses frontmatter + tools", () => {
    writeAgent(".oxagen/agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\nmodel: a/b\n---\nYou review code.");
    const agent = load().get("reviewer");
    expect(agent?.description).toBe("Reviews code");
    expect(agent?.tools).toEqual(["Read", "Grep"]);
    expect(agent?.model).toBe("a/b");
    expect(agent?.systemPrompt).toBe("You review code.");
  });

  it("parses a bracketed tools list", () => {
    writeAgent(".oxagen/agents/a.md", "---\ntools: [Read, Bash]\n---\nbody");
    expect(load().get("a")?.tools).toEqual(["Read", "Bash"]);
  });

  it("defaults the name to the filename and tools to undefined", () => {
    writeAgent(".oxagen/agents/helper.md", "---\ndescription: d\n---\nbody");
    const a = load().get("helper");
    expect(a?.name).toBe("helper");
    expect(a?.tools).toBeUndefined();
  });

  it(".oxagen overrides .claude overrides user, and settings.agents overrides files", () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "r.md"), "---\nname: r\n---\nuser version");
    writeAgent(".claude/agents/r.md", "---\nname: r\n---\nclaude version");
    expect(load().get("r")?.systemPrompt).toBe("claude version");

    writeAgent(".oxagen/agents/r.md", "---\nname: r\n---\noxagen version");
    expect(load().get("r")?.systemPrompt).toBe("oxagen version");

    writeFileSync(userSettings, JSON.stringify({ agents: { r: { prompt: "inline version" } } }));
    clearSettingsCache();
    const a = load().get("r");
    expect(a?.systemPrompt).toBe("inline version");
    expect(a?.source).toBe("settings.json");
  });

  it("ignores files with no name or no body", () => {
    writeAgent(".oxagen/agents/empty.md", "---\nname: empty\n---\n");
    expect(load().has("empty")).toBe(false);
  });

  it("getAgent returns one agent or null", () => {
    writeAgent(".oxagen/agents/solo.md", "---\nname: solo\n---\nbody");
    expect(getAgent("solo", { cwd: dir, userAgentsDir: userDir, settingsOptions: { userSettingsPath: userSettings } })?.name).toBe("solo");
    expect(getAgent("nope", { cwd: dir, userAgentsDir: userDir, settingsOptions: { userSettingsPath: userSettings } })).toBeNull();
  });
});
