/**
 * @-mention reference grammar — the single source of truth for structured
 * references embedded in chat messages.
 *
 * A mention is serialized into message text as:
 *
 *     [:TYPE|:SLUG|:LOCATION|:LABEL]
 *
 *   - TYPE     — what kind of thing is referenced (see {@link MENTION_TYPES}).
 *   - SLUG     — the stable public identifier (e.g. `agt_…`, `con_…`, a graph
 *                node publicId, a capability name, a file path).
 *   - LOCATION — where the thing lives: a path, URL, or graph address. May be
 *                empty when the slug already locates it.
 *   - LABEL    — the human-readable display name. UIs render THIS (never the
 *                slug) as a chip with a type icon; hover reveals the full
 *                property bag.
 *
 * Consumed in THREE places that must never drift:
 *  1. The composer @-mention menu (apps/app — `mention-menu.tsx`), which lets
 *     the user pick a reference type and search within it.
 *  2. Message rendering (composer preview + transcript), which parses tokens
 *     back into inspectable chips via {@link splitTextByMentions}.
 *  3. Agent system prompts (`mentionGrammarPrompt`), which teach the agent
 *     what the tokens mean, so a mentioned node/file/repo is treated as
 *     first-class, already-cited context.
 *
 * Field values are percent-encoded (only `%`, `|`, `]`, and newlines) so the
 * token stays single-line and unambiguous while remaining mostly readable.
 */

/** Reference kinds a chat message can mention. */
export type MentionType =
  | "repository"
  | "branch"
  | "file"
  | "directory"
  | "agent"
  | "skill"
  | "tool"
  | "mcp_server"
  | "capability"
  | "node"
  | "edge";

export interface MentionTypeInfo {
  readonly type: MentionType;
  /** Singular human label shown on chips, e.g. "Repository". */
  readonly label: string;
  /** Plural label for the type-picker menu, e.g. "Repositories". */
  readonly pluralLabel: string;
  /** One-line description shown in the type picker and the system prompt. */
  readonly summary: string;
}

/**
 * Ordered registry of mention types. Order is the type-picker menu order:
 * code-shaped references first, then platform objects, then graph objects.
 */
export const MENTION_TYPES: readonly MentionTypeInfo[] = [
  {
    type: "repository",
    label: "Repository",
    pluralLabel: "Repositories",
    summary: "A GitHub repository connected to this workspace.",
  },
  {
    type: "branch",
    label: "Branch",
    pluralLabel: "Branches",
    summary: "A branch of a connected repository.",
  },
  {
    type: "file",
    label: "File",
    pluralLabel: "Files",
    summary: "A file inside a connected repository.",
  },
  {
    type: "directory",
    label: "Directory",
    pluralLabel: "Directories",
    summary: "A directory inside a connected repository.",
  },
  {
    type: "agent",
    label: "Agent",
    pluralLabel: "Agents",
    summary: "An agent defined in this workspace.",
  },
  {
    type: "skill",
    label: "Skill",
    pluralLabel: "Skills",
    summary: "An installed agent skill.",
  },
  {
    type: "tool",
    label: "Tool",
    pluralLabel: "Tools",
    summary: "A tool agents can call.",
  },
  {
    type: "mcp_server",
    label: "MCP server",
    pluralLabel: "MCP servers",
    summary: "A connected Model Context Protocol server.",
  },
  {
    type: "capability",
    label: "Capability",
    pluralLabel: "Capabilities",
    summary: "A platform capability (contract) invocable via the API/MCP/CLI.",
  },
  {
    type: "node",
    label: "Graph node",
    pluralLabel: "Graph nodes",
    summary: "A knowledge-graph node (entities, memories, documents, …).",
  },
  {
    type: "edge",
    label: "Graph edge",
    pluralLabel: "Graph edges",
    summary: "A knowledge-graph relationship between two nodes.",
  },
] as const;

const MENTION_TYPE_SET: ReadonlySet<string> = new Set(
  MENTION_TYPES.map((t) => t.type),
);

export function isMentionType(value: string): value is MentionType {
  return MENTION_TYPE_SET.has(value);
}

export function mentionTypeInfo(type: MentionType): MentionTypeInfo {
  // The registry is exhaustive over MentionType, so this cannot miss.
  return MENTION_TYPES.find((t) => t.type === type) as MentionTypeInfo;
}

