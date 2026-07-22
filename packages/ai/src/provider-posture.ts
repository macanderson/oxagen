// Provider capability posture registry — the structural guard against
// per-provider gotchas.
//
// Born from a real defect (in Oxagen's sibling codebase, Stella): Anthropic
// models routed through a gateway ran with NO prompt caching — 0% cache hits
// across a multi-dollar session — because Anthropic's prompt cache is explicit
// opt-in while OpenAI/Gemini/DeepSeek caches are implicit. Nothing enforced
// that divergence, so every token billed at the full input rate, silently.
//
// This module makes that class of gap structural instead of tribal. Every
// vendor the gateway can route to declares a row on every axis, and the tests
// in ./provider-posture.test.ts fail when a row is missing, when the catalog
// and the matrix disagree, or when a row names a witness test that no longer
// exists in the sources.
//
// Four axes are guarded, each one a place where providers diverge in a way
// that fails silently rather than loudly:
//   - CachePosture             — how the prompt cache is engaged and observed.
//   - ReasoningPosture         — how the reasoning/thinking budget is controlled.
//   - StructuredOutputPosture  — how schema-constrained output is obtained.
//   - AttachmentPosture        — which non-text input parts the model accepts.
//
// THE LAW FOR NEW VENDORS: adding a vendor to the `Vendor` union in ./catalog
// means adding a row on every axis here in the same PR. TypeScript enforces
// this at compile time — each matrix is a `Record<Vendor, …>`, so a missing row
// is a type error, not a runtime surprise. Any variant carrying a `witness`
// must name a test that PROVES the posture (the opt-in marker reaches the
// wire, the hit telemetry is parsed, the reasoning control lands in the request
// body). The no-control variants carry a `reason`/`note` a reviewer can check
// instead. The same pattern extends to any future per-provider divergence:
// when one vendor needs something the others don't, record it as a matrix —
// don't leave it as adapter folklore.
//
// CLIENT-SAFE: like ./catalog, this module must stay free of any `ai` /
// `@ai-sdk/*` imports so the model picker can render posture badges without
// dragging provider SDKs into the browser bundle.

import type { Vendor } from "./catalog";

// ── Witness sources ──────────────────────────────────────────────────────────
//
// The test files every witness must live in. The rotted-witness test reads
// these from disk, so a renamed or deleted witness fails the package's tests
// rather than becoming a stale claim in the matrix. Paths are relative to this
// package's `src` directory.

export const WITNESS_SOURCES = [
  "stream.test.ts",
  "catalog.test.ts",
  "generate-object.test.ts",
] as const;

// ── Cache axis ───────────────────────────────────────────────────────────────

/** How a vendor's prompt cache is engaged and observed. */
export type CachePosture =
  | {
      kind: "opt-in";
      /** The wire mechanism, for humans reading the matrix. */
      mechanism: string;
      /** Test title proving the opt-in marker reaches the request. */
      witness: string;
    }
  | {
      kind: "implicit";
      /** Where the hits are reported on this vendor's usage envelope. */
      telemetry: string;
      /** Test title proving the telemetry is read and metered. */
      witness: string;
    }
  | {
      kind: "not-applicable";
      reason: string;
    };

/**
 * One cache row per vendor in the `Vendor` union (./catalog). Every Oxagen LLM
 * call goes through the Vercel AI Gateway, so the vendor is the `creator`
 * prefix of the gateway model id (`anthropic/claude-sonnet-5` → `anthropic`).
 *
 * The gateway normalizes each upstream's cache-read count into
 * `usage.inputTokenDetails.cacheReadTokens`, which `streamAgentReply` forwards
 * to both the telemetry row and the cost meter — that is the shared parse path
 * behind every `implicit` row. What the gateway does NOT do is invent the
 * opt-in marker Anthropic requires, which is why `anthropic` is the one
 * `opt-in` row: the marker is placed by us, in `streamAgentReply`.
 */
