#!/usr/bin/env tsx
/**
 * Backfill Claude Code session telemetry into internal.claude_sessions.
 *
 * Scans (project dir derived from this repo's absolute path):
 *   ~/.claude/projects/<project-slug>/*.jsonl       → parent sessions
 *   ~/.claude/projects/<project-slug>/<uuid>/subagents/*.jsonl → subagents
 *
 * Usage:
 *   PRODUCTION_ANALYTICS_URL=https://... \
 *   PRODUCTION_ANALYTICS_USER=default \
 *   PRODUCTION_ANALYTICS_PASSWORD=... \
 *   tsx tools/scripts/backfill-claude-telemetry.ts
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── JSONL entry interfaces ────────────────────────────────────────────────────

interface UsageObject {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
  };
  service_tier?: string | null;
  speed?: string | null;
  inference_geo?: string | null;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
}

interface TextBlock {
  type: "text";
  text: string;
}
interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}
interface ToolUseBlock {
  type: "tool_use";
  name: string;
  id: string;
}
interface OtherBlock {
  type: string;
}
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | OtherBlock;

interface AssistantMessage {
  id?: string;
  model: string;
  content?: ContentBlock[];
  stop_reason?: string | null;
  usage: UsageObject;
}

interface UserMessage {
  content: string | ContentBlock[];
}

interface JournalEntry {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  entrypoint?: string;
  version?: string;
  gitBranch?: string;
  cwd?: string;
  // present only on assistant entries:
  message?: AssistantMessage | UserMessage;
  requestId?: string;
  isApiErrorMessage?: boolean;
  error?: string;
}

// ── Safe JSON parsing ─────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toJournalEntry(raw: unknown): JournalEntry | null {
  if (!isRecord(raw) || typeof raw["type"] !== "string") return null;
  return raw as unknown as JournalEntry;
}

function toAssistantMessage(v: unknown): AssistantMessage | null {
  if (!isRecord(v)) return null;
  if (typeof v["model"] !== "string") return null;
  if (!isRecord(v["usage"])) return null;
  return v as unknown as AssistantMessage;
}

function toUserMessage(v: unknown): UserMessage | null {
  if (!isRecord(v)) return null;
  const c = v["content"];
  if (typeof c !== "string" && !Array.isArray(c)) return null;
  return v as unknown as UserMessage;
}

// ── Pricing — published Anthropic rates (USD per million tokens) ──────────────

interface ModelRates {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheWritePerMtok: number;
  cacheReadPerMtok: number;
}

// Verified against https://www.anthropic.com/pricing (2026-06-15)
const MODEL_RATES: Record<string, ModelRates> = {
  "claude-fable-5": {
    inputPerMtok: 15.0,
    outputPerMtok: 75.0,
    cacheWritePerMtok: 18.75,
    cacheReadPerMtok: 1.5,
  },
  "claude-opus-4-8": {
    inputPerMtok: 15.0,
    outputPerMtok: 75.0,
    cacheWritePerMtok: 18.75,
    cacheReadPerMtok: 1.5,
  },
  "claude-sonnet-5": {
    inputPerMtok: 3.0,
    outputPerMtok: 15.0,
    cacheWritePerMtok: 3.75,
    cacheReadPerMtok: 0.3,
  },
  "claude-sonnet-4-6": {
    inputPerMtok: 3.0,
    outputPerMtok: 15.0,
    cacheWritePerMtok: 3.75,
    cacheReadPerMtok: 0.3,
  },
  "claude-haiku-4-5-20251001": {
    inputPerMtok: 0.8,
    outputPerMtok: 4.0,
    cacheWritePerMtok: 1.0,
    cacheReadPerMtok: 0.08,
  },
};

// Sonnet-tier fallback for unknown models
const FALLBACK_RATES: ModelRates = {
  inputPerMtok: 3.0,
  outputPerMtok: 15.0,
  cacheWritePerMtok: 3.75,
  cacheReadPerMtok: 0.3,
};

function resolveRates(model: string): ModelRates {
  const direct = MODEL_RATES[model];
  if (direct !== undefined) return direct;
  // Prefix match (e.g. "claude-opus-4-8-20251001" → opus rates)
  for (const [prefix, rates] of Object.entries(MODEL_RATES)) {
    if (model.startsWith(prefix)) return rates;
  }
  return FALLBACK_RATES;
}

function computeCostMicros(
  model: string,
  tokensIn: number,
  tokensOut: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
): number {
  if (model === "<synthetic>" || model === "") return 0;
  const r = resolveRates(model);
  const M = 1_000_000;
  return Math.round(
    (tokensIn / M) * r.inputPerMtok * 1_000_000 +
      (tokensOut / M) * r.outputPerMtok * 1_000_000 +
      (cacheWrite5m / M) * r.cacheWritePerMtok * 1_000_000 +
      (cacheWrite1h / M) * r.cacheWritePerMtok * 2 * 1_000_000 +
      (cacheRead / M) * r.cacheReadPerMtok * 1_000_000,
  );
}

// ── Insert row ────────────────────────────────────────────────────────────────

interface ClaudeSessionRow {
  timestamp: string;
  entry_uuid: string;
  session_id: string;
  message_id: string;
  request_id: string;
  parent_uuid: string;
  user_email: string;
  model: string;
  version: string;
  entrypoint: string;
  git_branch: string;
  cwd: string;
  is_subagent: 0 | 1;
  is_sidechain: 0 | 1;
  stop_reason: string;
  service_tier: string;
  inference_geo: string;
  speed: string;
  status: string;
  error_type: string;
  tokens_in: number;
  tokens_out: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  web_searches: number;
  web_fetches: number;
  thinking_tokens: number;
  cost_usd_micros: number;
  session_prompt: string;
  assistant_text: string;
  tool_calls: string[];
  duration_ms: number;
  inserted_at: string;
}

// ── File parsing ──────────────────────────────────────────────────────────────

const NULL_UUID = "00000000-0000-0000-0000-000000000000";
const USER_EMAIL = process.env["USER_EMAIL"] ?? "mac@macanderson.com";

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content.slice(0, 1000);
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .slice(0, 1000);
}

async function parseFile(
  filePath: string,
  isSubagent: boolean,
): Promise<ClaudeSessionRow[]> {
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  // First pass: record the first user message and timestamp per session
  const sessionPrompt = new Map<string, string>();
  const sessionStart = new Map<string, string>();

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const entry = toJournalEntry(parsed);
    if (!entry || entry.type !== "user") continue;

    const sid = entry.sessionId;
    if (!sid) continue;

    if (!sessionStart.has(sid) && entry.timestamp) {
      sessionStart.set(sid, entry.timestamp);
    }
    if (!sessionPrompt.has(sid)) {
      const userMsg = toUserMessage(entry.message);
      if (userMsg) sessionPrompt.set(sid, extractText(userMsg.content));
    }
  }

  // Second pass: emit one row per assistant message with real token usage
  const now = new Date().toISOString();
  const rows: ClaudeSessionRow[] = [];

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const entry = toJournalEntry(parsed);
    if (!entry || entry.type !== "assistant") continue;

    const msg = toAssistantMessage(entry.message);
    if (!msg) continue;

    const usage = msg.usage;
    if (usage.input_tokens === 0 && usage.output_tokens === 0) continue;

    const content = msg.content ?? [];
    const toolCalls: string[] = [];
    let assistantText = "";
    let thinkingChars = 0;

    for (const block of content) {
      if (block.type === "tool_use") {
        toolCalls.push((block as ToolUseBlock).name);
      } else if (block.type === "text") {
        assistantText += (block as TextBlock).text;
      } else if (block.type === "thinking") {
        thinkingChars += (block as ThinkingBlock).thinking.length;
      }
    }

    // Prefer the granular cache tiers; fall back to the summary field
    const cacheWrite5m =
      usage.cache_creation?.ephemeral_5m_input_tokens ??
      usage.cache_creation_input_tokens;
    const cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens;

    const sid = entry.sessionId ?? "";
    const ts = entry.timestamp ?? now;
    const startTs = sessionStart.get(sid);
    const durationMs = startTs
      ? Math.max(0, new Date(ts).getTime() - new Date(startTs).getTime())
      : 0;

    rows.push({
      timestamp: ts,
      entry_uuid: entry.uuid ?? NULL_UUID,
      session_id: sid || NULL_UUID,
      message_id: msg.id ?? "",
      request_id: entry.requestId ?? "",
      parent_uuid: entry.parentUuid ?? NULL_UUID,
      user_email: USER_EMAIL,
      model: msg.model,
      version: entry.version ?? "",
      entrypoint: entry.entrypoint ?? "cli",
      git_branch: entry.gitBranch ?? "",
      cwd: entry.cwd ?? "",
      is_subagent: isSubagent ? 1 : 0,
      is_sidechain: entry.isSidechain === true ? 1 : 0,
      stop_reason: msg.stop_reason ?? "",
      service_tier: usage.service_tier ?? "standard",
      inference_geo: usage.inference_geo ?? "",
      speed: usage.speed ?? "standard",
      status: entry.isApiErrorMessage === true ? "api_error" : "success",
      error_type: entry.error ?? "",
      tokens_in: usage.input_tokens,
      tokens_out: usage.output_tokens,
      cache_write_5m: cacheWrite5m,
      cache_write_1h: cacheWrite1h,
      cache_read: cacheRead,
      web_searches: usage.server_tool_use?.web_search_requests ?? 0,
      web_fetches: usage.server_tool_use?.web_fetch_requests ?? 0,
      thinking_tokens: Math.ceil(thinkingChars / 4),
      cost_usd_micros: computeCostMicros(
        msg.model,
        usage.input_tokens,
        usage.output_tokens,
        cacheWrite5m,
        cacheWrite1h,
        cacheRead,
      ),
      session_prompt: sessionPrompt.get(sid) ?? "",
      assistant_text: assistantText.slice(0, 500),
      tool_calls: toolCalls,
      duration_ms: durationMs,
      inserted_at: now,
    });
  }

  return rows;
}

// ── Discovery ─────────────────────────────────────────────────────────────────

interface FileRef {
  path: string;
  isSubagent: boolean;
}

async function discoverFiles(basePath: string): Promise<FileRef[]> {
  const refs: FileRef[] = [];
  const entries = await readdir(basePath);

  for (const entry of entries) {
    const full = join(basePath, entry);

    if (entry.endsWith(".jsonl")) {
      refs.push({ path: full, isSubagent: false });
      continue;
    }

    // UUID subdirectory — check for a subagents/ folder inside
    let isDir = false;
    try {
      isDir = (await stat(full)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    let subs: string[] = [];
    try {
      subs = await readdir(join(full, "subagents"));
    } catch {
      continue;
    }
    for (const sub of subs) {
      if (sub.endsWith(".jsonl")) {
        refs.push({ path: join(full, "subagents", sub), isSubagent: true });
      }
    }
  }

  return refs;
}

// ── ClickHouse insert ─────────────────────────────────────────────────────────

async function insertRows(rows: ClaudeSessionRow[]): Promise<void> {
  const url = process.env["PRODUCTION_ANALYTICS_URL"];
  const user = process.env["PRODUCTION_ANALYTICS_USER"];
  const pass = process.env["PRODUCTION_ANALYTICS_PASSWORD"];

  if (!url || !user || !pass) {
    throw new Error(
      "Set PRODUCTION_ANALYTICS_URL, PRODUCTION_ANALYTICS_USER, PRODUCTION_ANALYTICS_PASSWORD",
    );
  }

  const auth = btoa(`${user}:${pass}`);
  const CHUNK = 200;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const ndjson = chunk.map((r) => JSON.stringify(r)).join("\n");
    const body = `INSERT INTO internal.claude_sessions FORMAT JSONEachRow\n${ndjson}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-ndjson",
        Authorization: `Basic ${auth}`,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ClickHouse ${res.status}: ${text.slice(0, 400)}`);
    }

    process.stdout.write(
      `  inserted ${Math.min(i + CHUNK, rows.length)}/${rows.length}\n`,
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const home = homedir();
  if (!home) {
    throw new Error(
      "Cannot determine the current user's home directory (os.homedir() returned an empty value). " +
        "Set HOME explicitly and re-run.",
    );
  }

  // Claude Code names project dirs by replacing every "/" in the absolute
  // project path with "-". Derive it from this script's location so the
  // script works on any machine, not just the original author's laptop.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const projectSlug = repoRoot.replaceAll("/", "-");
  const basePath = join(home, ".claude/projects", projectSlug);

  process.stdout.write(`Scanning ${basePath}\n`);
  const files = await discoverFiles(basePath);
  process.stdout.write(
    `Found ${files.length} JSONL files (top-level + subagents)\n\n`,
  );

  const allRows: ClaudeSessionRow[] = [];
  let ok = 0,
    fail = 0;

  for (const { path, isSubagent } of files) {
    try {
      const rows = await parseFile(path, isSubagent);
      if (rows.length > 0) {
        allRows.push(...rows);
        process.stdout.write(
          `  ✓ ${basename(path)} — ${rows.length} rows${isSubagent ? " (subagent)" : ""}\n`,
        );
      }
      ok++;
    } catch {
      fail++;
    }
  }

  process.stdout.write(
    `\nParsed ${ok} files, ${fail} errors. ${allRows.length} rows total.\n`,
  );

  if (allRows.length === 0) {
    process.stdout.write("Nothing to insert.\n");
    return;
  }

  process.stdout.write("\nInserting into ClickHouse...\n");
  await insertRows(allRows);
  process.stdout.write(
    `\n✓ Inserted ${allRows.length} rows into internal.claude_sessions\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
