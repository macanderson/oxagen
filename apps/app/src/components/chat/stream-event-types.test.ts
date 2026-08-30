/**
 * stream-event-types.test.ts
 *
 * Compile-time + runtime shape tests for the chat stream-event-types module.
 *
 * Strategy: this module exports only TypeScript interfaces, type aliases, and
 * union types — there is no runtime logic. Tests construct literal objects that
 * conform to each exported type and assert their discriminant tags and property
 * values at runtime. This serves as:
 *   1. Living documentation of every exported shape.
 *   2. A compile-time gate — if a type changes incompatibly, the assignment fails.
 *   3. A runtime guard — discriminated union narrowing is verified via `.type`.
 */

import { describe, it, expect } from "vitest";

import type {
  RiskLevel,
  RenderDirective,
  TurnUsage,
  ToolCallStatus,
  ApprovalResolution,
  ConsentResolution,
  PlanDecision,
  SubagentStatus,
  MemoryClass,
  PlanStep,
  MemoryRecallHit,
  SubagentChild,
  StreamEvent,
  TextContentBlock,
  ReasoningContentBlock,
  ToolCallContentBlock,
  CodeExecuteContentBlock,
  ApprovalRequestContentBlock,
  ConsentRequestContentBlock,
  PlanContentBlock,
  SubagentFanoutContentBlock,
  MemoryRecallContentBlock,
  ComponentContentBlock,
  AssistantContentBlock,
} from "./stream-event-types";

// ── TextContentBlock ──────────────────────────────────────────────────────────

describe("TextContentBlock", () => {
  it("constructs with type discriminant 'text' and text value", () => {
    const block: TextContentBlock = { type: "text", text: "hello world" };
    expect(block.type).toBe("text");
    expect(block.text).toBe("hello world");
  });

  it("type property is exactly the string literal 'text'", () => {
    const block: TextContentBlock = { type: "text", text: "" };
    expect(block.type).toStrictEqual("text");
  });
});

// ── ReasoningContentBlock ─────────────────────────────────────────────────────

describe("ReasoningContentBlock", () => {
  it("constructs with required fields only (durationMs optional)", () => {
    const block: ReasoningContentBlock = {
      type: "reasoning",
      reasoningId: "r-001",
      text: "I am thinking…",
    };
    expect(block.type).toBe("reasoning");
    expect(block.reasoningId).toBe("r-001");
    expect(block.text).toBe("I am thinking…");
    expect(block.durationMs).toBeUndefined();
  });

  it("accepts optional durationMs", () => {
    const block: ReasoningContentBlock = {
      type: "reasoning",
      reasoningId: "r-002",
      text: "done",
      durationMs: 3500,
    };
    expect(block.durationMs).toBe(3500);
  });
});

// ── ToolCallContentBlock ──────────────────────────────────────────────────────

describe("ToolCallContentBlock", () => {
  it("constructs with all required fields and status 'pending'", () => {
    const block: ToolCallContentBlock = {
      type: "tool-call",
      toolCallId: "tc-abc",
      capability: "execute_code",
      inputPreview: { code: "2+2" },
      riskLevel: "low",
      status: "pending",
    };
    expect(block.type).toBe("tool-call");
    expect(block.toolCallId).toBe("tc-abc");
    expect(block.capability).toBe("execute_code");
    expect(block.riskLevel).toBe("low");
    expect(block.status).toBe("pending");
  });

  it("accepts all ToolCallStatus values", () => {
    const statuses: ToolCallStatus[] = [
      "pending",
      "running",
      "completed",
      "failed",
    ];
    for (const status of statuses) {
      const block: ToolCallContentBlock = {
        type: "tool-call",
        toolCallId: "tc-x",
        capability: "test.cap",
        inputPreview: null,
        riskLevel: "medium",
        status,
      };
      expect(block.status).toBe(status);
    }
  });

  it("accepts optional stdout/stderr/errorReason/durationMs/output", () => {
    const block: ToolCallContentBlock = {
      type: "tool-call",
      toolCallId: "tc-xyz",
      capability: "test.cap",
      inputPreview: null,
      riskLevel: "high",
      status: "completed",
      stdout: "output",
      stderr: "error",
      errorReason: "timeout",
      durationMs: 100,
      output: { result: 42 },
    };
    expect(block.stdout).toBe("output");
    expect(block.stderr).toBe("error");
    expect(block.errorReason).toBe("timeout");
    expect(block.durationMs).toBe(100);
  });

  it("accepts all RiskLevel values", () => {
    const levels: RiskLevel[] = ["low", "medium", "high"];
    for (const riskLevel of levels) {
      const block: ToolCallContentBlock = {
        type: "tool-call",
        toolCallId: "tc-risk",
        capability: "cap",
        inputPreview: null,
        riskLevel,
        status: "running",
      };
      expect(block.riskLevel).toBe(riskLevel);
    }
  });
});

