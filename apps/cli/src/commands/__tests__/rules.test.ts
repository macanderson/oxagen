import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rulesList, rulesShow, rulesNew, rulesCheck, type RulesCmdCtx } from "../rules.js";

let dir: string;
let ctx: RulesCmdCtx;
let out: string[];
let err: string[];

function writeRule(name: string, body: string): void {
  const p = join(dir, ".oxagen", "rules", `${name}.md`);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body, "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-cmd-rules-"));
  ctx = { cwd: dir, userRulesDir: join(dir, "user-rules") };
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

const text = () => out.join("\n");
const errText = () => err.join("\n");

describe("rules command handlers", () => {
  it("lists rules and flags enforced ones", () => {
    writeRule("style", "---\ndescription: match style\n---\nMatch surrounding style.");
    writeRule("no-mig", "---\ndescription: migrations\nguard-tool: Edit\nguard-deny-path: m/*-applied/**\n---\nAdd a forward migration.");
    rulesList(ctx);
    expect(text()).toContain("style");
    expect(text()).toContain("no-mig  [enforced]");
  });

  it("lists nothing when empty", () => {
    rulesList(ctx);
    expect(text()).toContain("No rules defined");
  });

  it("shows a rule with its guard", () => {
    writeRule("no-mig", "---\nguard-tool: Edit\nguard-deny-path: m/**\n---\nAdd a forward migration.");
    rulesShow("no-mig", ctx);
    expect(text()).toContain("# no-mig");
    expect(text()).toContain("denyPath=m/**");
    expect(text()).toContain("Add a forward migration.");
  });

  it("errors showing an unknown rule", () => {
    rulesShow("ghost", ctx);
    expect(errText()).toContain("Unknown rule");
    expect(process.exitCode).toBe(1);
  });

  it("scaffolds a rule and is idempotent", () => {
    rulesNew("safety", ctx);
    expect(text()).toContain("Created rule");
    expect(existsSync(join(dir, ".oxagen", "rules", "safety.md"))).toBe(true);
    out = [];
    rulesNew("safety", ctx);
    expect(text()).toContain("already exists");
  });

  it("rejects an invalid rule name", () => {
    rulesNew("bad name", ctx);
    expect(errText()).toContain("Invalid rule name");
    expect(process.exitCode).toBe(1);
  });

  describe("rules check (dry-run)", () => {
    beforeEach(() => {
      writeRule("no-mig", "---\nguard-tool: Edit\nguard-deny-path: packages/database/migrations/*-applied/**\n---\nAdd a forward migration instead.");
      writeRule("no-rm", "---\nguard-tool: Bash\nguard-deny-command: rm -rf*\n---\nNo destructive deletes.");
    });

    it("blocks a violating edit and shows the rule", () => {
      rulesCheck("edit", "packages/database/migrations/0001-applied/up.sql", ctx);
      expect(text()).toContain("⛔ BLOCKED");
      expect(text()).toContain("Add a forward migration instead.");
      expect(process.exitCode).toBe(1);
    });

    it("blocks a violating bash command", () => {
      rulesCheck("bash", "rm -rf /tmp", ctx);
      expect(text()).toContain("BLOCKED");
      expect(text()).toContain("No destructive deletes.");
    });

    it("allows a non-matching call", () => {
      rulesCheck("edit", "src/app.ts", ctx);
      expect(text()).toContain("allowed");
    });

    it("errors on an unknown tool", () => {
      rulesCheck("telepathy", "x", ctx);
      expect(errText()).toContain("Unknown tool");
      expect(process.exitCode).toBe(1);
    });
  });
});
