import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent, loadAgents } from "../loader.js";

let root: string;
let userDirectory: string;

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function agent(
  name: string,
  prompt: string,
  tools = "[]",
  unresolved = "[]",
): string {
  return `schema_version = 1\nkind = "agent"\nname = "${name}"\ndescription = "${name}"\ndeveloper_instructions = "${prompt}"\ntools = ${tools}\nskills = []\nunresolved_tools = ${unresolved}\n`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oxagen-agents-"));
  userDirectory = join(root, "user-agents");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadAgents", () => {
  it("loads TOML with workspace precedence and ignores Markdown", () => {
    write(join(userDirectory, "reviewer.toml"), agent("reviewer", "user"));
    write(
      join(root, ".oxagen", "agents", "reviewer.toml"),
      agent("reviewer", "workspace", '["read_file"]'),
    );
    write(
      join(root, ".claude", "agents", "foreign.md"),
      "---\nname: foreign\n---\nforeign",
    );
    const loaded = loadAgents({ cwd: root, userAgentsDir: userDirectory });
    expect([...loaded.keys()]).toEqual(["reviewer"]);
    expect(loaded.get("reviewer")?.systemPrompt).toBe("workspace");
    expect(loaded.get("reviewer")?.tools).toEqual(["read_file"]);
  });

  it("keeps unresolved and invalid artifacts non-executable with diagnostics", () => {
    const codes: string[] = [];
    write(
      join(root, ".oxagen", "agents", "blocked.toml"),
      agent("blocked", "blocked", "[]", '["Task"]'),
    );
    write(join(root, ".oxagen", "agents", "bad.toml"), "not toml");
    expect(
      loadAgents({
        cwd: root,
        userAgentsDir: userDirectory,
        onDiagnostic: (entry) => codes.push(entry.code),
      }),
    ).toHaveLength(0);
    expect(codes.sort()).toEqual(["artifact_needs_review", "invalid_artifact"]);
  });

  it("returns an agent or null", () => {
    write(join(root, ".oxagen", "agents", "solo.toml"), agent("solo", "body"));
    expect(
      getAgent("solo", { cwd: root, userAgentsDir: userDirectory })?.name,
    ).toBe("solo");
    expect(
      getAgent("missing", { cwd: root, userAgentsDir: userDirectory }),
    ).toBeNull();
  });
});
