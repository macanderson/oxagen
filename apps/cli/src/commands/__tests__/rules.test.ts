import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
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
import type { CommandWriter } from "../../lib/capture-writer.js";
import type { TurnTrace } from "../../agent/trace.js";

let dir: string;
let ctx: RulesCmdCtx;
// A fake CommandWriter that captures stdout/stderr lines into arrays, so we can
// assert the ADR-023 §4 output discipline: the data/answer lands on stdout, all
// errors land on stderr (prefixed `✗ ` in pretty mode, single-line JSON in json
// mode), and stdout stays clean on failure.
let out: string[];
let err: string[];
let writer: CommandWriter;

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
  writer = {
    write: (line: string) => void out.push(line),
    writeErr: (line: string) => void err.push(line),
  };
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

const text = () => out.join("\n");
const errText = () => err.join("\n");

describe("rules command handlers", () => {
  it("lists rules and flags enforced ones", () => {
    writeRule(
      "style",
      "---\ndescription: match style\n---\nMatch surrounding style.",
    );
    writeRule(
      "no-mig",
      "---\ndescription: migrations\nguard-tool: Edit\nguard-deny-path: m/*-applied/**\n---\nAdd a forward migration.",
    );
    rulesList(ctx, writer);
    expect(text()).toContain("style");
    expect(text()).toContain("no-mig  [enforced]");
    expect(err).toHaveLength(0);
  });

  it("lists nothing when empty", () => {
    rulesList(ctx, writer);
    expect(text()).toContain("No rules defined");
  });

  it("shows a rule with its guard", () => {
    writeRule(
      "no-mig",
      "---\nguard-tool: Edit\nguard-deny-path: m/**\n---\nAdd a forward migration.",
    );
    rulesShow("no-mig", ctx, writer);
    expect(text()).toContain("# no-mig");
    expect(text()).toContain("denyPath=m/**");
    expect(text()).toContain("Add a forward migration.");
  });

  it("errors showing an unknown rule (✗ on stderr, clean stdout, exit 1)", () => {
    rulesShow("ghost", ctx, writer);
    expect(errText()).toContain("Unknown rule");
    expect(errText().startsWith("✗ ")).toBe(true);
    expect(out).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it("scaffolds a rule and is idempotent", () => {
    rulesNew("safety", ctx, writer);
    expect(text()).toContain("Created rule");
    expect(existsSync(join(dir, ".oxagen", "rules", "safety.md"))).toBe(true);
    out = [];
    rulesNew("safety", ctx, writer);
    expect(text()).toContain("already exists");
  });

  it("rejects an invalid rule name (usage error → exit 2)", () => {
    rulesNew("bad name", ctx, writer);
    expect(errText()).toContain("Invalid rule name");
    expect(errText().startsWith("✗ ")).toBe(true);
    expect(out).toHaveLength(0);
    expect(process.exitCode).toBe(2);
  });

  describe("rules check (dry-run)", () => {
    beforeEach(() => {
      writeRule(
        "no-mig",
        "---\nguard-tool: Edit\nguard-deny-path: packages/database/migrations/*-applied/**\n---\nAdd a forward migration instead.",
      );
      writeRule(
        "no-rm",
        "---\nguard-tool: Bash\nguard-deny-command: rm -rf*\n---\nNo destructive deletes.",
      );
    });

    it("blocks a violating edit and shows the rule (exit 1, verdict on stdout)", () => {
      rulesCheck(
        "edit",
        "packages/database/migrations/0001-applied/up.sql",
        ctx,
        writer,
      );
      expect(text()).toContain("⛔ BLOCKED");
      expect(text()).toContain("Add a forward migration instead.");
      expect(err).toHaveLength(0);
      expect(process.exitCode).toBe(1);
    });

    it("blocks a violating bash command", () => {
      rulesCheck("bash", "rm -rf /tmp", ctx, writer);
      expect(text()).toContain("BLOCKED");
      expect(text()).toContain("No destructive deletes.");
    });

    it("allows a non-matching call", () => {
      rulesCheck("edit", "src/app.ts", ctx, writer);
      expect(text()).toContain("allowed");
      expect(process.exitCode).toBeUndefined();
    });

    it("errors on an unknown tool (usage error → exit 2, clean stdout)", () => {
      rulesCheck("telepathy", "x", ctx, writer);
      expect(errText()).toContain("Unknown tool");
      expect(errText().startsWith("✗ ")).toBe(true);
      expect(out).toHaveLength(0);
      expect(process.exitCode).toBe(2);
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
      enhancement: { prompt: "x", context: "", lessonCount: 0, source: "none" },
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
    const candidates = rulesCandidates({}, mineCtx(recurring), writer);
    expect(candidates).toHaveLength(1);
    expect(text()).toContain("rule promotion candidate");
    expect(text()).toContain("recurring gap in the onboarding flow");
    expect(err).toHaveLength(0);
  });

  it("prints a friendly message when nothing recurs yet", () => {
    rulesCandidates({}, mineCtx([]), writer);
    expect(text()).toContain("No promotion candidates yet");
  });

  it("--json emits one single-line JSON array with the SAME shape (candidates)", () => {
    const candidates = rulesCandidates(
      { json: true },
      mineCtx(recurring),
      writer,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("\n");
    // Round-trips to exactly the returned payload shape — no pretty-printing.
    expect(JSON.parse(out[0]!)).toEqual(JSON.parse(JSON.stringify(candidates)));
    expect(err).toHaveLength(0);
  });

  it("previews without writing when --yes is omitted (the decline path)", () => {
    const [candidate] = rulesCandidates({}, mineCtx(recurring), writer);
    out = [];
    rulesPromote(candidate!.id, {}, mineCtx(recurring), writer);
    expect(text()).toContain("Not written");
    expect(
      existsSync(join(dir, ".oxagen", "rules", `${candidate!.id}.md`)),
    ).toBe(false);
  });

  it("writes the rule with --yes, and it is then visible to `rules list`", () => {
    const [candidate] = rulesCandidates({}, mineCtx(recurring), writer);
    out = [];
    rulesPromote(candidate!.id, { yes: true }, mineCtx(recurring), writer);
    expect(text()).toContain("Promoted to rule");
    expect(
      existsSync(join(dir, ".oxagen", "rules", `${candidate!.id}.md`)),
    ).toBe(true);
    out = [];
    rulesList(ctx, writer);
    expect(text()).toContain(candidate!.id);
  });

  it("--json emits one single-line JSON object with the SAME shape (promote)", () => {
    const [candidate] = rulesCandidates({}, mineCtx(recurring), writer);
    out = [];
    rulesPromote(
      candidate!.id,
      { json: true, yes: true },
      mineCtx(recurring),
      writer,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("\n");
    const parsed = JSON.parse(out[0]!) as {
      status: string;
      path: string;
      candidate: { id: string };
    };
    // Shape preserved: `{ ...promoteResult, candidate }`.
    expect(parsed).toHaveProperty("status");
    expect(parsed).toHaveProperty("path");
    expect(parsed.candidate.id).toBe(candidate!.id);
    expect(err).toHaveLength(0);
  });

  it("errors on an unknown candidate id (pretty ✗ on stderr, exit 1)", () => {
    rulesPromote("ghost-id", { yes: true }, mineCtx([]), writer);
    expect(errText()).toContain("Unknown candidate");
    expect(errText().startsWith("✗ ")).toBe(true);
    expect(out).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it("--json error is one single-line {type,code,message} on stderr, clean stdout", () => {
    rulesPromote("ghost-id", { json: true }, mineCtx([]), writer);
    expect(out).toHaveLength(0);
    expect(err).toHaveLength(1);
    expect(err[0]).not.toContain("\n");
    const parsed = JSON.parse(err[0]!) as {
      type: string;
      code: string;
      message: string;
    };
    expect(parsed.type).toBe("error");
    expect(parsed.code).toBe("not_found");
    expect(parsed.message).toContain("Unknown candidate");
    expect(process.exitCode).toBe(1);
  });
});