// ── CodeExecuteContentBlock ───────────────────────────────────────────────────

describe("CodeExecuteContentBlock", () => {
  it("constructs with required fields for a node execution", () => {
    const block: CodeExecuteContentBlock = {
      type: "code-execute",
      toolCallId: "ce-001",
      language: "node",
      code: "console.log(1)",
      status: "running",
    };
    expect(block.type).toBe("code-execute");
    expect(block.language).toBe("node");
    expect(block.code).toBe("console.log(1)");
    expect(block.status).toBe("running");
  });

  it("accepts 'python' and 'shell' language values", () => {
    const pyBlock: CodeExecuteContentBlock = {
      type: "code-execute",
      toolCallId: "ce-002",
      language: "python",
      code: "print('hi')",
      status: "completed",
    };
    const shBlock: CodeExecuteContentBlock = {
      type: "code-execute",
      toolCallId: "ce-003",
      language: "shell",
      code: "echo hi",
      status: "completed",
    };
    expect(pyBlock.language).toBe("python");
    expect(shBlock.language).toBe("shell");
  });

  it("accepts arbitrary language string (open union)", () => {
    const block: CodeExecuteContentBlock = {
      type: "code-execute",
      toolCallId: "ce-004",
      language: "ruby",
      code: "puts 'hi'",
      status: "failed",
    };
    expect(block.language).toBe("ruby");
  });

  it("accepts optional stdout/stderr/exitCode/oomKilled/durationMs", () => {
    const block: CodeExecuteContentBlock = {
      type: "code-execute",
      toolCallId: "ce-005",
      language: "node",
      code: "process.exit(1)",
      status: "failed",
      stdout: "",
      stderr: "Uncaught error",
      exitCode: 1,
      oomKilled: false,
      durationMs: 250,
    };
    expect(block.exitCode).toBe(1);
    expect(block.oomKilled).toBe(false);
    expect(block.durationMs).toBe(250);
  });

  it("oomKilled can be true for OOM scenarios", () => {
    const block: CodeExecuteContentBlock = {
      type: "code-execute",
      toolCallId: "ce-006",
      language: "python",
      code: "x = [0]*10**9",
      status: "failed",
      oomKilled: true,
    };
    expect(block.oomKilled).toBe(true);
  });
});

// ── ApprovalRequestContentBlock ───────────────────────────────────────────────

