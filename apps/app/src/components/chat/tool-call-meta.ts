import {
  Bot,
  Brain,
  Code2,
  FileText,
  GitBranch,
  Globe,
  ImageIcon,
  KeyRound,
  MessageSquare,
  Network,
  Paperclip,
  Search,
  Terminal,
  Video,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * tool-call-meta — maps raw dotted capability names (e.g. `agent.code.execute`)
 * to a human-readable label and a domain icon for the chat tool-call UI.
 *
 * Two layers:
 *   1. A curated map for the frequent capabilities, hand-written for clarity.
 *   2. A derivation fallback that turns `domain.noun.verb` into "Verb noun"
 *      title case (e.g. `semantic.edge.suggest` → "Suggest semantic edge").
 *
 * The raw dotted string must never be the primary on-screen label — it belongs
 * in the expanded detail body and `title` attributes only.
 */

export interface ToolCallMeta {
  label: string;
  Icon: LucideIcon;
}

// Curated labels for common capabilities. Icons resolve via the domain map
// below unless overridden here.
const CURATED: Record<string, { label: string; Icon?: LucideIcon }> = {
  // Code + sandbox
  "agent.code.execute": { label: "Run code", Icon: Code2 },
  "agent.sandbox.exec": { label: "Run command in sandbox", Icon: Terminal },
  "agent.sandbox.start": { label: "Start sandbox", Icon: Terminal },
  "agent.sandbox.stop": { label: "Stop sandbox", Icon: Terminal },
  "agent.sandbox.snapshot": { label: "Snapshot sandbox", Icon: Terminal },
  "agent.sandbox_file.list": { label: "List sandbox files", Icon: Terminal },
  "code.diff": { label: "Compare code" },
  "code.format": { label: "Format code" },
  "code.patch": { label: "Apply code patch" },
  "code.map": { label: "Map codebase" },
  // Repo
  "repo.pr.open": { label: "Open pull request" },
  "repo.branch.create": { label: "Create branch" },
  "repo.create": { label: "Create repository" },
  "repo.fork": { label: "Fork repository" },
  "repo.sync": { label: "Sync repository" },
  "repo.file.put": { label: "Update repository file" },
  "repo.metrics": { label: "Read repository metrics" },
  "agent.repo.edit": { label: "Edit repository" },
  // Media + documents
  "image.generate": { label: "Generate image" },
  "image.create": { label: "Create image" },
  "image.analyze": { label: "Analyze image" },
  "svg.generate": { label: "Generate SVG" },
  "mermaid.generate": { label: "Generate diagram", Icon: Network },
  "video.generate": { label: "Generate video" },
  "markdown.generate": { label: "Generate document" },
  "document.generate": { label: "Generate document" },
  "document.create": { label: "Create document" },
  "document.read": { label: "Read document" },
  "document.list": { label: "List documents" },
  "document.pdf.create": { label: "Create PDF" },
  // Knowledge graph
  "ontology.query": { label: "Query knowledge graph" },
  "ontology.neighbors": { label: "Explore graph neighbors" },
  "graph.search": { label: "Search knowledge graph" },
  "graph.cypher": { label: "Query knowledge graph" },
  "graph.node.search": { label: "Search graph nodes" },
  "graph.stats": { label: "Read graph statistics" },
  // Conversation + files
  "conversation.files.list": { label: "List conversation files" },
  "conversation.attachment.add": { label: "Add attachment" },
  "chat.message.send": { label: "Send message" },
  "asset.upload": { label: "Upload file" },
  // Web + browser
  "web.search": { label: "Search the web" },
  "web.fetch": { label: "Fetch web page" },
  "browser.navigate": { label: "Open web page" },
  "browser.screenshot": { label: "Take screenshot" },
  "browser.read": { label: "Read web page" },
  // Workflows + agents
  "agent.definition.list": { label: "List agents", Icon: Bot },
  "workflow.run": { label: "Run workflow" },
  "workflow.cancel": { label: "Cancel workflow" },
  "workflow.status": { label: "Check workflow status" },
  "agent.subagent.dispatch": { label: "Dispatch subagent" },
  "agent.subagent.aggregate": { label: "Aggregate subagent results" },
  "render_agent_ui": { label: "Render interactive view" },
  "agent.feature.verify": { label: "Verify feature" },
  "form.fill": { label: "Fill form" },
  // Memory
  "agent.memory.recall": { label: "Recall memory" },
  "agent.memory.remember": { label: "Save memory" },
  "agent.memory.write": { label: "Save memory" },
  "agent.memory.list": { label: "List memories" },
  // Research
  "research.swarm.start": { label: "Start research swarm" },
  "research.swarm.status": { label: "Check research status" },
};

// Domain keyword → icon. Checked against each dot-segment in order, so
// `agent.code.execute` resolves via `code` and `agent.sandbox.exec` via
// `sandbox`.
const DOMAIN_ICONS: Record<string, LucideIcon> = {
  code: Code2,
  sandbox: Terminal,
  shell: Terminal,
  repo: GitBranch,
  git: GitBranch,
  image: ImageIcon,
  svg: ImageIcon,
  video: Video,
  document: FileText,
  pdf: FileText,
  markdown: FileText,
  ontology: Network,
  graph: Network,
  semantic: Network,
  schema: Network,
  conversation: MessageSquare,
  chat: MessageSquare,
  message: MessageSquare,
  asset: Paperclip,
  file: Paperclip,
  files: Paperclip,
  attachment: Paperclip,
  upload: Paperclip,
  search: Search,
  web: Search,
  browser: Globe,
  memory: Brain,
  workflow: Workflow,
  automation: Workflow,
  secret: KeyRound,
  key: KeyRound,
};

// Leading segments that add no meaning to a derived label ("agent" prefixes
// most runtime capabilities without describing what the call does).
const GENERIC_PREFIXES = new Set(["agent"]);

function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Derivation fallback: `domain.noun.verb` → "Verb domain noun". The final
 * segment is treated as the verb and the preceding segments as the noun
 * phrase, matching the contract naming convention (`semantic.edge.suggest` →
 * "Suggest semantic edge"). Underscores read as spaces.
 */
export function deriveToolCallLabel(capability: string): string {
  const segments = capability
    .split(".")
    .map((s) => s.trim().replace(/_/g, " ").toLowerCase())
    .filter(Boolean);
  const first = segments[0];
  if (first === undefined) return capability;
  if (segments.length === 1) return capitalize(first);
  const meaningful =
    segments.length > 2 && GENERIC_PREFIXES.has(first) ? segments.slice(1) : segments;
  const verb = meaningful[meaningful.length - 1];
  const nounPhrase = meaningful.slice(0, -1).join(" ");
  return capitalize(`${verb} ${nounPhrase}`.trim());
}

/** Resolve the domain icon for a capability; `Wrench` when no domain matches. */
export function toolCallIcon(capability: string): LucideIcon {
  for (const segment of capability.split(".")) {
    const icon = DOMAIN_ICONS[segment.trim().toLowerCase()];
    if (icon) return icon;
  }
  return Wrench;
}

/** Human-readable label + domain icon for a capability string. */
export function toolCallMeta(capability: string): ToolCallMeta {
  const curated = CURATED[capability];
  if (curated) {
    return { label: curated.label, Icon: curated.Icon ?? toolCallIcon(capability) };
  }
  return { label: deriveToolCallLabel(capability), Icon: toolCallIcon(capability) };
}
