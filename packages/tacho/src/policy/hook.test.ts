import { beforeAll, describe, expect, it } from "vitest";
import {
  CALL_RESOURCE,
  builtinArgSets,
  evaluateHookCall,
  isOxagenTool,
  mcpActionFor,
  patchPaths,
  principalEntities,
  principalsFor,
  type HookCedarCall,
} from "./hook";
import { requireCedarRuntime, type CedarRuntime } from "./runtime";
import {
  CI_REVIEWER,
  DOCS_WRITER,
  REFUND_ACTION,
  RELEASE_BOT,
  testCedarBundle,
} from "./test-schema";

const NOW = Date.parse("2026-09-22T11:30:00.000Z");

let runtime: CedarRuntime;
beforeAll(async () => {
  runtime = await requireCedarRuntime();
});

function call(overrides: Partial<HookCedarCall> & Pick<HookCedarCall, "cedar">): HookCedarCall {
  return {
    runtime,
    harness: "claude-code",
    toolName: "Bash",
    toolInput: { command: "ls" },
    now: NOW,
    ...overrides,
  };
}

// The release bot and the CI reviewer may not run a shell. The docs writer may.
const NO_SHELL = {
  "shell.not-for-bots": `@id("shell.not-for-bots")
forbid (principal, action == Action::"builtin__shell", resource)
when {
  principal == Agent::"a-intel.core.release-bot" ||
  principal == Agent::"a-intel.core.ci-reviewer"
};`,
};

