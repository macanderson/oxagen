// parse.ts: reading a server folder's files against their schemas.
//
// server.toml and tools.toml follow the steering repo's file rules through
// S0's readTomlFile: UTF-8 with no byte-order mark, LF, a final newline, and
// a first line that names the schema. A lock file is JSON that Oxagen
// writes, so it must also be in the form formatJson writes, within 5 MB.
import {
  encodingIssues,
  readJsonLines,
  readTomlFile,
  schemaIssues,
  type FileIssue,
  type ReadResult,
} from "@oxagen/oxagen/steering-repo/files";
import { formatJson } from "./json";
import { LOCK_BYTES_MAX, mcpToolsLockSchema, type McpToolsLock } from "./lock";
import { toolManifestSchema, type ToolManifest } from "./manifest";
import { mcpServerSchema, type McpServer } from "./server";
import { recordedCallSchema, selectionTestSchema, type RecordedCall, type SelectionTest } from "./tests-files";
import { mcpToolsSchema, type McpTools } from "./tools";

export type { FileIssue, ReadResult };

/** A server.toml file. */
export function parseServerToml(text: string): ReadResult<McpServer> {
  return readTomlFile(text, "mcp-server/v1", mcpServerSchema);
}

/** A tools.toml file. */
export function parseToolsToml(text: string): ReadResult<McpTools> {
  return readTomlFile(text, "mcp-tools/v1", mcpToolsSchema);
}

function readJson<T>(
  text: string,
  maxBytes: number,
  label: string,
  parse: (value: unknown) => ReadResult<T>,
): ReadResult<T> {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) {
    return {
      ok: false,
      issues: [{ line: null, field: null, message: `${label} is ${bytes} bytes, over the limit of ${maxBytes}` }],
    };
  }
  const issues = encodingIssues(text);
  if (issues.length > 0) return { ok: false, issues };
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      ok: false,
      issues: [{ line: null, field: null, message: `${label} is not JSON: ${(error as Error).message}` }],
    };
  }
  return parse(value);
}

/**
 * A tools.lock.json file. It must be in the form Oxagen writes: keys sorted,
 * two-space indent, a final newline, and at most 5 MB. A lock in any other
 * form was edited by hand.
 */
export function parseLock(text: string): ReadResult<McpToolsLock> {
  return readJson(text, LOCK_BYTES_MAX, "tools.lock.json", (value) => {
    const parsed = mcpToolsLockSchema.safeParse(value);
    if (!parsed.success) return { ok: false, issues: schemaIssues(parsed.error) };
    if (formatJson(value) !== text) {
      return {
        ok: false,
        issues: [
          {
            line: null,
            field: null,
            message:
              "tools.lock.json is not in the form Oxagen writes, so it was edited by hand. Change tools.toml instead, and let Oxagen write the lock.",
          },
        ],
      };
    }
    return { ok: true, value: parsed.data };
  });
}

/** A compiled tool manifest (`tool-manifest/v1`), as JSON text. */
export function parseToolManifest(text: string): ReadResult<ToolManifest> {
  return readJson(text, Number.POSITIVE_INFINITY, "the tool manifest", (value) => {
    const parsed = toolManifestSchema.safeParse(value);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: schemaIssues(parsed.error) };
  });
}

/** A tests/calls.jsonl file. */
export function parseRecordedCalls(text: string): ReadResult<RecordedCall[]> {
  return readJsonLines(text, recordedCallSchema);
}

/** A tests/selection.jsonl file. */
export function parseSelectionTests(text: string): ReadResult<SelectionTest[]> {
  return readJsonLines(text, selectionTestSchema);
}