export const CACHE_POSTURE: Record<Vendor, CachePosture> = {
  anthropic: {
    kind: "opt-in",
    mechanism:
      "Anthropic caches NOTHING without an explicit breakpoint. streamAgentReply carries the " +
      "(stable, per-workspace) system prompt as a leading system message tagged " +
      "providerOptions.anthropic.cacheControl = {type: 'ephemeral'} — the system *param* cannot " +
      "hold the marker, only message-level providerOptions can. Every other vendor ignores the " +
      "anthropic namespace, so the marker is a no-op (never an error) off Anthropic.",
    witness:
      "prepends the system prompt as an Anthropic-cacheable system message",
  },
  openai: {
    kind: "implicit",
    telemetry:
      "OpenAI caches prefixes automatically above its minimum cacheable size; the gateway " +
      "normalizes input_tokens_details.cached_tokens into usage.inputTokenDetails.cacheReadTokens",
    witness:
      "forwards prompt-cache reads (inputTokenDetails.cacheReadTokens) to telemetry and the meter",
  },
  google: {
    kind: "implicit",
    telemetry:
      "Gemini implicit context caching; the gateway normalizes " +
      "usageMetadata.cachedContentTokenCount into usage.inputTokenDetails.cacheReadTokens",
    witness:
      "forwards prompt-cache reads (inputTokenDetails.cacheReadTokens) to telemetry and the meter",
  },
  xai: {
    kind: "implicit",
    telemetry:
      "Grok caches implicitly; the gateway normalizes prompt_tokens_details.cached_tokens into " +
      "usage.inputTokenDetails.cacheReadTokens (shared chat-completions parse path)",
    witness:
      "forwards prompt-cache reads (inputTokenDetails.cacheReadTokens) to telemetry and the meter",
  },
  meta: {
    kind: "implicit",
    telemetry:
      "Llama is served by whichever host the gateway routes to; any cached-token count the host " +
      "reports arrives pre-normalized as usage.inputTokenDetails.cacheReadTokens, and is simply " +
      "zero on hosts that report none",
    witness:
      "forwards prompt-cache reads (inputTokenDetails.cacheReadTokens) to telemetry and the meter",
  },
  mistral: {
    kind: "implicit",
    telemetry:
      "Mistral exposes no request-level cache control; any cached-token count reaches us " +
      "pre-normalized as usage.inputTokenDetails.cacheReadTokens (zero when the host reports none)",
    witness:
      "forwards prompt-cache reads (inputTokenDetails.cacheReadTokens) to telemetry and the meter",
  },
  deepseek: {
    kind: "implicit",
    telemetry:
      "DeepSeek spells its hit telemetry differently from everyone else (top-level " +
      "prompt_cache_hit_tokens, no prompt_tokens_details object) — the gateway normalizes that " +
      "native spelling into usage.inputTokenDetails.cacheReadTokens for us. Left un-normalized " +
      "this is exactly the sibling defect that dropped DeepSeek cache hits in Stella.",
    witness:
      "forwards prompt-cache reads (inputTokenDetails.cacheReadTokens) to telemetry and the meter",
  },
  bfl: {
    kind: "not-applicable",
    reason:
      "FLUX is an image-generation model reached through selectImageModel(); there is no prompt " +
      "prefix to cache and no billed cache to opt into or meter",
  },
};

// ── Reasoning axis ───────────────────────────────────────────────────────────

/**
 * How a vendor's reasoning / thinking budget is controlled from a request. The
 * sibling of {@link CachePosture}: reasoning diverges the same way, and a
 * pinned effort that reaches no vendor field is silently dropped rather than
 * rejected.
 */
export type ReasoningPosture =
  | {
      kind: "controllable";
      /** The wire mechanism, for humans reading the matrix. */
      mechanism: string;
      /** Test title proving the control reaches the request body. */
      witness: string;
    }
  | {
      /** Always reasons; depth cannot be pinned from the request. */
      kind: "fixed-on";
      note: string;
    }
  | {
      /** No reasoning mode at all for the models this vendor serves. */
      kind: "fixed-off";
      note: string;
    }
  | {
      /** Reasons, but exposes no request-level control we can drive. */
      kind: "unsupported";
      note: string;
    }
  | {
      kind: "not-applicable";
      reason: string;
    };