describe("evaluateHookCall", () => {
  it("denies Claude Code's Bash when a policy forbids the shell", () => {
    const verdict = evaluateHookCall(call({ cedar: testCedarBundle(NO_SHELL) }));
    expect(verdict).toEqual({
      decision: "deny",
      reasons: ["shell.not-for-bots"],
      errors: [],
      action: "builtin__shell",
      principals: [RELEASE_BOT.name],
    });
  });

  it("denies Codex's shell when a policy forbids the shell", () => {
    const verdict = evaluateHookCall(
      call({
        cedar: testCedarBundle(NO_SHELL),
        harness: "codex",
        toolName: "shell",
        toolInput: { command: ["bash", "-lc", "ls"] },
      }),
    );
    expect(verdict?.decision).toBe("deny");
    expect(verdict?.action).toBe("builtin__shell");
    expect(verdict?.principals).toEqual([CI_REVIEWER.name]);
  });

  it("allows the shell for another agent", () => {
    const verdict = evaluateHookCall(
      call({ cedar: testCedarBundle(NO_SHELL), harness: "stella", toolName: "bash" }),
    );
    expect(verdict).toEqual({
      decision: "allow",
      reasons: ["grant.builtin"],
      errors: [],
      action: "builtin__shell",
      principals: [DOCS_WRITER.name],
    });
  });

  it("decides an unmapped tool as the shell", () => {
    const verdict = evaluateHookCall(
      call({ cedar: testCedarBundle(NO_SHELL), toolName: "BrandNewTool", toolInput: {} }),
    );
    expect(verdict?.action).toBe("builtin__shell");
    expect(verdict?.decision).toBe("deny");
  });

  it("reads the harness's own tool name from context.harness_tool", () => {
    const policies = {
      "no-kill": `@id("no-kill")
forbid (principal, action == Action::"builtin__shell", resource)
when { context has harness_tool && context.harness_tool == "KillShell" };`,
    };
    const cedar = testCedarBundle(policies);
    expect(evaluateHookCall(call({ cedar, toolName: "KillShell" }))?.decision).toBe("deny");
    expect(evaluateHookCall(call({ cedar }))?.decision).toBe("allow");
  });

  it("parks a call when every deciding rule asks for approval", () => {
    const policies = {
      "rm.approval": `@id("rm.approval")
@decision("require_approval")
forbid (principal, action == Action::"builtin__shell", resource)
when { context.args has command && context.args.command like "rm *" }
unless { context.approval.granted };`,
    };
    const cedar = testCedarBundle(policies, ["rm.approval"]);
    const parked = evaluateHookCall(call({ cedar, toolInput: { command: "rm -rf build" } }));
    expect(parked?.decision).toBe("require_approval");
    expect(parked?.reasons).toEqual(["rm.approval"]);
    expect(evaluateHookCall(call({ cedar, toolInput: { command: "ls" } }))?.decision).toBe(
      "allow",
    );
  });

  it("decides a patch once per file, and the strictest verdict wins", () => {
    const policies = {
      "workflows.never": `@id("workflows.never")
forbid (principal, action == Action::"builtin__write_file", resource)
when { context.args has path && context.args.path like ".github/workflows/*" };`,
    };
    const cedar = testCedarBundle(policies);
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/index.ts",
      "@@",
      "-a",
      "+b",
      "*** Add File: .github/workflows/ci.yml",
      "+name: ci",
      "*** End Patch",
    ].join("\n");
    const denied = evaluateHookCall(
      call({ cedar, harness: "codex", toolName: "apply_patch", toolInput: { input: patch } }),
    );
    expect(denied?.action).toBe("builtin__write_file");
    expect(denied?.decision).toBe("deny");
    expect(denied?.reasons).toEqual(["workflows.never"]);

    const allowed = evaluateHookCall(
      call({
        cedar,
        harness: "codex",
        toolName: "apply_patch",
        toolInput: { input: patch.replace(".github/workflows/ci.yml", "docs/ci.md") },
      }),
    );
    expect(allowed?.decision).toBe("allow");
  });

  it("reads the skill only where the harness names it", () => {
    const policies = {
      "skill.no-shell": `@id("skill.no-shell")
forbid (principal, action == Action::"builtin__shell", resource)
when { context has skill && context.skill == "release-notes" };`,
    };
    const cedar = testCedarBundle(policies);
    expect(evaluateHookCall(call({ cedar, skill: "release-notes" }))?.decision).toBe("deny");
    expect(
      evaluateHookCall(
        call({ cedar, harness: "codex", toolName: "shell", skill: "release-notes" }),
      )?.decision,
    ).toBe("allow");
  });

  it("decides a subagent start as the action the hook names", () => {
    const policies = {
      "no-subagents": `@id("no-subagents")
forbid (principal, action == Action::"builtin__start_subagent", resource)
when { context.args has subagent && context.args.subagent == "general-purpose" };`,
    };
    const verdict = evaluateHookCall(
      call({
        cedar: testCedarBundle(policies),
        toolName: "Task",
        action: "builtin__start_subagent",
        toolInput: { subagent_type: "general-purpose", subagent_id: "a1" },
      }),
    );
    expect(verdict?.action).toBe("builtin__start_subagent");
    expect(verdict?.decision).toBe("deny");
  });

  it("picks a custom agent by its name", () => {
    const cedar = testCedarBundle(NO_SHELL);
    const verdict = evaluateHookCall(
      call({ cedar, harness: "custom", agent: DOCS_WRITER.name, toolName: "run" }),
    );
    expect(verdict?.principals).toEqual([DOCS_WRITER.name]);
    expect(verdict?.decision).toBe("allow");
  });

  it("decides for every agent the harness could be, and the strictest verdict wins", () => {
    const cedar = testCedarBundle(NO_SHELL);
    cedar.principals.push({ ...DOCS_WRITER, name: "a-intel.core.second", harness: "claude-code" });
    const verdict = evaluateHookCall(call({ cedar }));
    expect(verdict?.principals).toEqual([RELEASE_BOT.name, "a-intel.core.second"]);
    expect(verdict?.decision).toBe("deny");
  });

  it("denies a call no agent on this host can own", () => {
    const verdict = evaluateHookCall(
      call({ cedar: testCedarBundle({}), harness: "cursor", toolName: "Shell" }),
    );
    expect(verdict).toEqual({
      decision: "deny",
      reasons: [],
      errors: [],
      action: "builtin__shell",
      principals: [],
    });
  });

  it("leaves one of Oxagen's own tools to the kernel", () => {
    const cedar = testCedarBundle(NO_SHELL);
    expect(evaluateHookCall(call({ cedar, toolName: "mcp__oxagen__query_ontology" }))).toBeNull();
  });

  it("decides an imported MCP tool as its own action, with typed arguments", () => {
    const policies = {
      "refunds.over-100": `@id("refunds.over-100")
forbid (principal, action == Action::"${REFUND_ACTION}", resource)
when { context.args has amount_cents && context.args.amount_cents > 10000 };`,
    };
    const cedar = testCedarBundle({ ...NO_SHELL, ...policies });
    const large = evaluateHookCall(
      call({
        cedar,
        toolName: "mcp__billing__create_refund",
        toolInput: { amount_cents: 15000, customer: "cus_1", note: "not in the schema" },
      }),
    );
    expect(large).toEqual({
      decision: "deny",
      reasons: ["refunds.over-100"],
      errors: [],
      action: REFUND_ACTION,
      principals: [RELEASE_BOT.name],
    });
    const small = evaluateHookCall(
      call({
        cedar,
        toolName: "mcp__billing__create_refund",
        toolInput: { amount_cents: 500, customer: "cus_1" },
      }),
    );
    expect(small?.decision).toBe("allow");
    expect(small?.action).toBe(REFUND_ACTION);
  });

  it("denies an imported tool whose argument has the wrong type", () => {
    const verdict = evaluateHookCall(
      call({
        cedar: testCedarBundle({}),
        toolName: "mcp__billing__create_refund",
        toolInput: { amount_cents: "a lot" },
      }),
    );
    expect(verdict).toEqual({
      decision: "deny",
      reasons: [],
      errors: ["Argument amount_cents is not a Long."],
      action: REFUND_ACTION,
      principals: [RELEASE_BOT.name],
    });
  });

  it("decides an MCP tool the workspace did not import as the shell", () => {
    const cedar = testCedarBundle(NO_SHELL);
    const denied = evaluateHookCall(
      call({ cedar, toolName: "mcp__github__merge_pull_request", toolInput: { number: 7 } }),
    );
    expect(denied).toEqual({
      decision: "deny",
      reasons: ["shell.not-for-bots"],
      errors: [],
      action: "builtin__shell",
      principals: [RELEASE_BOT.name],
    });
    const allowed = evaluateHookCall(
      call({ cedar, harness: "stella", toolName: "mcp__github__merge_pull_request" }),
    );
    expect(allowed?.decision).toBe("allow");
    expect(allowed?.action).toBe("builtin__shell");
  });

  it("names the MCP tool in context.harness_tool", () => {
    const policies = {
      "no-merge": `@id("no-merge")
forbid (principal, action, resource)
when { context has harness_tool && context.harness_tool == "mcp__github__merge_pull_request" };`,
    };
    const cedar = testCedarBundle(policies);
    expect(
      evaluateHookCall(call({ cedar, toolName: "mcp__github__merge_pull_request" }))?.decision,
    ).toBe("deny");
    expect(evaluateHookCall(call({ cedar, toolName: "mcp__github__get_issue" }))?.decision).toBe(
      "allow",
    );
  });

  it("reads the harness's own tool name when an adapter renamed the tool", () => {
    const policies = {
      "no-cursor-shell": `@id("no-cursor-shell")
forbid (principal, action, resource)
when { context has harness_tool && context.harness_tool == "Shell" };`,
    };
    const cedar = testCedarBundle(policies);
    expect(evaluateHookCall(call({ cedar, harnessTool: "Shell" }))?.decision).toBe("deny");
    expect(evaluateHookCall(call({ cedar }))?.decision).toBe("allow");
  });

  it("decides Cursor's MCP tool with no server as the shell", () => {
    const cedar = testCedarBundle(NO_SHELL);
    cedar.principals.push({ ...RELEASE_BOT, name: "a-intel.core.editor", harness: "cursor" });
    const verdict = evaluateHookCall(call({ cedar, harness: "cursor", toolName: "MCP:search" }));
    expect(verdict?.action).toBe("builtin__shell");
    expect(verdict?.principals).toEqual(["a-intel.core.editor"]);
    expect(verdict?.decision).toBe("allow");
  });

  it("denies when the request does not match the schema", () => {
    const cedar = testCedarBundle(NO_SHELL);
    cedar.schema = cedar.schema.replace("harness: String\n", "harness: String,\n  team: String\n");
    const verdict = evaluateHookCall(call({ cedar, harness: "stella", toolName: "bash" }));
    expect(verdict?.decision).toBe("deny");
    expect(verdict?.errors.length).toBeGreaterThan(0);
  });

  it("carries the agent's role and budget into the request", () => {
    const policies = {
      "sre-only": `@id("sre-only")
forbid (principal, action == Action::"builtin__shell", resource)
unless { context.operator.role == "sre" && context.budget.remaining_cents > 100 };`,
    };
    const cedar = testCedarBundle(policies);
    cedar.principals = [{ ...RELEASE_BOT, operator_role: "sre", budget_remaining_cents: 500 }];
    expect(evaluateHookCall(call({ cedar }))?.decision).toBe("allow");
    cedar.principals = [{ ...RELEASE_BOT, operator_role: "sre", budget_remaining_cents: 50 }];
    expect(evaluateHookCall(call({ cedar }))?.decision).toBe("deny");
  });
});

