/**
 * tool-call-meta.test.ts
 *
 * Tests for the capability → { label, Icon } mapping:
 *   - Curated hits return their hand-written labels
 *   - Fallback derivation converts verb_noun ordering into "Verb noun"
 *   - Underscores read as spaces
 *   - Domain icons resolve from any segment; Wrench is the fallback
 */

import { describe, it, expect } from "vitest";
import {
  Bot,
  Brain,
  CreditCard,
  GitBranch,
  MessageSquare,
  Network,
  Paperclip,
  ScrollText,
  Search,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import {
  deriveToolCallLabel,
  toolCallIcon,
  toolCallMeta,
} from "./tool-call-meta";

describe("toolCallMeta — curated map", () => {
  it("maps list_agent_defs to 'List agents' with Bot (not the derived label)", () => {
    const meta = toolCallMeta("list_agent_defs");
    expect(meta.label).toBe("List agents");
    expect(meta.Icon).toBe(Bot);
  });

  it("maps the fleet-evidence capabilities to friendly labels", () => {
    expect(toolCallMeta("list_agent_executions").label).toBe("List agent runs");
    expect(toolCallMeta("get_agent_trace").label).toBe("Read run trace");
    expect(toolCallMeta("query_audit_log").label).toBe("Query the audit log");
    expect(toolCallMeta("get_agent_trace").Icon).toBe(ScrollText);
  });

  it("maps the governance capabilities with the shield icon", () => {
    expect(toolCallMeta("list_iam_roles").label).toBe("List IAM roles");
    expect(toolCallMeta("list_iam_roles").Icon).toBe(ShieldCheck);
    expect(toolCallMeta("resolve_approval").label).toBe("Resolve approval");
  });

  it("maps the metering capabilities with the billing icon", () => {
    expect(toolCallMeta("get_usage_breakdown").label).toBe(
      "Read usage breakdown",
    );
    expect(toolCallMeta("get_usage_breakdown").Icon).toBe(CreditCard);
  });

  it("maps knowledge graph capabilities", () => {
    expect(toolCallMeta("query_ontology").label).toBe("Query knowledge graph");
    expect(toolCallMeta("get_ontology_neighbors").label).toBe(
      "Explore graph neighbors",
    );
    expect(toolCallMeta("query_ontology").Icon).toBe(Network);
  });

  it("maps conversation/file capabilities", () => {
    expect(toolCallMeta("list_conversation_files").label).toBe(
      "List conversation files",
    );
    expect(toolCallMeta("upload_asset").label).toBe("Upload file");
  });

  it("no longer curates any excised runtime capability (ADR-041)", () => {
    // A retired capability name has no curated entry — it falls through to the
    // derivation, which is exactly what a legacy persisted tool call needs.
    expect(toolCallMeta("execute_code").label).toBe("Execute code");
    expect(toolCallMeta("run_sandbox_command").label).toBe(
      "Run sandbox command",
    );
    expect(toolCallMeta("dispatch_subagent").label).toBe("Dispatch subagent");
  });
});

describe("deriveToolCallLabel — fallback derivation", () => {
  it("converts verb_noun ordering into 'Verb noun' title case", () => {
    expect(deriveToolCallLabel("get_ontology_neighbors")).toBe(
      "Get ontology neighbors",
    );
  });

  it("handles two-segment capabilities", () => {
    expect(deriveToolCallLabel("list_notifications")).toBe(
      "List notifications",
    );
  });

  it("keeps a two-segment agent capability intact", () => {
    expect(deriveToolCallLabel("deploy_agent")).toBe("Deploy agent");
  });

  it("reads underscores as spaces", () => {
    expect(deriveToolCallLabel("list_agent_executions")).toBe(
      "List agent executions",
    );
  });

  it("title-cases a single segment", () => {
    expect(deriveToolCallLabel("ping")).toBe("Ping");
  });

  it("is used by toolCallMeta for uncurated capabilities", () => {
    expect(toolCallMeta("list_notifications").label).toBe("List notifications");
  });

  it("never returns the raw dotted string for a dotted capability", () => {
    expect(toolCallMeta("list_secret_keys").label).not.toContain(".");
  });
});

describe("toolCallIcon — domain icons", () => {
  it("resolves icons from any name segment", () => {
    expect(toolCallIcon("create_branch")).toBe(GitBranch);
    expect(toolCallIcon("query_ontology")).toBe(Network);
    expect(toolCallIcon("send_message")).toBe(MessageSquare);
    expect(toolCallIcon("add_conversation_attachment")).toBe(MessageSquare);
    expect(toolCallIcon("upload_asset")).toBe(Paperclip);
    expect(toolCallIcon("search_nodes")).toBe(Search);
    expect(toolCallIcon("recall_memory")).toBe(Brain);
    expect(toolCallIcon("query_audit_log")).toBe(ScrollText);
    expect(toolCallIcon("get_budget_policy")).toBe(CreditCard);
    expect(toolCallIcon("resolve_consent")).toBe(ShieldCheck);
  });

  it("falls back to Wrench for unknown domains", () => {
    expect(toolCallIcon("totally.unknown.capability")).toBe(Wrench);
    expect(toolCallMeta("totally.unknown.capability").Icon).toBe(Wrench);
  });
});