/**
 * One reasoning row per vendor — same completeness contract as
 * {@link CACHE_POSTURE}. The mapping lives in `reasoningRequestConfig`
 * (./stream), which switches on the gateway model id's vendor prefix and
 * returns the vendor-specific `providerOptions` plus a `temperatureLocked`
 * flag (some vendors reject ANY temperature while thinking is active).
 *
 * Note on the `fixed-off` rows: `reasoningRequestConfig`'s `default` branch
 * falls back to the `openai` providerOptions namespace for an unrecognised
 * vendor prefix, which is back-compat behaviour for bare model ids. Meta and
 * Mistral hit that branch — but they carry no `reasoning` capability in the
 * catalog, and callers gate on `supportsReasoning()` before forwarding an
 * effort, so no effort is ever sent for them. The row records that reasoning
 * is off for these vendors AND why the fallback branch is not a live hazard;
 * if either model family ever gains reasoning, this row is the thing that has
 * to change with it.
 */
export const REASONING_POSTURE: Record<Vendor, ReasoningPosture> = {
  anthropic: {
    kind: "controllable",
    mechanism:
      "Claude 4.x adaptive thinking: providerOptions.anthropic.thinking = {type: 'adaptive'} plus " +
      "outputConfig.effort carrying all five tiers verbatim (low…max — Anthropic is the only " +
      "vendor with xhigh/max). Temperature MUST be omitted entirely while thinking is active.",
    witness:
      "sets adaptive thinking + output_config.effort and locks temperature",
  },
  openai: {
    kind: "controllable",
    mechanism:
      "providerOptions.openai.reasoningEffort (low|medium|high — the Anthropic-only xhigh/max " +
      "tiers clamp down to high so the request is never rejected) plus reasoningSummary: " +
      "'detailed' so a reasoning summary actually streams into fullStream. Temperature is locked.",
    witness: "sets reasoningEffort + reasoningSummary and locks temperature",
  },
  google: {
    kind: "controllable",
    mechanism:
      "providerOptions.google.thinkingConfig = {includeThoughts: true, thinkingBudget: <tokens>} — " +
      "Gemini takes a token budget, not an effort word, so the effort tier maps through the " +
      "REASONING_BUDGET table. Temperature is NOT locked for Google.",
    witness:
      "sets thinkingConfig with includeThoughts and correct budget, does NOT lock temperature",
  },
  xai: {
    kind: "controllable",
    mechanism:
      "providerOptions.xai.reasoningEffort (low|medium|high, xhigh/max clamped to high). Grok " +
      "does not lock temperature.",
    witness: "sets xai reasoningEffort and does NOT lock temperature",
  },
  deepseek: {
    kind: "unsupported",
    note:
      "DeepSeek's reasoner models reason unconditionally and stream reasoning natively, but the " +
      "API exposes no request-level effort control. reasoningRequestConfig returns no " +
      "providerOptions for the deepseek prefix — an honest no-op rather than a guessed field, " +
      "since an unknown key risks a hard 400.",
  },
  meta: {
    kind: "fixed-off",
    note:
      "Llama 4 Maverick carries no `reasoning` capability in the catalog, so callers gating on " +
      "supportsReasoning() never forward an effort. Were one forwarded it would hit " +
      "reasoningRequestConfig's unrecognised-vendor fallback and be sent in the `openai` " +
      "namespace, which Meta hosts ignore — see this module's note on the fixed-off rows.",
  },
  mistral: {
    kind: "fixed-off",
    note:
      "Mistral Large 3 carries only the `tools` capability — no reasoning mode to control. Same " +
      "unrecognised-vendor fallback caveat as meta; no effort is ever forwarded for it.",
  },
  bfl: {
    kind: "not-applicable",
    reason:
      "FLUX is an image-generation model — there is no reasoning phase and no chat request to " +
      "attach a thinking budget to",
  },
};

// ── Structured-output axis ───────────────────────────────────────────────────

