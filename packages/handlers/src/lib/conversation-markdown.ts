// conversation-markdown.ts — pure serialization core for conversation.export.
//
// Turns persisted chat.messages rows into (a) the active-branch message path
// and (b) a well-formatted Markdown document. The PDF renderer
// (lib/conversation-pdf.ts) consumes the same normalized block model so the
// two formats never drift on what a conversation "contains".
//
// Everything here is a pure function over row shapes — no DB, no ctx — so it
// is unit-testable without mocks.

// ── Row + model shapes ────────────────────────────────────────────────────────

/** The subset of a `chat.messages` row the exporter needs. */
export interface ExportMessageRow {
  id: string;
  parentMessageId: string | null;
  role: string;
  content: string;
  contentBlocks: unknown;
  metadata: unknown;
  createdAt: Date;
}

/** Normalized, format-agnostic content block. */
export type ExportBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; durationMs?: number }
  | {
      kind: "tool";
      capability: string;
      status: string;
      durationMs?: number;
      /** Compact JSON result, only when small enough to inline (≤200 chars). */
      resultPreview?: string;
    }
  | { kind: "code"; language: string; code: string }
  | { kind: "attachment"; name: string; url: string };

export interface ExportMessage {
  role: string;
  createdAt: Date;
  blocks: ExportBlock[];
}

export interface ConversationExportModel {
  title: string;
  createdAt: Date;
  exportedAt: Date;
  orgName: string | null;
  workspaceName: string | null;
  messages: ExportMessage[];
  /** Total rows in the conversation (all branches) — for the branch note. */
  totalMessageCount: number;
}

// ── Branch walking ────────────────────────────────────────────────────────────

/**
 * Reconstruct the active branch by walking parent links from the active leaf
 * to the root. Mirrors the app's walk-active-branch helper: when no leaf is
 * set (or the leaf is missing from the rows), fall back to the first root
 * message so legacy/linear conversations still export fully — for a linear
 * chain the newest message is the leaf, so the walk covers every row.
 *
 * Nothing in the schema stops `parent_message_id` from forming a cycle (a row
 * pointing at itself is enough), and an unguarded walk of one would loop
 * forever while `path` grows without bound. Stop at the first repeat instead:
 * the branch we return is still the longest acyclic prefix, so a corrupt
 * conversation exports partially rather than hanging the handler.
 */
export function walkActiveBranch(
  rows: ExportMessageRow[],
  leafId: string | null,
): ExportMessageRow[] {
  if (rows.length === 0) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const path: ExportMessageRow[] = [];
  const visited = new Set<string>();
  let cursor: ExportMessageRow | undefined =
    (leafId ? byId.get(leafId) : undefined) ?? fallbackLeaf(rows);
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    path.unshift(cursor);
    cursor = cursor.parentMessageId
      ? byId.get(cursor.parentMessageId)
      : undefined;
  }
  return path;
}

/**
 * When no active leaf is recorded, prefer the newest message that is not the
 * parent of any other message (a true leaf); a linear conversation then walks
 * root→newest. Falls back to the first root row for degenerate data.
 */
function fallbackLeaf(rows: ExportMessageRow[]): ExportMessageRow | undefined {
  const parents = new Set(
    rows.map((r) => r.parentMessageId).filter((p): p is string => p !== null),
  );
  const leaves = rows.filter((r) => !parents.has(r.id));
  if (leaves.length > 0) {
    return leaves.reduce((newest, r) =>
      r.createdAt.getTime() > newest.createdAt.getTime() ? r : newest,
    );
  }
  return rows.find((r) => r.parentMessageId === null);
}

// ── Block normalization ───────────────────────────────────────────────────────

const MAX_INLINE_RESULT_CHARS = 200;

interface RawAttachment {
  name: string;
  url: string;
}

/** Validated `metadata.attachments` entries (persisted on user turns). */
function attachmentsFromMetadata(metadata: unknown): RawAttachment[] {
  if (!metadata || typeof metadata !== "object" || !("attachments" in metadata))
    return [];
  const raw = (metadata as { attachments?: unknown }).attachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (a): a is { name: string; url: string } =>
      !!a &&
      typeof a === "object" &&
      typeof (a as { name?: unknown }).name === "string" &&
      typeof (a as { url?: unknown }).url === "string",
  );
}

/**
 * Normalize a message row's persisted content into ExportBlocks. Rows with
 * structured contentBlocks are mapped block-by-block (unknown block types are
 * skipped); legacy rows fall back to the flat `content` string. Attachments
 * from `metadata.attachments` are appended last.
 */