describe("ApprovalRequestContentBlock", () => {
  it("constructs with all required fields and no resolution", () => {
    const block: ApprovalRequestContentBlock = {
      type: "approval-request",
      approvalId: "ap-001",
      capability: "file.delete",
      inputPreview: { path: "/etc/passwd" },
      riskLevel: "high",
      expiresAt: "2026-01-01T00:00:00Z",
    };
    expect(block.type).toBe("approval-request");
    expect(block.approvalId).toBe("ap-001");
    expect(block.capability).toBe("file.delete");
    expect(block.riskLevel).toBe("high");
    expect(block.resolution).toBeUndefined();
  });

  it("accepts all ApprovalResolution values", () => {
    const resolutions: ApprovalResolution[] = ["approved", "denied", "expired"];
    for (const resolution of resolutions) {
      const block: ApprovalRequestContentBlock = {
        type: "approval-request",
        approvalId: "ap-002",
        capability: "cap",
        inputPreview: null,
        riskLevel: "low",
        expiresAt: "2026-01-01T00:00:00Z",
        resolution,
      };
      expect(block.resolution).toBe(resolution);
    }
  });
});

// ── ConsentRequestContentBlock ────────────────────────────────────────────────

describe("ConsentRequestContentBlock", () => {
  it("constructs with all required fields (serverId + toolName)", () => {
    const block: ConsentRequestContentBlock = {
      type: "consent-request",
      approvalId: "cp-001",
      capability: "github.read",
      serverId: "github-mcp",
      toolName: "list_repos",
      inputPreview: { org: "oxagen" },
      expiresAt: "2026-01-01T00:00:00Z",
    };
    expect(block.type).toBe("consent-request");
    expect(block.serverId).toBe("github-mcp");
    expect(block.toolName).toBe("list_repos");
    expect(block.resolution).toBeUndefined();
  });

  it("accepts all ConsentResolution values", () => {
    const resolutions: ConsentResolution[] = ["granted", "denied", "expired"];
    for (const resolution of resolutions) {
      const block: ConsentRequestContentBlock = {
        type: "consent-request",
        approvalId: "cp-002",
        capability: "cap",
        serverId: "srv",
        toolName: "tool",
        inputPreview: null,
        expiresAt: "2026-01-01T00:00:00Z",
        resolution,
      };
      expect(block.resolution).toBe(resolution);
    }
  });
});

// ── PlanContentBlock ──────────────────────────────────────────────────────────

describe("PlanContentBlock", () => {
  it("constructs with steps array and pending status", () => {
    const step: PlanStep = {
      id: "step-1",
      summary: "Fetch data",
      intent: "retrieve",
      capability: "data.fetch",
      dependsOn: [],
    };
    const block: PlanContentBlock = {
      type: "plan",
      planId: "plan-001",
      title: "Fetch and process",
      steps: [step],
      status: "pending",
    };
    expect(block.type).toBe("plan");
    expect(block.planId).toBe("plan-001");
    expect(block.steps).toHaveLength(1);
    expect(block.status).toBe("pending");
    expect(block.rationale).toBeUndefined();
  });

  it("accepts all PlanDecision values as status", () => {
    const decisions: PlanDecision[] = ["approved", "denied", "amended"];
    for (const status of decisions) {
      const block: PlanContentBlock = {
        type: "plan",
        planId: "plan-002",
        title: "T",
        steps: [],
        status,
      };
      expect(block.status).toBe(status);
    }
  });

  it("accepts optional rationale", () => {
    const block: PlanContentBlock = {
      type: "plan",
      planId: "plan-003",
      title: "T",
      steps: [],
      status: "pending",
      rationale: "Because efficiency",
    };
    expect(block.rationale).toBe("Because efficiency");
  });
});

// ── SubagentFanoutContentBlock ────────────────────────────────────────────────

