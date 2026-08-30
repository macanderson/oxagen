#!/usr/bin/env node

import { execSync } from "child_process";

interface SessionSummary {
  session_id: string;
  timestamp: string;
  duration_minutes: number | null;
  user: string;
  repository: string;
  branch: string | null;
  files_changed_count: number;
  files_changed_details: string | null;
  lines_added: number;
  lines_removed: number;
  accomplishment_summary: string;
  claudeModel?: string;
}

function safeExec(cmd: string, fallback = ""): string {
  try {
    return execSync(cmd, {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    console.error(`Failed to execute command: ${cmd}`);
    return fallback;
  }
}

async function captureSessionSummary(): Promise<SessionSummary> {
  const now = new Date();
  const sessionId = process.env.CLAUDE_SESSION_ID || `session-${now.getTime()}`;
  const user = process.env.USER || "unknown";

  // Get Claude model from environment (falls back to ANTHROPIC_MODEL from .env)
  const claudeModel =
    process.env.ANTHROPIC_MODEL ||
    process.env.CLAUDE_CODE_MODEL ||
    "claude-sonnet-5";

  // Get repository info
  const repoName =
    safeExec("git rev-parse --show-toplevel", process.cwd()).split("/").pop() ||
    "unknown";
  const branch = safeExec("git rev-parse --abbrev-ref HEAD", "main");

  // Get git diff statistics
  const diffStat = safeExec("git diff --stat", "");
  const diffNumStat = safeExec("git diff --numstat", "");

  let filesChanged = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  if (diffNumStat) {
    const lines = diffNumStat.split("\n").filter(Boolean);
    filesChanged = lines.length;
    lines.forEach((line) => {
      const parts = line.split("\t");
      const added = parts[0] ?? "0";
      const removed = parts[1] ?? "0";
      linesAdded += parseInt(added, 10) || 0;
      linesRemoved += parseInt(removed, 10) || 0;
    });
  }

  // Get summary from recent changes (git diff returns relative paths from repo root)
  // This ensures paths are consistent across developers' machines for grouping/analytics
  const changedFiles = safeExec("git diff --name-only")
    .split("\n")
    .filter(Boolean);
  const fileTypes = changedFiles.reduce(
    (acc: Record<string, number>, file: string) => {
      const ext = file.split(".").pop() || "unknown";
      acc[ext] = (acc[ext] || 0) + 1;
      return acc;
    },
    {},
  );

  const typesSummary = Object.entries(fileTypes)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([ext, count]) => `${count} .${ext}`)
    .join(", ");

  // Build accomplishment summary from changes
  let accomplishmentSummary = "Session completed";
  if (filesChanged > 0) {
    accomplishmentSummary = `Modified ${filesChanged} files (${typesSummary}): ${linesAdded} lines added, ${linesRemoved} lines removed`;
  }
  if (process.env.CLAUDE_SESSION_SUMMARY) {
    accomplishmentSummary = process.env.CLAUDE_SESSION_SUMMARY;
  }

  const summary: SessionSummary = {
    session_id: sessionId,
    timestamp: now.toISOString(),
    duration_minutes: null,
    user,
    repository: repoName,
    branch: branch || null,
    files_changed_count: filesChanged,
    files_changed_details: diffStat || null,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    accomplishment_summary: accomplishmentSummary,
  };

  return { ...summary, claudeModel };
}

async function postToClickHouse(summary: SessionSummary): Promise<void> {
  const {
    ANALYTICS_URL,
    ANALYTICS_USER,
    ANALYTICS_PASSWORD,
    ANALYTICS_DATABASE,
  } = process.env;

  if (!ANALYTICS_URL || !ANALYTICS_USER || !ANALYTICS_PASSWORD) {
    console.log("⚠ ANALYTICS_* env vars not set, skipping ClickHouse post");
    return;
  }

  try {
    // Insert session summary into ClickHouse
    // Token counts are estimated from lines of code (rough proxy: 1 line ≈ 5 tokens)
    // This will be enriched with actual token data once instrumentation is wired
    const estimatedInputTokens =
      summary.lines_added + summary.lines_removed + 1000;
    const estimatedOutputTokens = Math.floor(
      (summary.lines_added + summary.lines_removed) / 2,
    );

    // Parse files from diff stat
    const filesModified = summary.files_changed_details
      ? summary.files_changed_details
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => l.split("|")[0]?.trim())
          .filter(Boolean)
      : [];

    // Generate prompt hash: SHA-256 of session summary (PII-free cohort key)
    const summaryForHash = `${summary.files_changed_count}|${summary.lines_added}|${summary.lines_removed}|${summary.branch}`;
    const hashBuffer = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(summaryForHash),
    );
    const hashArray = new Uint8Array(hashBuffer).slice(0, 16);
    const promptHash = Array.from(hashArray, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");

    // Escape SQL strings properly
    const recapText = summary.accomplishment_summary
      .replace(/'/g, "\\'")
      .substring(0, 1000);

    const insertSql = `
      INSERT INTO ${ANALYTICS_DATABASE || "internal"}.agent_executions (
        timestamp,
        type,
        user_email,
        model,
        tokens_in,
        tokens_out,
        cached_tokens,
        cache_misses,
        duration_ms,
        status,
        files_modified,
        session_id,
        conversation_id,
        provider,
        surface,
        session_recap,
        prompt_hash,
        recap_generated_at
      ) VALUES (
        now(),
        'claude_code_session',
        '${summary.user}@localhost',
        '${summary.claudeModel}',
        ${estimatedInputTokens},
        ${estimatedOutputTokens},
        0,
        0,
        0,
        'completed',
        [${filesModified
          .filter(Boolean)
          .map((f) => `'${(f ?? "").replace(/'/g, "\\'")}'`)
          .join(", ")}],
        '${summary.session_id}',
        '${summary.session_id.replace(/-/g, "")}00000000000000',
        'anthropic',
        'claude-code',
        '${recapText}',
        '${promptHash}',
        now()
      )
    `;

    const url = new URL(ANALYTICS_URL);
    url.pathname = "/";
    url.searchParams.set("query", insertSql);

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${ANALYTICS_USER}:${ANALYTICS_PASSWORD}`).toString("base64")}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`ClickHouse post failed (${response.status}): ${text}`);
    } else {
      console.log(`✓ Session summary recorded (${summary.session_id})`);
    }
  } catch (error) {
    // Silently fail for analytics - don't disrupt user session
    console.error(
      "Failed to post to ClickHouse:",
      error instanceof Error ? error.message : error,
    );
  }
}

async function main() {
  try {
    const summary = await captureSessionSummary();
    await postToClickHouse(summary);
  } catch (error) {
    // Silently fail for analytics
    console.error("Failed to capture session summary:", error);
  }
}

main();