/** Filter mention types by a typed prefix (the text after the leading `@`). */
export function matchMentionTypes(query: string): readonly MentionTypeInfo[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return MENTION_TYPES;
  return MENTION_TYPES.filter(
    (t) =>
      t.type.startsWith(q) ||
      t.label.toLowerCase().startsWith(q) ||
      t.pluralLabel.toLowerCase().startsWith(q),
  );
}

/** A structured reference carried inside a chat message. */
export interface ChatMention {
  readonly type: MentionType;
  /** Stable public identifier (public_id, capability name, path, …). */
  readonly slug: string;
  /** Path / URL / graph address locating the referent. May be empty. */
  readonly location: string;
  /** Human-readable display name — what chips render. */
  readonly label: string;
}

/** A mention found in text, with its character span. */
export interface ParsedMention extends ChatMention {
  readonly start: number;
  /** Exclusive end index of the token in the source text. */
  readonly end: number;
  /** The raw token text, e.g. `[:file|:src/a.ts|:apps/app/src/a.ts|:a.ts]`. */
  readonly raw: string;
}

/* Only the characters that would break the token structure are encoded, so
 * tokens stay human-skimmable in raw transcripts. */
function encodeField(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("|", "%7C")
    .replaceAll("]", "%5D")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function decodeField(value: string): string {
  return value
    .replaceAll("%0A", "\n")
    .replaceAll("%0D", "\r")
    .replaceAll("%5D", "]")
    .replaceAll("%7C", "|")
    .replaceAll("%25", "%");
}

/** Serialize a mention to its `[:type|:slug|:location|:label]` token. */
export function serializeMention(mention: ChatMention): string {
  return `[:${mention.type}|:${encodeField(mention.slug)}|:${encodeField(
    mention.location,
  )}|:${encodeField(mention.label)}]`;
}

/**
 * Token matcher. Fields cannot contain `|` or `]` (they are percent-encoded),
 * so a lazy character-class scan is unambiguous.
 */
export const MENTION_TOKEN_REGEX =
  /\[:([a-z_]+)\|:([^|\]]*)\|:([^|\]]*)\|:([^|\]]*)\]/g;

/** Extract every well-formed mention token from `text`, in document order. */
export function parseMentions(text: string): ParsedMention[] {
  const out: ParsedMention[] = [];
  // MENTION_TOKEN_REGEX is a shared `/g` regexp and `String.matchAll` seeds its
  // iterator from the regexp's current `lastIndex`. A caller that ran a stateful
  // `.test()` first (e.g. MarkdownMessage's mention detection) leaves lastIndex
  // advanced, which would make matchAll skip the first — often the only — token.
  // Reset so scanning is self-contained regardless of prior regex state.
  MENTION_TOKEN_REGEX.lastIndex = 0;
  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const raw = match[0];
    const type = match[1] ?? "";
    const slug = match[2] ?? "";
    const location = match[3] ?? "";
    const label = match[4] ?? "";
    if (!isMentionType(type)) continue; // unknown type — leave as plain text
    out.push({
      type,
      slug: decodeField(slug),
      location: decodeField(location),
      label: decodeField(label),
      start: match.index,
      end: match.index + raw.length,
      raw,
    });
  }
  return out;
}

export type MentionTextSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "mention"; readonly mention: ParsedMention };

/**
 * Split message text into plain-text and mention segments, for renderers that
 * replace tokens with chips. Unknown/malformed tokens stay in text segments.
 */
export function splitTextByMentions(text: string): MentionTextSegment[] {
  const segments: MentionTextSegment[] = [];
  let cursor = 0;
  for (const mention of parseMentions(text)) {
    if (mention.start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, mention.start) });
    }
    segments.push({ kind: "mention", mention });
    cursor = mention.end;
  }
  if (cursor < text.length || segments.length === 0) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}

/** Replace each mention token with a readable `@Label` marker. */
export function stripMentions(text: string): string {
  return splitTextByMentions(text)
    .map((s) => (s.kind === "text" ? s.text : `@${s.mention.label}`))
    .join("");
}

/**
 * A mention the composer is holding while the user finishes typing. The
 * textarea shows the readable `placeholder` (e.g. `@proxy.ts`); at submit,
 * {@link applyMentionPlaceholders} swaps each placeholder for its full token.
 */
export interface PendingMention {
  readonly placeholder: string;
  readonly mention: ChatMention;
}

/** The display placeholder inserted into the composer for a mention. */
export function mentionPlaceholder(mention: ChatMention): string {
  return `@${mention.label}`;
}

