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
import { deriveToolCallLabel, toolCallIcon, toolCallMeta } from "./tool-call-meta";

describe("toolCallMeta — curated map", () => {
  it("maps agent.code.execute to 'Run code' with the Code2 icon", () => {
    const meta = toolCallMeta("agent.code.execute");
    expect(meta.label).toBe("Run code");
    expect(meta.Icon).toBe(Code2);
  });

  it("maps agent.sandbox.exec to 'Run command in sandbox' with Terminal", () => {
    const meta = toolCallMeta("agent.sandbox.exec");
    expect(meta.label).toBe("Run command in sandbox");
    expect(meta.Icon).toBe(Terminal);
  });

  it("maps agent.definition.list to 'List agents' with Bot (not the derived 'List definition')", () => {
    const meta = toolCallMeta("agent.definition.list");
    expect(meta.label).toBe("List agents");
    expect(meta.Icon).toBe(Bot);
  });

  it("maps repo.pr.open to 'Open pull request' with the repo domain icon", () => {
    const meta = toolCallMeta("repo.pr.open");
    expect(meta.label).toBe("Open pull request");
    expect(meta.Icon).toBe(GitBranch);
  });

  it("maps common generation capabilities to friendly labels", () => {
    expect(toolCallMeta("image.generate").label).toBe("Generate image");
    expect(toolCallMeta("svg.generate").label).toBe("Generate SVG");
    expect(toolCallMeta("mermaid.generate").label).toBe("Generate diagram");
    expect(toolCallMeta("video.generate").label).toBe("Generate video");
    expect(toolCallMeta("markdown.generate").label).toBe("Generate document");
    expect(toolCallMeta("document.pdf.create").label).toBe("Create PDF");
  });

  it("maps knowledge graph capabilities", () => {
    expect(toolCallMeta("ontology.query").label).toBe("Query knowledge graph");
    expect(toolCallMeta("ontology.neighbors").label).toBe("Explore graph neighbors");
    expect(toolCallMeta("ontology.query").Icon).toBe(Network);
  });

  it("maps conversation/file capabilities", () => {
    expect(toolCallMeta("conversation.files.list").label).toBe(
      "List conversation files",
    );
    expect(toolCallMeta("asset.upload").label).toBe("Upload file");
    expect(toolCallMeta("web.search").label).toBe("Search the web");
  });
});

describe("deriveToolCallLabel — fallback derivation", () => {
  it("converts verb.noun ordering into 'Verb noun' title case", () => {
    expect(deriveToolCallLabel("semantic.edge.suggest")).toBe(
      "Suggest semantic edge",
    );
  });

  it("handles two-segment capabilities", () => {
    expect(deriveToolCallLabel("notification.list")).toBe("List notification");
  });

  it("drops the generic 'agent' prefix when more segments remain", () => {
    expect(deriveToolCallLabel("agent.trigger.create")).toBe("Create trigger");
  });

  it("keeps a two-segment agent capability intact", () => {
    expect(deriveToolCallLabel("agent.deploy")).toBe("Deploy agent");
  });

  it("reads underscores as spaces", () => {
    expect(deriveToolCallLabel("agent.background_task.start")).toBe(
      "Start background task",
    );
  });

  it("title-cases a single segment", () => {
    expect(deriveToolCallLabel("ping")).toBe("Ping");
  });

  it("is used by toolCallMeta for uncurated capabilities", () => {
    expect(toolCallMeta("semantic.edge.suggest").label).toBe(
      "Suggest semantic edge",
    );
  });

  it("never returns the raw dotted string for a dotted capability", () => {
    expect(toolCallMeta("secret.key.list").label).not.toContain(".");
  });
});

describe("toolCallIcon — domain icons", () => {
  it("resolves icons from any dot segment", () => {
    expect(toolCallIcon("repo.branch.create")).toBe(GitBranch);
    expect(toolCallIcon("agent.sandbox.stop")).toBe(Terminal);
    expect(toolCallIcon("image.analyze")).toBe(ImageIcon);
    expect(toolCallIcon("video.generate")).toBe(Video);
    expect(toolCallIcon("document.read")).toBe(FileText);
    expect(toolCallIcon("semantic.relationship.infer")).toBe(Network);
    expect(toolCallIcon("chat.message.send")).toBe(MessageSquare);
    expect(toolCallIcon("conversation.attachment.add")).toBe(MessageSquare);
    expect(toolCallIcon("asset.upload")).toBe(Paperclip);
    expect(toolCallIcon("web.fetch")).toBe(Search);
    expect(toolCallIcon("agent.memory.recall")).toBe(Brain);
  });

  it("falls back to Wrench for unknown domains", () => {
    expect(toolCallIcon("totally.unknown.capability")).toBe(Wrench);
    expect(toolCallMeta("totally.unknown.capability").Icon).toBe(Wrench);
  });
});