describe("principalEntities", () => {
  it("places the agent in its workspace", () => {
    expect(principalEntities(RELEASE_BOT)).toEqual([
      { uid: { type: "Workspace", id: "core" }, attrs: {}, parents: [] },
      {
        uid: { type: "Agent", id: RELEASE_BOT.name },
        attrs: { operator: "mac@a-intel.com", runtime: "laptop-7", harness: "claude-code" },
        parents: [{ type: "Workspace", id: "core" }],
      },
    ]);
    expect(CALL_RESOURCE).toEqual({ type: "Target", id: "call" });
  });
});

describe("principalsFor", () => {
  const cedar = testCedarBundle({});
  it("picks by name when the call names its agent, and by harness otherwise", () => {
    expect(principalsFor(cedar, "codex", undefined).map((p) => p.name)).toEqual([
      CI_REVIEWER.name,
    ]);
    expect(principalsFor(cedar, "codex", RELEASE_BOT.name).map((p) => p.name)).toEqual([
      RELEASE_BOT.name,
    ]);
    expect(principalsFor(cedar, "codex", "a-intel.core.nobody")).toEqual([]);
  });
});

describe("isOxagenTool", () => {
  it("names only the tools on Oxagen's own server", () => {
    expect(isOxagenTool("mcp__oxagen__query_ontology")).toBe(true);
    expect(isOxagenTool("mcp__github__create_issue")).toBe(false);
    expect(isOxagenTool("MCP:github")).toBe(false);
    expect(isOxagenTool("Bash")).toBe(false);
  });
});

