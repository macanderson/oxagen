import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rulesList,
  rulesShow,
  rulesNew,
  rulesCheck,
  rulesCandidates,
  rulesPromote,
  type RulesCmdCtx,
  type RulesCandidatesCtx,
} from "../rules.js";
import type { TurnTrace } from "../../agent/trace.js";

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

describe("rules candidates + promote (mined from local logs, never auto-written)", () => {
  function trace(id: string, findings: string[]): TurnTrace {
    return {
      id,
      createdAt: 1000,
      cwd: dir,
      originalPrompt: "x",
      evaluation: {
        completeness: 80,
        complexity: 40,
        recommendedTier: "balanced",
        missing: [],
        contextQueries: [],
        refinedPrompt: "x",
        removed: [],
        reasoning: "",
        fallback: false,
        model: "m",
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      },
      enhancement: { prompt: "x", context: "", resolved: [], lessonCount: 0, source: "none" },
      selectedModel: "m",
      selectedTier: "balanced",
      selectionRationale: "",
      response: "done",
      filesTouched: [],
      commandsRun: [],
      judgeRounds: [
        {
          complete: false,
          confidence: 80,
          findings,
          remainingWork: [],
          reasoning: "",
          model: "m",
          fallback: false,
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        },
      ],
      finalComplete: true,
      steps: 1,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      durationMs: 100,
    };
  }

  const recurring = [
    trace("t1", ["recurring gap in the onboarding flow"]),
    trace("t2", ["recurring gap in the onboarding flow"]),
    trace("t3", ["recurring gap in the onboarding flow"]),
  ];

  function mineCtx(traces: TurnTrace[]): RulesCandidatesCtx {
    return { ...ctx, _traces: traces, _memories: [] };
  }

  it("lists mined candidates with evidence", () => {
    const candidates = rulesCandidates({}, mineCtx(recurring));
    expect(candidates).toHaveLength(1);
    expect(text()).toContain("rule promotion candidate");
    expect(text()).toContain("recurring gap in the onboarding flow");
  });

  it("prints a friendly message when nothing recurs yet", () => {
    rulesCandidates({}, mineCtx([]));
    expect(text()).toContain("No promotion candidates yet");
  });

  it("previews without writing when --yes is omitted (the decline path)", () => {
    const [candidate] = rulesCandidates({}, mineCtx(recurring));
    out = [];
    rulesPromote(candidate!.id, {}, mineCtx(recurring));
    expect(text()).toContain("Not written");
    expect(existsSync(join(dir, ".oxagen", "rules", `${candidate!.id}.md`))).toBe(false);
  });

  it("writes the rule with --yes, and it is then visible to `rules list`", () => {
    const [candidate] = rulesCandidates({}, mineCtx(recurring));
    out = [];
    rulesPromote(candidate!.id, { yes: true }, mineCtx(recurring));
    expect(text()).toContain("Promoted to rule");
    expect(existsSync(join(dir, ".oxagen", "rules", `${candidate!.id}.md`))).toBe(true);
    out = [];
    rulesList(ctx);
    expect(text()).toContain(candidate!.id);
  });

  it("errors on an unknown candidate id", () => {
    rulesPromote("ghost-id", { yes: true }, mineCtx([]));
    expect(errText()).toContain("Unknown candidate");
    expect(process.exitCode).toBe(1);
  });
});
