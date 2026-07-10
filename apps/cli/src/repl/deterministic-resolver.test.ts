import { describe, it, expect } from "vitest";
import { resolveDeterministicTurn } from "./deterministic-resolver.js";
import { composeGitignore } from "./gitignore-templates.js";

const noFile = { fileExists: () => false };
const hasFile = { fileExists: (p: string) => p === ".gitignore" };

describe("resolveDeterministicTurn — .gitignore recipe", () => {
  it("resolves the canonical exemplar: mac osx + python", () => {
    const hit = resolveDeterministicTurn(
      "create a .gitignore optimized for mac osx and python",
      noFile,
    );
    expect(hit).not.toBeNull();
    expect(hit!.path).toBe(".gitignore");
    expect(hit!.targets).toEqual(["macos", "python"]);
    expect(hit!.content).toContain(".DS_Store");
    expect(hit!.content).toContain("__pycache__/");
    expect(hit!.summary).toMatch(/no model call/);
  });

  it("resolves premodifier order ('a python .gitignore')", () => {
    const hit = resolveDeterministicTurn(
      "generate a python .gitignore",
      noFile,
    );
    expect(hit).not.toBeNull();
    expect(hit!.targets).toEqual(["python"]);
  });

  it("resolves polite/question phrasing and strips trailing punctuation", () => {
    const hit = resolveDeterministicTurn(
      "can you please make a .gitignore for node and macos?",
      noFile,
    );
    expect(hit).not.toBeNull();
    expect(hit!.targets).toEqual(["node", "macos"]);
    expect(hit!.content).toContain("node_modules/");
  });

  it("normalizes multi-word aliases (mac os x, vs code, node.js)", () => {
    expect(
      resolveDeterministicTurn("add a .gitignore for mac os x", noFile)!
        .targets,
    ).toEqual(["macos"]);
    expect(
      resolveDeterministicTurn(
        "add a .gitignore for vs code and node.js",
        noFile,
      )!.targets,
    ).toEqual(["vscode", "node"]);
  });

  it("dedupes aliases mapping to the same section", () => {
    const hit = resolveDeterministicTurn(
      "create a .gitignore for python and py",
      noFile,
    );
    expect(hit!.targets).toEqual(["python"]);
  });

  it("bails on any unclassified word (extra requirements need the model)", () => {
    expect(
      resolveDeterministicTurn(
        "create a .gitignore for python but keep the build dir",
        noFile,
      ),
    ).toBeNull();
    expect(
      resolveDeterministicTurn(
        "create a .gitignore for python excluding secrets",
        noFile,
      ),
    ).toBeNull();
  });

  it("bails on the 'next project' trap ('next' is not a target alias)", () => {
    expect(
      resolveDeterministicTurn(
        "create a .gitignore for my next project",
        noFile,
      ),
    ).toBeNull();
  });

  it("bails without an intent verb, without the artifact word, or without targets", () => {
    expect(
      resolveDeterministicTurn("python macos .gitignore", noFile),
    ).toBeNull();
    expect(
      resolveDeterministicTurn("create something for python", noFile),
    ).toBeNull();
    expect(resolveDeterministicTurn("create a .gitignore", noFile)).toBeNull();
  });

  it("bails when .gitignore already exists (merging is a judgment call)", () => {
    expect(
      resolveDeterministicTurn("create a .gitignore for python", hasFile),
    ).toBeNull();
  });

  it("bails on paste placeholders, multi-line, multi-sentence, and long prompts", () => {
    expect(
      resolveDeterministicTurn("create a .gitignore like [Text #1]", noFile),
    ).toBeNull();
    expect(
      resolveDeterministicTurn("create a .gitignore\nfor python", noFile),
    ).toBeNull();
    expect(
      resolveDeterministicTurn(
        "create a .gitignore for python. Also update the README",
        noFile,
      ),
    ).toBeNull();
    expect(
      resolveDeterministicTurn(
        `create a .gitignore for ${"python and node and go and rust and java ".repeat(5)}`,
        noFile,
      ),
    ).toBeNull();
  });

  it("update/extend intents fall through to the model", () => {
    expect(
      resolveDeterministicTurn("update my .gitignore for python", noFile),
    ).toBeNull();
    expect(
      resolveDeterministicTurn("extend the .gitignore with python", noFile),
    ).toBeNull();
  });
});

describe("composeGitignore", () => {
  it("joins labeled sections in order, deduped, with a trailing newline", () => {
    const out = composeGitignore(["macos", "python", "macos"]);
    expect(out.indexOf("# macOS")).toBeLessThan(out.indexOf("# Python"));
    expect(out.match(/# macOS/g)).toHaveLength(1);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("silently skips unknown keys (matcher is the gate, composer is total)", () => {
    expect(composeGitignore(["nope"])).toBe("\n");
  });
});
