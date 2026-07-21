/**
 * tool-call-meta.test.ts
 *
 * Tests for the capability → { label, Icon } mapping:
 *   - Curated hits return their hand-written labels
 *   - Fallback derivation converts verb.noun ordering into "Verb noun"
 *   - Generic "agent." prefix is dropped in derived labels
 *   - Underscores read as spaces
 *   - Domain icons resolve from any segment; Wrench is the fallback
 */

import { describe, it, expect } from "vitest";
import {
  Bot,
  Brain,
  Code2,
  FileText,
  GitBranch,
  ImageIcon,
  MessageSquare,
  Network,
  Paperclip,
  Search,
  Terminal,
  Video,
  Wrench,
} from "lucide-react";
import {
  deriveToolCallLabel,
  toolCallIcon,
  toolCallMeta,
} from "./tool-call-meta";

describe("toolCallMeta — curated map", () => {
  it("maps agent.code.execute to 'Run code' with the Code2 icon", () => {
    const meta = toolCallMeta("execute_code");
    expect(meta.label).toBe("Run code");
    expect(meta.Icon).toBe(Code2);
  });

  it("maps agent.sandbox.exec to 'Run command in sandbox' with Terminal", () => {
    const meta = toolCallMeta("run_sandbox_command");
    expect(meta.label).toBe("Run command in sandbox");
    expect(meta.Icon).toBe(Terminal);
  });

  it("maps list_agent_defs to 'List agents' with Bot (not the derived label)", () => {
    const meta = toolCallMeta("list_agent_defs");
    expect(meta.label).toBe("List agents");
    expect(meta.Icon).toBe(Bot);
  });

  it("maps repo.pr.open to 'Open pull request' with the repo domain icon", () => {
    const meta = toolCallMeta("open_pr");
    expect(meta.label).toBe("Open pull request");
    expect(meta.Icon).toBe(GitBranch);
  });

  it("maps common generation capabilities to friendly labels", () => {
    expect(toolCallMeta("generate_image").label).toBe("Generate image");
    expect(toolCallMeta("generate_svg").label).toBe("Generate SVG");
    expect(toolCallMeta("generate_mermaid").label).toBe("Generate diagram");
    expect(toolCallMeta("generate_video").label).toBe("Generate video");
    expect(toolCallMeta("generate_markdown").label).toBe("Generate document");
    expect(toolCallMeta("create_pdf").label).toBe("Create PDF");
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
    expect(toolCallMeta("search_web").label).toBe("Search the web");
  });
});

describe("deriveToolCallLabel — fallback derivation", () => {
  it("converts verb.noun ordering into 'Verb noun' title case", () => {
    expect(deriveToolCallLabel("get_ontology_neighbors")).toBe(
      "Get ontology neighbors",
    );
  });

  it("handles two-segment capabilities", () => {
    expect(deriveToolCallLabel("list_notifications")).toBe(
      "List notifications",
    );
  });

  it("drops the generic 'agent' prefix when more segments remain", () => {
    expect(deriveToolCallLabel("create_trigger")).toBe("Create trigger");
  });

  it("keeps a two-segment agent capability intact", () => {
    expect(deriveToolCallLabel("deploy_agent")).toBe("Deploy agent");
  });

  it("reads underscores as spaces", () => {
    expect(deriveToolCallLabel("start_background_task")).toBe(
      "Start background task",
    );
  });

  it("title-cases a single segment", () => {
    expect(deriveToolCallLabel("ping")).toBe("Ping");
  });

  it("is used by toolCallMeta for uncurated capabilities", () => {
    expect(toolCallMeta("query_ontology").label).toBe("Query knowledge graph");
  });

  it("never returns the raw dotted string for a dotted capability", () => {
    expect(toolCallMeta("list_secret_keys").label).not.toContain(".");
  });
});

describe("toolCallIcon — domain icons", () => {
  it("resolves icons from any dot segment", () => {
    expect(toolCallIcon("create_branch")).toBe(GitBranch);
    expect(toolCallIcon("stop_sandbox")).toBe(Terminal);
    expect(toolCallIcon("analyze_image")).toBe(ImageIcon);
    expect(toolCallIcon("generate_video")).toBe(Video);
    expect(toolCallIcon("read_document")).toBe(FileText);
    expect(toolCallIcon("query_ontology")).toBe(Network);
    expect(toolCallIcon("send_message")).toBe(MessageSquare);
    expect(toolCallIcon("add_conversation_attachment")).toBe(MessageSquare);
    expect(toolCallIcon("upload_asset")).toBe(Paperclip);
    expect(toolCallIcon("fetch_web_page")).toBe(Search);
    expect(toolCallIcon("recall_memory")).toBe(Brain);
  });

  it("falls back to Wrench for unknown domains", () => {
    expect(toolCallIcon("totally.unknown.capability")).toBe(Wrench);
    expect(toolCallMeta("totally.unknown.capability").Icon).toBe(Wrench);
  });
});
