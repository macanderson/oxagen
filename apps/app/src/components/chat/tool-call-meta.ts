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
 *      title case (e.g. `ontology.query` → "Query ontology").
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
  execute_code: { label: "Run code", Icon: Code2 },
  run_sandbox_command: { label: "Run command in sandbox", Icon: Terminal },
  start_sandbox: { label: "Start sandbox", Icon: Terminal },
  stop_sandbox: { label: "Stop sandbox", Icon: Terminal },
  snapshot_sandbox: { label: "Snapshot sandbox", Icon: Terminal },
  list_sandbox_files: { label: "List sandbox files", Icon: Terminal },
  diff_code: { label: "Compare code" },
  format_code: { label: "Format code" },
  patch_code: { label: "Apply code patch" },
  // Repo
  open_pr: { label: "Open pull request" },
  create_branch: { label: "Create branch" },
  create_repo: { label: "Create repository" },
  fork_repo: { label: "Fork repository" },
  sync_repo: { label: "Sync repository" },
  put_repo_file: { label: "Update repository file" },
  get_repo_metrics: { label: "Read repository metrics" },
  edit_repo_file: { label: "Edit repository" },
  // Media + documents
  generate_image: { label: "Generate image" },
  create_image: { label: "Create image" },
  analyze_image: { label: "Analyze image" },
  generate_svg: { label: "Generate SVG" },
  generate_mermaid: { label: "Generate diagram", Icon: Network },
  generate_video: { label: "Generate video" },
  generate_markdown: { label: "Generate document" },
  generate_document: { label: "Generate document" },
  create_document: { label: "Create document" },
  read_document: { label: "Read document" },
  list_documents: { label: "List documents" },
  create_pdf: { label: "Create PDF" },
  // Knowledge graph
  query_ontology: { label: "Query knowledge graph" },
  get_ontology_neighbors: { label: "Explore graph neighbors" },
  search_graph: { label: "Search knowledge graph" },
  search_nodes: { label: "Search graph nodes" },
  get_graph_stats: { label: "Read graph statistics" },
  // Conversation + files
  list_conversation_files: { label: "List conversation files" },
  add_conversation_attachment: { label: "Add attachment" },
  send_message: { label: "Send message" },
  upload_asset: { label: "Upload file" },
  // Web + browser
  search_web: { label: "Search the web" },
  fetch_web_page: { label: "Fetch web page" },
  navigate_page: { label: "Open web page" },
  screenshot_page: { label: "Take screenshot" },
  read_page: { label: "Read web page" },
  // Workflows + agents
  list_agent_defs: { label: "List agents", Icon: Bot },
  run_workflow: { label: "Run workflow" },
  cancel_workflow: { label: "Cancel workflow" },
  get_workflow_status: { label: "Check workflow status" },
  dispatch_subagent: { label: "Dispatch subagent" },
  aggregate_subagents: { label: "Aggregate subagent results" },
  render_agent_ui: { label: "Render interactive view" },
  verify_feature: { label: "Verify feature" },
  fill_form: { label: "Fill form" },
  // Memory
  recall_memory: { label: "Recall memory" },
  save_memory: { label: "Save memory" },
  write_memory: { label: "Save memory" },
  list_memories: { label: "List memories" },
  // Research
  start_research_swarm: { label: "Start research swarm" },
  get_research_status: { label: "Check research status" },
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
  branch: GitBranch,
  pr: GitBranch,
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
function capitalize(text: string): string {
  return text.length === 0
    ? text
    : text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Derivation fallback for an uncurated capability. ADR-025 names are verb-first
 * snake_case (`verb_noun_qualifier`), so the FIRST segment is the verb and the
 * rest form the noun phrase: `get_ontology_neighbors` → "Get ontology
 * neighbors". Splits on `_` or `.` so a legacy dotted or an MCP synthetic name is
 * still rendered readably.
 */
export function deriveToolCallLabel(capability: string): string {
  const segments = capability
    .split(/[._]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const first = segments[0];
  if (first === undefined) return capability;
  if (segments.length === 1) return capitalize(first);
  const verb = first;
  const nounPhrase = segments.slice(1).join(" ");
  return capitalize(`${verb} ${nounPhrase}`.trim());
}

/** Resolve the domain icon for a capability; `Wrench` when no keyword matches. */
export function toolCallIcon(capability: string): LucideIcon {
  for (const segment of capability.split(/[._]/)) {
    const icon = DOMAIN_ICONS[segment.trim().toLowerCase()];
    if (icon) return icon;
  }
  return Wrench;
}

/** Human-readable label + domain icon for a capability string. */
export function toolCallMeta(capability: string): ToolCallMeta {
  const curated = CURATED[capability];
  if (curated) {
    return {
      label: curated.label,
      Icon: curated.Icon ?? toolCallIcon(capability),
    };
  }
  return {
    label: deriveToolCallLabel(capability),
    Icon: toolCallIcon(capability),
  };
}