describe("SubagentFanoutContentBlock", () => {
  it("constructs with children array and status", () => {
    const child: SubagentChild = {
      childMessageId: "msg-child-1",
      capability: "research.web",
      label: "Web search",
    };
    const block: SubagentFanoutContentBlock = {
      type: "subagent-fanout",
      fanoutId: "fan-001",
      parentMessageId: "msg-parent-1",
      children: [child],
      status: "running",
    };
    expect(block.type).toBe("subagent-fanout");
    expect(block.children).toHaveLength(1);
    const firstChild = block.children[0]!;
    expect(firstChild.childMessageId).toBe("msg-child-1");
    expect(firstChild.capability).toBe("research.web");
    expect(firstChild.label).toBe("Web search");
    expect(block.status).toBe("running");
  });

  it("SubagentChild label is optional", () => {
    const child: SubagentChild = {
      childMessageId: "msg-child-2",
      capability: "data.process",
    };
    expect(child.label).toBeUndefined();
  });

  it("accepts all SubagentStatus values", () => {
    const statuses: SubagentStatus[] = [
      "running",
      "completed",
      "partial",
      "timed_out",
    ];
    for (const status of statuses) {
      const block: SubagentFanoutContentBlock = {
        type: "subagent-fanout",
        fanoutId: "fan-002",
        parentMessageId: "msg-p",
        children: [],
        status,
      };
      expect(block.status).toBe(status);
    }
  });

  it("SubagentChild accepts optional status and resultPreview", () => {
    const child: SubagentChild = {
      childMessageId: "msg-child-3",
      capability: "analysis.text",
      status: "completed",
      resultPreview: { summary: "done" },
    };
    expect(child.status).toBe("completed");
    expect(child.resultPreview).toEqual({ summary: "done" });
  });
});

// ── MemoryRecallContentBlock ──────────────────────────────────────────────────

describe("MemoryRecallContentBlock and MemoryRecallHit", () => {
  it("MemoryRecallHit constructs with required fields", () => {
    const hit: MemoryRecallHit = {
      id: "mem-001",
      lesson: "Always validate input",
      memoryClass: "FACT",
      memoryKind: "constraint",
      confidenceScore: 95,
      enforcementScore: 100,
      score: 0.95,
    };
    expect(hit.id).toBe("mem-001");
    expect(hit.lesson).toBe("Always validate input");
    expect(hit.memoryClass).toBe("FACT");
    expect(hit.score).toBe(0.95);
    expect(hit.nodeRef).toBeUndefined();
  });

  it("MemoryRecallHit accepts optional nodeRef", () => {
    const hit: MemoryRecallHit = {
      id: "mem-002",
      lesson: "Use strict types",
      memoryClass: "OBSERVATION",
      memoryKind: "convention-deviation",
      confidenceScore: 70,
      enforcementScore: null,
      score: 0.7,
      nodeRef: "neo4j:node:42",
    };
    expect(hit.nodeRef).toBe("neo4j:node:42");
  });

  it("MemoryClass covers all values: OBSERVATION, RULE, FACT", () => {
    const classes: MemoryClass[] = ["OBSERVATION", "RULE", "FACT"];
    for (const memoryClass of classes) {
      const hit: MemoryRecallHit = {
        id: "mem-w",
        lesson: "test",
        memoryClass,
        memoryKind: "gotcha",
        confidenceScore: 50,
        enforcementScore: memoryClass === "OBSERVATION" ? null : 80,
        score: 0.5,
      };
      expect(hit.memoryClass).toBe(memoryClass);
    }
  });

  it("memoryClass accepts arbitrary string (open union with MemoryClass)", () => {
    const hit: MemoryRecallHit = {
      id: "mem-003",
      lesson: "Custom class",
      memoryClass: "custom-class-value",
      memoryKind: "gotcha",
      confidenceScore: 30,
      enforcementScore: null,
      score: 0.3,
    };
    expect(hit.memoryClass).toBe("custom-class-value");
  });

  it("MemoryRecallContentBlock constructs with memories array", () => {
    const block: MemoryRecallContentBlock = {
      type: "memory-recall",
      queryId: "q-001",
      memories: [
        {
          id: "m1",
          lesson: "L1",
          memoryClass: "FACT",
          memoryKind: "constraint",
          confidenceScore: 100,
          enforcementScore: 100,
          score: 1.0,
        },
      ],
    };
    expect(block.type).toBe("memory-recall");
    expect(block.queryId).toBe("q-001");
    expect(block.memories).toHaveLength(1);
  });
});