/** How schema-constrained (JSON) output is obtained from a vendor. */
export type StructuredOutputPosture =
  | {
      /**
       * Schema-constrained decoding is available and the gateway drives it —
       * the returned object is guaranteed to parse against the schema.
       */
      kind: "native";
      mechanism: string;
      /** Test title proving the schema reaches the call and the output parses. */
      witness: string;
    }
  | {
      /**
       * No constrained decoding upstream; the schema is enforced by prompting
       * plus a parse/retry loop, so a malformed response is possible.
       */
      kind: "emulated";
      mechanism: string;
      witness: string;
    }
  | {
      kind: "not-applicable";
      reason: string;
    };

/**
 * One structured-output row per vendor. Unlike cache and reasoning — where
 * Oxagen builds vendor-specific wire payloads — structured output goes through
 * ONE path for every text vendor: `generateObjectFor` (./generate-object)
 * hands the zod schema to the AI SDK's `generateObject`, and the gateway
 * translates it into whatever the upstream calls constrained decoding.
 *
 * That shared path is why these rows share a witness. It is recorded as a
 * matrix anyway for two reasons: the axis is where the next silent divergence
 * would land (a vendor whose constrained decoding the gateway cannot drive
 * would degrade to best-effort JSON with no error), and an image-only vendor
 * must be an honest N/A rather than an implied yes.
 */
export const STRUCTURED_OUTPUT_POSTURE: Record<
  Vendor,
  StructuredOutputPosture
> = {
  anthropic: {
    kind: "native",
    mechanism:
      "generateObjectFor passes the zod schema to the AI SDK's generateObject; the gateway maps " +
      "it onto Anthropic's tool-based structured output",
    witness: "calls generateObject with default temperature 0 and the schema",
  },
  openai: {
    kind: "native",
    mechanism:
      "generateObjectFor passes the zod schema to generateObject; the gateway maps it onto " +
      "OpenAI's response_format json_schema (strict constrained decoding)",
    witness: "calls generateObject with default temperature 0 and the schema",
  },
  google: {
    kind: "native",
    mechanism:
      "generateObjectFor passes the zod schema to generateObject; the gateway maps it onto " +
      "Gemini's responseSchema / responseMimeType application-json pair",
    witness: "calls generateObject with default temperature 0 and the schema",
  },
  xai: {
    kind: "native",
    mechanism:
      "generateObjectFor passes the zod schema to generateObject; Grok's chat-completions " +
      "response_format json_schema is driven by the gateway",
    witness: "calls generateObject with default temperature 0 and the schema",
  },
  meta: {
    kind: "emulated",
    mechanism:
      "Llama hosts vary in whether they honour a json_schema response_format, so the gateway " +
      "falls back to prompt-directed JSON with the SDK's parse/repair step — the schema shapes " +
      "the output but does not constrain decoding. Treat a parse failure as possible, not " +
      "impossible, on this vendor.",
    witness: "returns an object that satisfies the zod schema",
  },
  mistral: {
    kind: "emulated",
    mechanism:
      "Mistral's JSON mode constrains the output to valid JSON but not to the supplied schema; " +
      "field-level conformance comes from the prompt plus the SDK's parse step",
    witness: "returns an object that satisfies the zod schema",
  },
  deepseek: {
    kind: "emulated",
    mechanism:
      "DeepSeek exposes a JSON-object response format, not a schema-constrained one; the schema " +
      "is carried in the prompt and validated by the SDK's parse step on return",
    witness: "returns an object that satisfies the zod schema",
  },
  bfl: {
    kind: "not-applicable",
    reason:
      "FLUX returns image bytes, not text — there is no token stream to constrain with a schema",
  },
};

// ── Attachment axis ──────────────────────────────────────────────────────────

/** Which non-text input parts a vendor's models accept. */
export type AttachmentPosture =
  | {
      kind: "supported";
      /** The input part kinds this vendor accepts, beyond plain text. */
      kinds: readonly ("image" | "video" | "audio")[];
      mechanism: string;
      /** Test title proving the capability gate distinguishes input from generation. */
      witness: string;
    }
  | {
      /** Chat-capable, but text parts only — attachments must be transcoded. */
      kind: "text-only";
      note: string;
    }
  | {
      kind: "not-applicable";
      reason: string;
    };