export function messageToBlocks(row: ExportMessageRow): ExportBlock[] {
  const out: ExportBlock[] = [];
  const blocks = Array.isArray(row.contentBlocks) ? row.contentBlocks : null;

  if (blocks && blocks.length > 0) {
    for (const raw of blocks) {
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof (raw as { type?: unknown }).type !== "string"
      ) {
        continue;
      }
      const block = raw as Record<string, unknown> & { type: string };
      switch (block.type) {
        case "text": {
          if (typeof block.text === "string" && block.text.length > 0) {
            out.push({ kind: "text", text: block.text });
          }
          break;
        }
        case "reasoning": {
          if (typeof block.text === "string" && block.text.length > 0) {
            out.push({
              kind: "reasoning",
              text: block.text,
              durationMs:
                typeof block.durationMs === "number"
                  ? block.durationMs
                  : undefined,
            });
          }
          break;
        }
        case "tool-call": {
          const capability =
            typeof block.capability === "string" ? block.capability : "unknown";
          const status =
            typeof block.status === "string" ? block.status : "unknown";
          const tool: ExportBlock = {
            kind: "tool",
            capability,
            status,
            durationMs:
              typeof block.durationMs === "number"
                ? block.durationMs
                : undefined,
          };
          if (block.resultPreview !== undefined && tool.kind === "tool") {
            const preview = safeCompactJson(block.resultPreview);
            if (preview && preview.length <= MAX_INLINE_RESULT_CHARS) {
              tool.resultPreview = preview;
            }
          }
          out.push(tool);
          break;
        }
        case "code-execute": {
          if (typeof block.code === "string") {
            out.push({
              kind: "code",
              language:
                typeof block.language === "string" ? block.language : "",
              code: block.code,
            });
          }
          break;
        }
        default:
          // Non-exportable block types (approvals, plans, components, …) — skip.
          break;
      }
    }
  }

  if (out.length === 0 && row.content.trim().length > 0) {
    out.push({ kind: "text", text: row.content });
  }

  for (const att of attachmentsFromMetadata(row.metadata)) {
    out.push({ kind: "attachment", name: att.name, url: att.url });
  }

  return out;
}

function safeCompactJson(value: unknown): string | null {
  try {
    const s = JSON.stringify(value);
    return typeof s === "string" ? s : null;
  } catch {
    return null;
  }
}

/** Build ExportMessages (role + normalized blocks) from the active branch rows. */
export function branchToExportMessages(
  rows: ExportMessageRow[],
): ExportMessage[] {
  return rows
    .map((r) => ({
      role: r.role,
      createdAt: r.createdAt,
      blocks: messageToBlocks(r),
    }))
    .filter((m) => m.blocks.length > 0);
}

// ── Markdown rendering ────────────────────────────────────────────────────────

export function roleLabel(role: string): string {
  if (role === "user") return "You";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function formatDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function markdownForBlock(block: ExportBlock): string {
  switch (block.kind) {
    case "text":
      return block.text;
    case "reasoning": {
      const duration = formatDuration(block.durationMs);
      const summary = duration ? `Reasoning (${duration})` : "Reasoning";
      return `<details>\n<summary>${summary}</summary>\n\n${block.text}\n\n</details>`;
    }
    case "tool": {
      const parts = [`tool: ${block.capability}`, `status: ${block.status}`];
      const duration = formatDuration(block.durationMs);
      if (duration) parts.push(`duration: ${duration}`);
      const lines = [parts.join(" · ")];
      if (block.resultPreview) lines.push(`result: ${block.resultPreview}`);
      return "```\n" + lines.join("\n") + "\n```";
    }
    case "code":
      return "```" + block.language + "\n" + block.code + "\n```";
    case "attachment":
      return `**Attachment:** [${block.name}](${block.url})`;
  }
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Render the full Markdown document: title header, export metadata, then one
 * section per message (role heading + blocks), separated by horizontal rules.
 * When the conversation has branches, a note flags that only the currently
 * active path is exported.
 */
export function conversationToMarkdown(model: ConversationExportModel): string {
  const header: string[] = [`# ${model.title}`, ""];
  header.push(
    `_Exported from Oxagen on ${model.exportedAt.toISOString()}_`,
    "",
  );
  const meta: string[] = [];
  if (model.orgName) meta.push(`- **Organization:** ${model.orgName}`);
  if (model.workspaceName) meta.push(`- **Workspace:** ${model.workspaceName}`);
  meta.push(`- **Created:** ${formatDate(model.createdAt)}`);
  meta.push(`- **Messages:** ${model.messages.length}`);
  header.push(...meta);
  if (model.totalMessageCount > model.messages.length) {
    header.push(
      "",
      `> Note: this conversation has ${model.totalMessageCount} messages across branches; this export follows the currently active branch (${model.messages.length} messages).`,
    );
  }

  const sections = model.messages.map((m) => {
    const parts = [`## ${roleLabel(m.role)}`];
    for (const block of m.blocks) parts.push(markdownForBlock(block));
    return parts.join("\n\n");
  });

  return [header.join("\n"), ...sections].join("\n\n---\n\n") + "\n";
}

// ── Filename derivation ───────────────────────────────────────────────────────

/** "Quarterly Planning!" + 2026-07-07 → "quarterly-planning-2026-07-07.md". */
export function exportFilename(
  title: string,
  exportedAt: Date,
  ext: "md" | "pdf",
): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  const base = slug.length > 0 ? slug : "conversation";
  return `${base}-${formatDate(exportedAt)}.${ext}`;
}