describe("mcpActionFor", () => {
  it("drops the prefix from a direct MCP tool's name", () => {
    expect(mcpActionFor("mcp__github__merge_pull_request")).toBe("github__merge_pull_request");
    expect(mcpActionFor("mcp__billing__create_refund")).toBe(REFUND_ACTION);
  });

  it("returns undefined for a name that is not a server and a tool", () => {
    expect(mcpActionFor("Bash")).toBeUndefined();
    expect(mcpActionFor("MCP:search")).toBeUndefined();
    expect(mcpActionFor("mcp__github")).toBeUndefined();
    expect(mcpActionFor("mcp____tool")).toBeUndefined();
    expect(mcpActionFor("mcp__github__")).toBeUndefined();
  });
});

describe("patchPaths", () => {
  it("lists each file a patch touches once, in order", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "*** Move to: b.ts",
      "*** Delete File: c.ts",
      "*** Update File: a.ts",
      "*** Add File:  ",
      "*** End Patch",
    ].join("\n");
    expect(patchPaths(patch)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(patchPaths("no files here")).toEqual([]);
  });
});

describe("builtinArgSets", () => {
  it("names each argument the way the schema does", () => {
    expect(builtinArgSets("Read", { file_path: "/a", limit: 10 })).toEqual([{ path: "/a" }]);
    expect(builtinArgSets("NotebookEdit", { notebook_path: "/n.ipynb" })).toEqual([
      { path: "/n.ipynb" },
    ]);
    expect(builtinArgSets("Grep", { pattern: "x", path: "src" })).toEqual([
      { path: "src", pattern: "x" },
    ]);
    expect(builtinArgSets("WebFetch", { url: "https://a.test", prompt: "p" })).toEqual([
      { url: "https://a.test" },
    ]);
    expect(builtinArgSets("WebSearch", { query: "cedar" })).toEqual([{ query: "cedar" }]);
    expect(builtinArgSets("Task", { subagent_type: "explore" })).toEqual([
      { subagent: "explore" },
    ]);
    expect(builtinArgSets("shell", { command: ["git", "status"] })).toEqual([
      { command: "git status" },
    ]);
    expect(builtinArgSets("Bash", undefined)).toEqual([{}]);
  });

  it("skips empty and mistyped values", () => {
    expect(
      builtinArgSets("Bash", { command: "", file_path: 3, url: "", subagent_type: null }),
    ).toEqual([{}]);
    expect(builtinArgSets("shell", { command: ["ls", 1] })).toEqual([{}]);
  });

  it("splits a patch into one set per file, without the patch text", () => {
    const patch = "*** Begin Patch\n*** Update File: a.ts\n*** Add File: b.ts\n*** End Patch";
    expect(builtinArgSets("apply_patch", { patch })).toEqual([{ path: "a.ts" }, { path: "b.ts" }]);
    expect(builtinArgSets("apply_patch", { command: patch })).toEqual([
      { path: "a.ts" },
      { path: "b.ts" },
    ]);
    expect(builtinArgSets("apply_patch", { input: "not a patch" })).toEqual([{}]);
  });
});