/**
 * One attachment row per vendor. The gate is the catalog's per-model
 * capability array, read through `supportsVision` (image input) and
 * `supportsVideoInput` (native video parts) — both of which deliberately
 * return false for an id the catalog cannot describe, so an unknown model
 * never gets assumed multimodal.
 *
 * The distinction these rows exist to keep straight is input vs generation:
 * `vision` (accepts images) is NOT `image` (generates images), and
 * `video-input` (accepts video) is NOT `video` (generates video). Conflating
 * them is how an image-generation model ends up offered as a place to upload
 * a screenshot.
 */
export const ATTACHMENT_POSTURE: Record<Vendor, AttachmentPosture> = {
  anthropic: {
    kind: "supported",
    kinds: ["image"],
    mechanism:
      "Claude accepts image parts (the `vision` capability on every Claude row in the catalog); " +
      "no native video or audio parts — those must be transcoded to frames/transcript upstream",
    witness: "distinguishes vision (image input) from image generation",
  },
  openai: {
    kind: "supported",
    kinds: ["image"],
    mechanism:
      "GPT-5.2 carries `vision`; the reasoning-only rows (gpt-5-mini, o4) do not, so the gate is " +
      "per-model rather than per-vendor — supportsVision() reads the model's own capability array",
    witness: "distinguishes vision (image input) from image generation",
  },
  google: {
    kind: "supported",
    kinds: ["image", "video", "audio"],
    mechanism:
      "Gemini is the only vendor accepting native video file parts (`video-input`) alongside " +
      "image and audio. Models without it fall back to sampled keyframes, so the video-input " +
      "gate is what decides whether a real video part is sent or frames are extracted first.",
    witness: "distinguishes video INPUT (Gemini) from video generation (Veo)",
  },
  xai: {
    kind: "supported",
    kinds: ["image"],
    mechanism:
      "Grok 4 carries `vision` — image parts accepted, no native video or audio input",
    witness: "distinguishes vision (image input) from image generation",
  },
  meta: {
    kind: "supported",
    kinds: ["image"],
    mechanism:
      "Llama 4 Maverick carries `vision` — image parts accepted, no video or audio input",
    witness: "distinguishes vision (image input) from image generation",
  },
  mistral: {
    kind: "text-only",
    note:
      "Mistral Large 3 carries only `tools` in the catalog — no vision. supportsVision() returns " +
      "false, so the composer offers no attachment affordance for it rather than sending a part " +
      "the model will reject.",
  },
  deepseek: {
    kind: "text-only",
    note:
      "DeepSeek V3.2 carries `reasoning` and `tools` but no vision — text parts only. An image " +
      "must be described or OCR'd before it can reach this vendor.",
  },
  bfl: {
    kind: "not-applicable",
    reason:
      "FLUX is reached through selectImageModel(), not the chat path — it takes a generation " +
      "prompt, not conversational message parts",
  },
};

// ── Lookup + projection ──────────────────────────────────────────────────────

/** Every axis's posture for one vendor. */
export interface VendorPosture {
  vendor: Vendor;
  cache: CachePosture;
  reasoning: ReasoningPosture;
  structuredOutput: StructuredOutputPosture;
  attachments: AttachmentPosture;
}

/** The vendor prefix of a gateway model id (`anthropic/claude-sonnet-5` → `anthropic`). */
export function vendorFromModelId(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash === -1 ? modelId : modelId.slice(0, slash);
}

/**
 * Narrow an arbitrary string to a known `Vendor`, or undefined.
 *
 * Uses an own-property check, not `in`: `in` walks the prototype chain, so
 * `asVendor("toString")` would answer `"toString"` and `posturesFor` would then
 * hand back `Object.prototype.toString` as a posture row. A BYOK customer can
 * put any string here, and unknown must read as unknown.
 */
export function asVendor(candidate: string): Vendor | undefined {
  return Object.prototype.hasOwnProperty.call(CACHE_POSTURE, candidate)
    ? (candidate as Vendor)
    : undefined;
}

/**
 * The full posture for a vendor id, or undefined for an id the matrix does not
 * know — which the completeness test turns into a hard failure for any vendor
 * the catalog can actually route to.
 */
