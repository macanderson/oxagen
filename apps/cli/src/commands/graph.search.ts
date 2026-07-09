/** `oxagen graph search …` — unified natural-language (vector) search across the
 *  entire knowledge graph, via the org-scoped `/graph/search` API.
 *
 *  Output follows the universal discipline (ADR-023 §4): `--json` or a piped
 *  stdout emits ONE machine line; a TTY without the flag keeps the historical
 *  2-space-indented JSON view (same shape either way, so `| jq` consumers see
 *  no change — this command previously ignored its context and always printed
 *  the indented form). */
import { apiPost } from "../lib/api.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { createOutput } from "../lib/output.js";

export interface GraphSearchOptions {
  query: string;
  kinds?: string;
  labels?: string;
  limit?: string;
  /** commander: `--system` => true, `--no-system` => false, omitted => undefined. */
  system?: boolean;
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
  const out = createOutput({ json: opts.json, quiet: opts.quiet, autoJson: true }, writer);
  // --system => isSystem=true, --no-system => false, neither => undefined (both).
  const isSystem = opts.system === true ? true : opts.system === false ? false : undefined;

  const result = await apiPost("graph/search", {
    query: opts.query,
    kinds: splitCsv(opts.kinds),
    labels: splitCsv(opts.labels),
    limit: opts.limit ? parseInt(opts.limit, 10) : 10,
    isSystem,
  });

  out.data(result);
}