// ── ComponentContentBlock ─────────────────────────────────────────────────────

describe("ComponentContentBlock", () => {
  it("constructs with toolCallId, componentId, and props", () => {
    const block: ComponentContentBlock = {
      type: "component",
      toolCallId: "tc-comp-001",
      componentId: "file-attachment",
      props: { fileName: "report.pdf", size: 204800 },
    };
    expect(block.type).toBe("component");
    expect(block.toolCallId).toBe("tc-comp-001");
    expect(block.componentId).toBe("file-attachment");
    expect(block.props["fileName"]).toBe("report.pdf");
  });

  it("props is a Record<string, unknown> that accepts any shape", () => {
    const block: ComponentContentBlock = {
      type: "component",
      toolCallId: "tc-comp-002",
      componentId: "html-artifact",
      props: { html: "<html></html>", title: "My page", nested: { key: true } },
    };
    expect(block.props["nested"]).toEqual({ key: true });
  });
});

// ── RenderDirective ───────────────────────────────────────────────────────────

describe("RenderDirective", () => {
  it("constructs with componentId and props", () => {
    const directive: RenderDirective = {
      componentId: "metric-chart",
      props: { value: 42, label: "Revenue" },
    };
    expect(directive.componentId).toBe("metric-chart");
    expect(directive.props["value"]).toBe(42);
  });

  it("props Record accepts empty object", () => {
    const directive: RenderDirective = {
      componentId: "empty-component",
      props: {},
    };
    expect(directive.props).toEqual({});
  });
});

// ── TurnUsage ─────────────────────────────────────────────────────────────────

describe("TurnUsage", () => {
  it("constructs with all required numeric fields", () => {
    const usage: TurnUsage = {
      promptTokens: 1500,
      completionTokens: 300,
      totalTokens: 1800,
    };
    expect(usage.promptTokens).toBe(1500);
    expect(usage.completionTokens).toBe(300);
    expect(usage.totalTokens).toBe(1800);
    expect(usage.creditsCharged).toBeUndefined();
  });

  it("accepts optional creditsCharged", () => {
    const usage: TurnUsage = {
      promptTokens: 2000,
      completionTokens: 500,
      totalTokens: 2500,
      creditsCharged: 3,
    };
    expect(usage.creditsCharged).toBe(3);
  });
});

// ── PlanStep ──────────────────────────────────────────────────────────────────

describe("PlanStep", () => {
  it("constructs with all required fields; capability is nullable", () => {
    const step: PlanStep = {
      id: "s-001",
      summary: "Search the web",
      intent: "retrieve information",
      capability: null,
      dependsOn: [],
    };
    expect(step.id).toBe("s-001");
    expect(step.capability).toBeNull();
    expect(step.dependsOn).toEqual([]);
  });

  it("accepts capability string and dependsOn array with ids", () => {
    const step: PlanStep = {
      id: "s-002",
      summary: "Process results",
      intent: "analyze",
      capability: "data.process",
      dependsOn: ["s-001"],
      inputPreview: { raw: "some data" },
    };
    expect(step.capability).toBe("data.process");
    expect(step.dependsOn).toContain("s-001");
    expect(step.inputPreview).toEqual({ raw: "some data" });
  });

  it("inputPreview is optional", () => {
    const step: PlanStep = {
      id: "s-003",
      summary: "Final step",
      intent: "summarize",
      capability: "summary.generate",
      dependsOn: ["s-001", "s-002"],
    };
    expect(step.inputPreview).toBeUndefined();
  });
});

// ── AssistantContentBlock union — discriminated narrowing ─────────────────────