function findPlaceholder(text: string, placeholder: string): number {
  let from = 0;
  for (;;) {
    const i = text.indexOf(placeholder, from);
    if (i === -1) return -1;
    const before = i === 0 ? "" : text[i - 1]!;
    const after =
      i + placeholder.length >= text.length
        ? ""
        : text[i + placeholder.length]!;
    // A placeholder the user edited into a longer word no longer refers to the
    // mention — require non-word boundaries on both sides.
    const beforeOk = before === "" || !/[\w@]/.test(before);
    const afterOk = after === "" || !/\w/.test(after);
    if (beforeOk && afterOk) return i;
    from = i + 1;
  }
}

/**
 * Replace each pending mention's `@Label` placeholder (leftmost surviving
 * occurrence, in insertion order) with its serialized token. Placeholders the
 * user edited away are skipped — their mention is silently dropped.
 */
export function applyMentionPlaceholders(
  text: string,
  mentions: readonly PendingMention[],
): string {
  let out = text;
  for (const { placeholder, mention } of mentions) {
    const idx = findPlaceholder(out, placeholder);
    if (idx === -1) continue;
    out =
      out.slice(0, idx) +
      serializeMention(mention) +
      out.slice(idx + placeholder.length);
  }
  return out;
}

/**
 * Mention ↔ markdown-link bridge. Message renderers convert tokens to
 * `[label](oxagen-mention://type?slug=…&location=…&label=…)` links so chips
 * render inline through the markdown pipeline (with a custom anchor
 * component), without breaking paragraph/list structure.
 */
export const MENTION_PROTOCOL = "oxagen-mention:";

const MENTION_HREF_REGEX = /^oxagen-mention:\/\/([a-z_]+)\?(.*)$/;

export function mentionToHref(mention: ChatMention): string {
  const params = new URLSearchParams({
    slug: mention.slug,
    location: mention.location,
    label: mention.label,
  });
  // Raw parens would terminate a markdown "(url)" early; URLSearchParams
  // leaves them unescaped, so encode them explicitly.
  const query = params.toString().replaceAll("(", "%28").replaceAll(")", "%29");
  return `${MENTION_PROTOCOL}//${mention.type}?${query}`;
}

export function mentionFromHref(href: string): ChatMention | null {
  const match = MENTION_HREF_REGEX.exec(href);
  if (!match) return null;
  const type = match[1] ?? "";
  if (!isMentionType(type)) return null;
  const params = new URLSearchParams(match[2] ?? "");
  const slug = params.get("slug");
  const label = params.get("label");
  if (!slug || !label) return null;
  return { type, slug, location: params.get("location") ?? "", label };
}

/** Replace mention tokens with markdown links for chip-aware renderers. */
export function textWithMentionLinks(text: string): string {
  return splitTextByMentions(text)
    .map((segment) => {
      if (segment.kind === "text") return segment.text;
      const label = segment.mention.label
        .replaceAll("[", "\\[")
        .replaceAll("]", "\\]");
      return `[${label}](${mentionToHref(segment.mention)})`;
    })
    .join("");
}

/**
 * System-prompt section teaching the agent the mention grammar. Static (no
 * per-turn data) so it is safe inside the cached system block.
 */
export function mentionGrammarPrompt(): string {
  const typeLines = MENTION_TYPES.map(
    (t) => `- \`${t.type}\` — ${t.summary}`,
  ).join("\n");
  return [
    "## Reference mentions",
    "",
    "User messages may embed structured reference tokens of the form",
    "`[:TYPE|:SLUG|:LOCATION|:LABEL]`. Each token is a deliberate, first-class",
    "reference the user attached to the conversation: TYPE is the kind of",
    "thing, SLUG is its stable public identifier, LOCATION is its path or URL",
    "(may be empty), and LABEL is its human-readable name. Fields",
    "percent-encode `%`, `|`, `]`, and newlines.",
    "",
    "Reference types:",
    typeLines,
    "",
    "How to treat them:",
    "- A mention is authoritative context — prefer the mentioned entity over",
    "  guessing. Resolve it by SLUG (public id / path / capability name), not",
    "  by LABEL.",
    "- A `repository` mention selects the repo to operate on; `branch`,",
    "  `file`, and `directory` mentions scope work within it.",
    "- `node` / `edge` mentions are knowledge-graph references and count as",
    "  citations: ground answers in their properties and cite them like any",
    "  retrieved graph context.",
    "- When you reference one of these entities in your reply, you may emit",
    "  the same token form; the UI renders it as an inspectable chip.",
    "- Never echo raw SLUG values as user-facing names — use the LABEL.",
  ].join("\n");
}