// Mac's ruling of 2026-10-01: the open-source Stella coding agent a customer
// runs as a CLI is a customer agent, governed exactly like Claude Code and
// Codex (ADR-235). A workspace decision rule compiles to a forbid with no
// principal (`packages/policy/src/decision-rules.ts`), so it binds every
// harness's agent. Each harness names the same act in its own words, and each
// gets the same answer.
describe("evaluateHookCall: a workspace rule binds the Stella CLI like Claude Code and Codex", () => {
  const RULES = {
    "ws.no-shell": `@id("ws.no-shell")
forbid (principal, action == Action::"builtin__shell", resource);`,
    "ws.src-needs-approval": `@id("ws.src-needs-approval")
@decision("require_approval")
forbid (principal, action == Action::"builtin__write_file", resource)
when { context.args has path && context.args.path like "src/*" }
unless { context.approval.granted };`,
  };
  const PATCH = [
    "*** Begin Patch",
    "*** Update File: src/index.ts",
    "@@",
    "-a",
    "+b",
    "*** End Patch",
  ].join("\n");
  const HARNESSES = [
    {
      harness: "claude-code",
      shell: { toolName: "Bash", toolInput: { command: "ls" } },
      write: { toolName: "Write", toolInput: { file_path: "src/index.ts", content: "b" } },
    },
    {
      harness: "codex",
      shell: { toolName: "shell", toolInput: { command: ["bash", "-lc", "ls"] } },
      write: { toolName: "apply_patch", toolInput: { input: PATCH } },
    },
    {
      harness: "stella",
      shell: { toolName: "bash", toolInput: { command: "ls" } },
      write: { toolName: "write_file", toolInput: { path: "src/index.ts", content: "b" } },
    },
  ] as const;

  it.each(HARNESSES)("refuses $harness's shell", ({ harness, shell }) => {
    const verdict = evaluateHookCall(
      call({ cedar: testCedarBundle(RULES, ["ws.src-needs-approval"]), harness, ...shell }),
    );
    expect(verdict).toMatchObject({
      decision: "deny",
      reasons: ["ws.no-shell"],
      action: "builtin__shell",
    });
    expect(verdict?.principals).toHaveLength(1);
  });

  it.each(HARNESSES)("sends $harness's write under src/ to a person", ({ harness, write }) => {
    const verdict = evaluateHookCall(
      call({ cedar: testCedarBundle(RULES, ["ws.src-needs-approval"]), harness, ...write }),
    );
    expect(verdict).toMatchObject({
      decision: "require_approval",
      reasons: ["ws.src-needs-approval"],
      action: "builtin__write_file",
    });
  });

  it("gives the three harnesses one answer per act", () => {
    const cedar = testCedarBundle(RULES, ["ws.src-needs-approval"]);
    const answers = (act: "shell" | "write") =>
      HARNESSES.map((h) => {
        const verdict = evaluateHookCall(call({ cedar, harness: h.harness, ...h[act] }));
        return [verdict?.decision, verdict?.action, verdict?.reasons];
      });
    for (const act of ["shell", "write"] as const) {
      const [first, ...rest] = answers(act);
      for (const answer of rest) expect(answer).toEqual(first);
    }
  });
});