describe("AssistantContentBlock union discriminant", () => {
  it("narrows to TextContentBlock via .type === 'text'", () => {
    const block: AssistantContentBlock = { type: "text", text: "hello" };
    if (block.type === "text") {
      expect(block.text).toBe("hello");
    } else {
      throw new Error("narrowing failed");
    }
  });

  it("narrows to ReasoningContentBlock via .type === 'reasoning'", () => {
    const block: AssistantContentBlock = {
      type: "reasoning",
      reasoningId: "r-x",
      text: "thinking",
    };
    if (block.type === "reasoning") {
      expect(block.reasoningId).toBe("r-x");
    } else {
      throw new Error("narrowing failed");
    }
  });

  it("narrows to ToolCallContentBlock via .type === 'tool-call'", () => {
    const block: AssistantContentBlock = {
      type: "tool-call",
      toolCallId: "tc-1",
      capability: "test",
      inputPreview: null,
      riskLevel: "low",
      status: "completed",
    };
    if (block.type === "tool-call") {
      expect(block.capability).toBe("test");
    } else {
      throw new Error("narrowing failed");
    }
  });

  it("narrows to CodeExecuteContentBlock via .type === 'code-execute'", () => {
    const block: AssistantContentBlock = {
      type: "code-execute",
      toolCallId: "ce-1",
      language: "node",
      code: "1+1",
      status: "completed",
    };
    if (block.type === "code-execute") {
      expect(block.language).toBe("node");
    } else {
      throw new Error("narrowing failed");
    }
  });

  it("narrows to PlanContentBlock via .type === 'plan'", () => {
    const block: AssistantContentBlock = {
      type: "plan",
      planId: "p-1",
      title: "Test plan",
      steps: [],
      status: "pending",
    };
    if (block.type === "plan") {
      expect(block.planId).toBe("p-1");
    } else {
      throw new Error("narrowing failed");
    }
  });

  it("narrows to ComponentContentBlock via .type === 'component'", () => {
    const block: AssistantContentBlock = {
      type: "component",
      toolCallId: "tc-c",
      componentId: "my-card",
      props: {},
    };
    if (block.type === "component") {
      expect(block.componentId).toBe("my-card");
    } else {
      throw new Error("narrowing failed");
    }
  });

  it("narrows to MemoryRecallContentBlock via .type === 'memory-recall'", () => {
    const block: AssistantContentBlock = {
      type: "memory-recall",
      queryId: "q-1",
      memories: [],
    };
    if (block.type === "memory-recall") {
      expect(block.queryId).toBe("q-1");
    } else {
      throw new Error("narrowing failed");
    }
  });

  it("narrows to ApprovalRequestContentBlock via .type === 'approval-request'", () => {
    const block: AssistantContentBlock = {
      type: "approval-request",
      approvalId: "ap-x",
      capability: "danger.op",
      inputPreview: null,
      riskLevel: "high",
      expiresAt: "2026-01-01T00:00:00Z",
    };
    if (block.type === "approval-request") {
      expect(block.approvalId).toBe("ap-x");
    } else {
      throw new Error("narrowing failed");
    }
  });

  it("narrows to ConsentRequestContentBlock via .type === 'consent-request'", () => {
    const block: AssistantContentBlock = {
      type: "consent-request",
      approvalId: "cp-x",
      capability: "mcp.tool",
      serverId: "srv",
      toolName: "tool",
      inputPreview: null,
      expiresAt: "2026-01-01T00:00:00Z",
    };
    if (block.type === "consent-request") {
      expect(block.serverId).toBe("srv");
    } else {
      throw new Error("narrowing failed");
    }
  });

  it("narrows to SubagentFanoutContentBlock via .type === 'subagent-fanout'", () => {
    const block: AssistantContentBlock = {
      type: "subagent-fanout",
      fanoutId: "fan-x",
      parentMessageId: "msg-p",
      children: [],
      status: "completed",
    };
    if (block.type === "subagent-fanout") {
      expect(block.fanoutId).toBe("fan-x");
    } else {
      throw new Error("narrowing failed");
    }
  });
});