export function posturesFor(vendor: string): VendorPosture | undefined {
  const known = asVendor(vendor);
  if (!known) return undefined;
  return {
    vendor: known,
    cache: CACHE_POSTURE[known],
    reasoning: REASONING_POSTURE[known],
    structuredOutput: STRUCTURED_OUTPUT_POSTURE[known],
    attachments: ATTACHMENT_POSTURE[known],
  };
}

/**
 * The posture that applies to a gateway model id. Resolves the vendor prefix
 * first, so `postureForModel("anthropic/claude-sonnet-5")` answers with the
 * Anthropic row. Returns undefined for an id whose prefix is not a known
 * vendor (a BYOK customer pointing at something the matrix has never seen) —
 * callers must treat that as "unknown", never as "supported".
 */
export function postureForModel(modelId: string): VendorPosture | undefined {
  return posturesFor(vendorFromModelId(modelId));
}

/** Every vendor's posture, in a stable (alphabetical) order. */
export function allPostures(): VendorPosture[] {
  return (Object.keys(CACHE_POSTURE) as Vendor[])
    .sort()
    .map((v) => posturesFor(v) as VendorPosture);
}

// ── Badge projection (UI) ────────────────────────────────────────────────────

/** A one-word posture summary plus the sentence behind it, for a UI badge. */
export interface PostureBadge {
  axis: "cache" | "reasoning" | "structuredOutput" | "attachments";
  label: string;
  /** The mechanism / note / reason from the row — the badge's tooltip body. */
  detail: string;
  /**
   * Whether this posture needs the caller to DO something (send a marker,
   * pass a control) versus getting it for free. Drives badge emphasis: an
   * opt-in cache that nobody opted into is the defect this registry exists
   * to prevent, so it reads differently from an implicit one.
   */
  requiresAction: boolean;
}

const CACHE_LABEL = {
  "opt-in": "Cache: opt-in",
  implicit: "Cache: automatic",
  "not-applicable": "Cache: n/a",
} as const;

const REASONING_LABEL = {
  controllable: "Reasoning: controllable",
  "fixed-on": "Reasoning: always on",
  "fixed-off": "Reasoning: none",
  unsupported: "Reasoning: no control",
  "not-applicable": "Reasoning: n/a",
} as const;

const STRUCTURED_LABEL = {
  native: "Structured output: native",
  emulated: "Structured output: emulated",
  "not-applicable": "Structured output: n/a",
} as const;

/** Human-readable badges for one vendor's posture, for the model picker. */
export function postureBadges(posture: VendorPosture): PostureBadge[] {
  const { cache, reasoning, structuredOutput, attachments } = posture;

  const attachmentLabel =
    attachments.kind === "supported"
      ? `Accepts: ${attachments.kinds.join(", ")}`
      : attachments.kind === "text-only"
        ? "Accepts: text only"
        : "Attachments: n/a";

  return [
    {
      axis: "cache",
      label: CACHE_LABEL[cache.kind],
      detail:
        cache.kind === "opt-in"
          ? cache.mechanism
          : cache.kind === "implicit"
            ? cache.telemetry
            : cache.reason,
      requiresAction: cache.kind === "opt-in",
    },
    {
      axis: "reasoning",
      label: REASONING_LABEL[reasoning.kind],
      detail:
        reasoning.kind === "controllable"
          ? reasoning.mechanism
          : reasoning.kind === "not-applicable"
            ? reasoning.reason
            : reasoning.note,
      requiresAction: reasoning.kind === "controllable",
    },
    {
      axis: "structuredOutput",
      label: STRUCTURED_LABEL[structuredOutput.kind],
      detail:
        structuredOutput.kind === "not-applicable"
          ? structuredOutput.reason
          : structuredOutput.mechanism,
      // Emulated output can come back malformed — the caller must handle a
      // parse failure rather than assume the schema held.
      requiresAction: structuredOutput.kind === "emulated",
    },
    {
      axis: "attachments",
      label: attachmentLabel,
      detail:
        attachments.kind === "supported"
          ? attachments.mechanism
          : attachments.kind === "text-only"
            ? attachments.note
            : attachments.reason,
      requiresAction: false,
    },
  ];
}
