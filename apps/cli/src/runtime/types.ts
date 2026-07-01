/**
 * Model-runtime domain types (Group 1 — on-device runtime and auto-provisioning).
 *
 * This is the base layer every later group depends on. Group 2's orchestrator
 * consumes {@link ModelProvider} and the registry to run the coordinator on
 * device and dispatch workers to cloud models, so these types are deliberately
 * framework-free: no Ink, no AI SDK, no gateway. A provider decides *how* it
 * talks to a model; callers only ever see this interface.
 *
 * The provider contract mirrors `models.json -> providers` exactly.
 */

/** Where a model runs. On-device is local weights; cloud is a network call. */
export type ModelKind = "on-device" | "cloud";

/** GGUF quantization levels, ordered worst → best quality. */
export type Quantization = "q4" | "q5" | "q6" | "q8";

/**
 * Reasoning effort forwarded to models with a thinking mode. Mirrors the
 * agent's own {@link import("../agent/model.js").ReasoningEffort} so a caller can
 * pass the same value through either path. Kept local so this module stays
 * framework-free.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** One chat message handed to a provider. */
export interface CompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A completion request — the same shape for on-device and cloud providers. */
export interface CompletionRequest {
  messages: CompletionMessage[];
  /** Upper bound on generated tokens. Omit to use the provider default. */
  maxOutputTokens?: number;
  /** Sampling temperature. Omit to use the provider default. */
  temperature?: number;
  /** Reasoning effort for models that support a thinking mode. */
  effort?: ReasoningEffort;
  /** Cancels a long generation (on-device weights can take a while). */
  signal?: AbortSignal;
}

/** Token accounting for a single completion. */
export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
}

/** The result of a completion. */
export interface CompletionResult {
  text: string;
  usage: CompletionUsage;
  /** Concrete model id/slug that produced the text. */
  model: string;
  kind: ModelKind;
  /** Estimated provider cost in USD (0 for on-device). */
  costUsd: number;
}

/** What a model can do — surfaced by `oxagen models list` and the router. */
export interface ModelCapabilities {
  /** Friendly id used across the registry (e.g. "haiku", or a modelId row). */
  id: string;
  kind: ModelKind;
  vendor: string;
  /** Max context window in tokens. */
  contextWindow: number;
  /** Whether the model runs fully offline once available. */
  offline: boolean;
  /** Whether the model supports tool / function calling. */
  tools: boolean;
  /** 0..1 code-benchmark score used for on-device resolution + display. */
  codeScore?: number;
  /** Approx parameter count, e.g. "32B" or "30B-A3B". */
  params?: string;
}

/**
 * The one provider interface every model implements — on-device and cloud alike.
 * Mirrors `models.json -> providers.methods`.
 */
export interface ModelProvider {
  /** Stable id for this provider instance (registry key or resolved modelId). */
  id(): string;
  kind(): ModelKind;
  /**
   * Can this provider serve a request *right now* without side effects? For
   * on-device this means the optional dep is installed and the weights are
   * cached; for cloud it means a credential is resolvable.
   */
  isAvailable(): Promise<boolean>;
  /**
   * Make the provider ready to serve, performing side effects if needed. For
   * on-device this triggers the optional download (checksum-verified, cached).
   * Idempotent: a no-op when already ready.
   */
  ensureReady(): Promise<void>;
  /** Run one completion. */
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /** Cheap, no-network estimate of the tokens + USD a request would cost. */
  estimateCost(req: CompletionRequest): { tokens: number; usd: number };
  capabilities(): ModelCapabilities;
}

// ── Registry (parsed from models.json) ───────────────────────────────────────

/** One on-device weight file for a specific quantization. */
export interface ModelSource {
  /** HTTPS URL of the GGUF weight file. */
  url: string;
  /**
   * Expected SHA-256 (lowercase hex). Empty = trust-on-first-use: the checksum
   * is computed and pinned to the cache manifest on first successful download,
   * then enforced on every later run.
   */
  sha256?: string;
  /** Advisory file size in bytes (progress + a cheap pre-flight sanity check). */
  sizeBytes?: number;
}

/** One row of the capability table — a candidate on-device code model. */
export interface CapabilityRow {
  modelId: string;
  /** 0..1 code-benchmark score. Higher wins during resolution. */
  codeScore: number;
  contextWindow: number;
  params: string;
  /** RAM floor (GB) for the smallest supported quantization. */
  minRamGB: number;
  quantizations: Quantization[];
  license: string;
  /** Per-quantization download sources. Absent rows can't be provisioned. */
  sources?: Partial<Record<Quantization, ModelSource>>;
}

/** A cloud model the registry can hand to a provider. */
export interface CloudModelEntry {
  /** Vercel AI Gateway slug (`vendor/model`). */
  slug: string;
  vendor: string;
  contextWindow: number;
  tools: boolean;
}

/** Default runtime config baked into models.json (overridable by user config). */
export interface RuntimeConfigDefaults {
  coordinator: string;
  onDevice: {
    autoDownload: boolean;
    modelId: string;
    cacheDir: string;
    verifyChecksum: boolean;
    quantizationPreference: Quantization[];
  };
}

/** The whole models.json, typed. */
export interface RegistryFile {
  config: { runtime: RuntimeConfigDefaults };
  capabilityTable: {
    note?: string;
    columns: string[];
    rows: CapabilityRow[];
  };
  cloudModels: Record<string, CloudModelEntry>;
  registry: {
    coordinatorCandidates: string[];
    workerModels: { defaultCode: string; cheapBasic: string };
    judgeModels: { default: string; rule: string };
  };
  cliCommands: Record<string, string>;
}

// ── Device profile ───────────────────────────────────────────────────────────

/** A snapshot of the host's compute budget, used to fit an on-device model. */
export interface DeviceProfile {
  /** Total system RAM in GB. */
  ramGB: number;
  /** Dedicated / unified GPU memory in GB (0 when unknown or none). */
  vramGB: number;
  /** GPU backend label, or null for CPU-only. */
  gpu: string | null;
  cpuCores: number;
  /** True when GPU memory is shared with system RAM (Apple Silicon). */
  unifiedMemory: boolean;
}
