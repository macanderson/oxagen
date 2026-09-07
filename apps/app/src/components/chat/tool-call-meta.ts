import {
  Bot,
  Brain,
  CreditCard,
  FileText,
  GitBranch,
  KeyRound,
  MessageSquare,
  Network,
  Paperclip,
  ScrollText,
  Search,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * tool-call-meta — maps a raw capability name (e.g. `query_audit_log`) to a
 * human-readable label and a domain icon for the chat tool-call UI.
 *
 * Two layers:
 *   1. A curated map for the frequent capabilities, hand-written for clarity.
 *   2. A derivation fallback that reads the ADR-025 verb-first snake_case name
 *      as `verb_noun` and title-cases it (e.g. `query_ontology` → "Query
 *      ontology"). It also splits on `.` so a legacy dotted name still renders.
 *
 * The raw capability string must never be the primary on-screen label — it
 * belongs in the expanded detail body and `title` attributes only.
 */

export interface ToolCallMeta {
  label: string;
  Icon: LucideIcon;
}

// Curated labels for common capabilities. Icons resolve via the domain map
// below unless overridden here.
const CURATED: Record<string, { label: string; Icon?: LucideIcon }> = {
  // Knowledge graph
  query_ontology: { label: "Query knowledge graph" },
  get_ontology_neighbors: { label: "Explore graph neighbors" },
  search_graph: { label: "Search knowledge graph" },
  search_nodes: { label: "Search graph nodes" },
  get_node: { label: "Read graph node" },
  get_graph_stats: { label: "Read graph statistics" },
  // Conversation + files
  list_conversation_files: { label: "List conversation files" },
  add_conversation_attachment: { label: "Add attachment" },
  send_message: { label: "Send message" },
  upload_asset: { label: "Upload file" },
  // Fleet + governance
  list_agent_defs: { label: "List agents", Icon: Bot },
  get_agent_def: { label: "Read agent definition", Icon: Bot },
  list_agent_executions: { label: "List agent runs", Icon: Bot },
  get_agent_trace: { label: "Read run trace", Icon: ScrollText },
  query_audit_log: { label: "Query the audit log", Icon: ScrollText },
  list_capabilities: { label: "List capabilities" },
  get_capability: { label: "Read capability contract" },
  list_iam_roles: { label: "List IAM roles", Icon: ShieldCheck },
  resolve_approval: { label: "Resolve approval", Icon: ShieldCheck },
  // Metering + billing
  get_usage_breakdown: { label: "Read usage breakdown", Icon: CreditCard },
  get_budget_policy: { label: "Read budget policy", Icon: CreditCard },
  read_subscription: { label: "Read subscription", Icon: CreditCard },
  // Memory
  recall_memory: { label: "Recall memory" },
  save_memory: { label: "Save memory" },
  write_memory: { label: "Save memory" },
  list_memories: { label: "List memories" },
};

// Domain keyword → icon. Checked against each name segment in order, so
// `query_audit_log` resolves via `audit` and `get_ontology_neighbors` via
// `ontology`.
const DOMAIN_ICONS: Record<string, LucideIcon> = {
  repo: GitBranch,
  git: GitBranch,
  branch: GitBranch,
  pr: GitBranch,
  document: FileText,
  ontology: Network,
  graph: Network,
  node: Network,
  semantic: Network,
  schema: Network,
  lineage: Network,
  conversation: MessageSquare,
  chat: MessageSquare,
  message: MessageSquare,
  asset: Paperclip,
  file: Paperclip,
  files: Paperclip,
  attachment: Paperclip,
  upload: Paperclip,
  search: Search,
  memory: Brain,
  audit: ScrollText,
  trace: ScrollText,
  execution: ScrollText,
  agent: Bot,
  iam: ShieldCheck,
  approval: ShieldCheck,
  consent: ShieldCheck,
  policy: ShieldCheck,
  billing: CreditCard,
  usage: CreditCard,
  budget: CreditCard,
  subscription: CreditCard,
  secret: KeyRound,
  key: KeyRound,
};

/** Upper-case the first character; leaves an empty string alone. */
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
