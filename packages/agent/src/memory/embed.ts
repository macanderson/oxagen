import {
  embedText as embedTextAI,
  embedMany as embedManyAI,
  type EmbedTextOpts,
} from "@oxagen/ai";

export type { EmbedTextOpts };

/**
 * Embed `text` using the shared @oxagen/ai embedText wrapper which
 * records token usage + surface origin in ClickHouse.
 *
 * The optional `opts.telemetry` context should be forwarded from the
 * caller's CapabilityContext when available so every embedding call is
 * metered.
 */
export async function embedText(
  text: string,
  opts: EmbedTextOpts,
): Promise<number[]> {
  return embedTextAI(text, opts);
}

/**
 * Embed several texts in one gateway call, metered once for the batch.
 *
 * Prefer this wherever the caller already holds the whole list — one round trip
 * and one line in the usage ledger, instead of one of each per item.
 */
export async function embedMany(
  texts: string[],
  opts: EmbedTextOpts,
): Promise<number[][]> {
  return embedManyAI(texts, opts);
}