// ── StreamEvent union — key member shapes ─────────────────────────────────────

describe("StreamEvent union — member shapes", () => {
  it("'text' event has messageId and text", () => {
    const evt: StreamEvent = {
      type: "text",
      messageId: "msg-1",
      text: "streaming token",
    };
    expect(evt.type).toBe("text");
    if (evt.type === "text") {
      expect(evt.messageId).toBe("msg-1");
      expect(evt.text).toBe("streaming token");
    }
  });

  it("'tool-call-start' event has capability, inputPreview, riskLevel", () => {
    const evt: StreamEvent = {
      type: "tool-call-start",
      messageId: "msg-2",
      toolCallId: "tc-ev",
      capability: "search_web",
      inputPreview: { query: "test" },
      riskLevel: "low",
    };
    expect(evt.type).toBe("tool-call-start");
    if (evt.type === "tool-call-start") {
      expect(evt.capability).toBe("search_web");
      expect(evt.riskLevel).toBe("low");
    }
  });

  it("'plan-proposed' event has planId, title, steps", () => {
    const evt: StreamEvent = {
      type: "plan-proposed",
      planId: "plan-ev-1",
      title: "My plan",
      steps: [
        {
          id: "s1",
          summary: "step one",
          intent: "do",
          capability: null,
          dependsOn: [],
        },
      ],
    };
    expect(evt.type).toBe("plan-proposed");
    if (evt.type === "plan-proposed") {
      expect(evt.planId).toBe("plan-ev-1");
      expect(evt.steps).toHaveLength(1);
      expect(evt.rationale).toBeUndefined();
    }
  });

  it("'component' event has toolCallId, componentId, props", () => {
    const evt: StreamEvent = {
      type: "component",
      toolCallId: "tc-comp-ev",
      componentId: "file-attachment",
      props: { name: "file.txt" },
    };
    expect(evt.type).toBe("component");
    if (evt.type === "component") {
      expect(evt.componentId).toBe("file-attachment");
      expect(evt.props["name"]).toBe("file.txt");
    }
  });

  it("'usage' event carries TurnUsage shape", () => {
    const evt: StreamEvent = {
      type: "usage",
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    };
    expect(evt.type).toBe("usage");
    if (evt.type === "usage") {
      expect(evt.usage.totalTokens).toBe(150);
      expect(evt.usage.creditsCharged).toBeUndefined();
    }
  });

  it("'reasoning-start' event has messageId and reasoningId", () => {
    const evt: StreamEvent = {
      type: "reasoning-start",
      messageId: "msg-rs",
      reasoningId: "r-start",
    };
    expect(evt.type).toBe("reasoning-start");
    if (evt.type === "reasoning-start") {
      expect(evt.reasoningId).toBe("r-start");
    }
  });

  it("'reasoning-end' event has reasoningId and durationMs", () => {
    const evt: StreamEvent = {
      type: "reasoning-end",
      reasoningId: "r-end",
      durationMs: 1200,
    };
    expect(evt.type).toBe("reasoning-end");
    if (evt.type === "reasoning-end") {
      expect(evt.durationMs).toBe(1200);
    }
  });

  it("'tool-call-end' event has status and durationMs", () => {
    const evt: StreamEvent = {
      type: "tool-call-end",
      toolCallId: "tc-end",
      status: "completed",
      durationMs: 400,
    };
    expect(evt.type).toBe("tool-call-end");
    if (evt.type === "tool-call-end") {
      expect(evt.status).toBe("completed");
      expect(evt.durationMs).toBe(400);
      expect(evt.errorReason).toBeUndefined();
    }
  });

  it("'approval-required' event has approvalId, expiresAt, riskLevel", () => {
    const evt: StreamEvent = {
      type: "approval-required",
      approvalId: "ap-ev",
      capability: "danger.rm",
      inputPreview: null,
      riskLevel: "high",
      expiresAt: "2026-12-31T23:59:59Z",
    };
    expect(evt.type).toBe("approval-required");
    if (evt.type === "approval-required") {
      expect(evt.expiresAt).toBe("2026-12-31T23:59:59Z");
    }
  });

  it("'consent-required' event has serverId and toolName", () => {
    const evt: StreamEvent = {
      type: "consent-required",
      approvalId: "cp-ev",
      capability: "mcp.external",
      serverId: "github-mcp",
      toolName: "create_issue",
      inputPreview: { title: "Bug" },
      expiresAt: "2026-12-31T23:59:59Z",
    };
    expect(evt.type).toBe("consent-required");
    if (evt.type === "consent-required") {
      expect(evt.serverId).toBe("github-mcp");
      expect(evt.toolName).toBe("create_issue");
    }
  });

  it("'memory-recalled' event has queryId and memories array", () => {
    const evt: StreamEvent = {
      type: "memory-recalled",
      queryId: "qid-1",
      memories: [
        {
          id: "m1",
          lesson: "be careful",
          memoryClass: "FACT",
          memoryKind: "constraint",
          confidenceScore: 90,
          enforcementScore: 100,
          score: 0.9,
        },
      ],
    };
    expect(evt.type).toBe("memory-recalled");
    if (evt.type === "memory-recalled") {
      expect(evt.memories).toHaveLength(1);
    }
  });

  it("'subagent-dispatched' event has fanoutId and children", () => {
    const evt: StreamEvent = {
      type: "subagent-dispatched",
      fanoutId: "fan-ev",
      parentMessageId: "msg-par",
      children: [{ childMessageId: "c1", capability: "search.web" }],
    };
    expect(evt.type).toBe("subagent-dispatched");
    if (evt.type === "subagent-dispatched") {
      expect(evt.children).toHaveLength(1);
      expect(evt.children[0]!.childMessageId).toBe("c1");
    }
  });

  it("'tool-call-output' chunk has channel and data", () => {
    const evt: StreamEvent = {
      type: "tool-call-output",
      toolCallId: "tc-out",
      chunk: { channel: "stdout", data: "line 1\n" },
    };
    expect(evt.type).toBe("tool-call-output");
    if (evt.type === "tool-call-output") {
      expect(evt.chunk.channel).toBe("stdout");
      expect(evt.chunk.data).toBe("line 1\n");
    }
  });

  it("'step-start' event has messageId and stepIndex", () => {
    const evt: StreamEvent = {
      type: "step-start",
      messageId: "msg-step",
      stepIndex: 0,
    };
    expect(evt.type).toBe("step-start");
    if (evt.type === "step-start") {
      expect(evt.stepIndex).toBe(0);
    }
  });

  it("'tool-input-start' event has toolCallId and capability", () => {
    const evt: StreamEvent = {
      type: "tool-input-start",
      messageId: "msg-tis",
      toolCallId: "tc-tis",
      capability: "file.read",
    };
    expect(evt.type).toBe("tool-input-start");
    if (evt.type === "tool-input-start") {
      expect(evt.capability).toBe("file.read");
    }
  });

  it("'error' event has messageId, message, and optional code", () => {
    const evt: StreamEvent = {
      type: "error",
      messageId: "msg-err",
      message: "Insufficient credits: your balance is empty.",
      code: "insufficient_credits",
    };
    expect(evt.type).toBe("error");
    if (evt.type === "error") {
      expect(evt.messageId).toBe("msg-err");
      expect(evt.message).toBe("Insufficient credits: your balance is empty.");
      expect(evt.code).toBe("insufficient_credits");
    }
  });

  it("'error' event code is optional", () => {
    const evt: StreamEvent = {
      type: "error",
      messageId: "msg-err-2",
      message: "Gateway timeout",
    };
    expect(evt.type).toBe("error");
    if (evt.type === "error") {
      expect(evt.code).toBeUndefined();
    }
  });
});
