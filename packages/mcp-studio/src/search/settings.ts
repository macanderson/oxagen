// settings.ts: which provider ranks a search-mode server's tools (lane M15;
// mcp-studio-spec, Large servers; ADR-217).
//
// workspace.toml's [embeddings] names the provider. Unset, it is oxagen:
// Voyage AI's voyage-4-large on Oxagen's key. custom is the workspace's own
// endpoint, model, and key. keyword sends nothing to any provider.
import { createHash } from "node:crypto";
import { embeddingsSchema } from "@oxagen/oxagen/steering-repo/workspace";
import type { z } from "zod";

/** workspace.toml's [embeddings], as workspace/v1 reads it. */
export type EmbeddingSettings = z.output<typeof embeddingsSchema>;

/** Voyage AI's embeddings endpoint, which the oxagen provider sends to. */
export const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";

/** The model the oxagen provider embeds with (ADR-194). */
export const OXAGEN_EMBEDDING_MODEL = "voyage-4-large";

/** Where a workspace's search entries are embedded, or keyword when nowhere. */
export type EmbeddingTarget =
  | {
      provider: "keyword";
      /** True when the stored setting did not read, so nothing is sent anywhere. */
      invalid: boolean;
    }
  | {
      provider: "oxagen";
      url: string;
      model: string;
      /** The index key. It changes when the provider, the endpoint, or the model changes. */
      key: string;
    }
  | {
      provider: "custom";
      url: string;
      model: string;
      /** The oxagen:credential/<name> reference, or null when the endpoint takes no key. */
      credential: string | null;
      key: string;
    };

/**
 * The key a workspace's vectors are stored under. Vectors from two models
 * cannot be compared, so a new provider, endpoint, or model is a new key,
 * and every entry is embedded again under it.
 */
export function targetKey(provider: string, url: string, model: string): string {
  return createHash("sha256").update(`${provider}\n${url}\n${model}`).digest("hex").slice(0, 32);
}

/**
 * The target a stored [embeddings] value names. Nothing stored is the oxagen
 * default. A value that does not read ranks by keyword, so no entry goes to
 * a provider the workspace did not choose.
 */
export function embeddingTarget(value: unknown): EmbeddingTarget {
  if (value === undefined || value === null) return oxagenTarget();
  const parsed = embeddingsSchema.safeParse(value);
  if (!parsed.success) return { provider: "keyword", invalid: true };
  const settings = parsed.data;
  switch (settings.provider) {
    case undefined:
    case "oxagen":
      return oxagenTarget();
    case "keyword":
      return { provider: "keyword", invalid: false };
    case "custom": {
      // workspace/v1 requires both for custom. A value that lacks one did not
      // come through the schema's rules, so it ranks by keyword.
      const { url, model } = settings;
      if (url === undefined || model === undefined) return { provider: "keyword", invalid: true };
      return { provider: "custom", url, model, credential: settings.credential ?? null, key: targetKey("custom", url, model) };
    }
  }
}

function oxagenTarget(): EmbeddingTarget {
  return {
    provider: "oxagen",
    url: VOYAGE_EMBEDDINGS_URL,
    model: OXAGEN_EMBEDDING_MODEL,
    key: targetKey("oxagen", VOYAGE_EMBEDDINGS_URL, OXAGEN_EMBEDDING_MODEL),
  };
}
