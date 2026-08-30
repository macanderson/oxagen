import { embedText as embedTextAI, type EmbedTextOpts } from "@oxagen/ai";

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
