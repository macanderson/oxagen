/**
 * Shared runner helpers
 *
 * Pure, side-effect-free utilities used by every agent runner. Kept separate
 * from the runner classes so they can be unit-tested without spawning a real
 * agent binary.
 */

import type { Task } from "../src/lib/types.js";

/**
 * Make a string safe to use as a single path segment / filename.
 *
 * Model slugs like `anthropic/claude-opus-4.8` contain `/`, which turns a
 * result id into a nested path and makes `writeFileSync(join(dir, id))` throw
 * `ENOENT` on the missing intermediate directory. Collapse anything that isn't
 * a safe filename char into `_`.
 */
export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Coerce an unknown JSON value into a finite number, else a fallback.
 */
export function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Count a value that may be an array (return length) or already a count.
 */
export function countOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return num(value, 0);
}

/**
 * Compose a rich, self-contained task prompt from a Task definition. Every
 * agent receives the same prompt text, so differences in results reflect the
 * agent, not the phrasing.
 */
export function buildTaskPrompt(task: Task): string {
  const lines = [`# ${task.name}`, "", task.description.trim(), ""];

  lines.push(`Starting point: ${task.startingPoint}`);

  if (task.filesToModify?.length) {
    lines.push("", "Files to modify:");
    for (const file of task.filesToModify) lines.push(`- ${file}`);
  }

  if (task.acceptanceCriteria.length) {
    lines.push("", "Acceptance criteria:");
    for (const criterion of task.acceptanceCriteria) lines.push(`- ${criterion}`);
  }

  if (task.testCommands?.length) {
    lines.push("", "Your work is verified by running:");
    for (const cmd of task.testCommands) lines.push(`- \`${cmd}\``);
  }

  return lines.join("\n");
}

/**
 * Parse the machine-readable JSON envelope an agent prints to stdout under
 * `--output-format json`. Agents may print several JSONL lines (stream-json)
 * or a single object; we want the last `type: "result"` envelope, falling back
 * to the last parseable JSON object. Non-JSON lines (logs, banners) are ignored.
 */
export function parseJsonEnvelope(
  stdout: string,
): Record<string, unknown> | null {
  if (!stdout) return null;

  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));

  let fallback: Record<string, unknown> | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]) as Record<string, unknown>;
      if (fallback === null) fallback = obj;
      if (obj.type === "result") return obj;
    } catch {
      // Not a JSON object line — skip it.
    }
  }

  return fallback;
}
