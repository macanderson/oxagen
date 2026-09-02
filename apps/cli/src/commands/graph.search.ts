/** `oxagen graph search …` — unified natural-language (vector) search across the
 *  customer context graph, via the workspace-scoped `/graph/search` API.
 *
 *  Output follows the universal discipline (ADR-023 §4): `--json` or a piped
 *  stdout emits ONE machine line; a TTY without the flag prints the same shape
 *  2-space-indented, so `| jq` consumers see identical data either way. */
import { apiPost } from "../lib/api.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { createOutput } from "../lib/output.js";

export interface GraphSearchOptions {
  query: string;
  labels?: string;
  limit?: string;
  json?: boolean;
  quiet?: boolean;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export async function handleGraphSearch(
  opts: GraphSearchOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput(
    { json: opts.json, quiet: opts.quiet, autoJson: true },
    writer,
  );
  const result = await apiPost("graph/search", {
    query: opts.query,
    labels: splitCsv(opts.labels),
    limit: opts.limit ? parseInt(opts.limit, 10) : 10,
  });

  out.data(result);
}
