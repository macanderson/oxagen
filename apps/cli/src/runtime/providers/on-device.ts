/**
 * The on-device model provider — the always-allowed coordinator.
 *
 * Requirement 2: the developer can always select on-device as the primary agent.
 * This provider never silently falls back to a cloud model. When it can't serve
 * (optional dep missing, nothing cached, auto-download off, or nothing fits the
 * device) it throws a *typed, explanatory* error so the caller can offer the
 * right next step — install the dep, run `oxagen models pull`, or choose a cloud
 * coordinator — rather than quietly swapping the model out.
 *
 * The heavy pieces (device detection, resolution, download, inference) all come
 * in as injectable deps so this class is fully unit-testable without weights,
 * a network, or the optional native package.
 */
import { detectDevice } from "../device.js";
import {
  ensureModelCached,
  isCached,
  type FetchImpl,
  type ProgressFn,
} from "../provisioning/download.js";
import {
  loadOptionalRuntime,
  OPTIONAL_DEP,
  type LoadedModel,
  type OnDeviceRuntime,
} from "../provisioning/optional-runtime.js";
import { resolveBestOnDeviceModel, type ResolveResult } from "../resolver.js";
import {
  getAutoDownload,
  getCacheDir,
  getOnDeviceModelId,
  getQuantizationPreference,
  getVerifyChecksum,
} from "../config.js";
import { estimateInputTokens } from "../tokens.js";
import type {
  CapabilityRow,
  CompletionRequest,
  CompletionResult,
  DeviceProfile,
  ModelCapabilities,
  ModelProvider,
  Quantization,
} from "../types.js";

/** The optional inference runtime is not installed. Offer to install it. */
export class OptionalDepMissingError extends Error {
  constructor() {
    super(
      `The on-device runtime is not installed. Install the optional dependency to ` +
        `run a model locally:\n\n    npm install ${OPTIONAL_DEP}\n\n` +
        `Then run \`oxagen models pull\`. Or choose a cloud coordinator with ` +
        `\`oxagen models use haiku\`.`,
    );
    this.name = "OptionalDepMissingError";
  }
}

/** No model in the capability table fits this device. Offer a cloud coordinator. */
export class NoFittingModelError extends Error {
  constructor(reason: string) {
    super(
      `No on-device model fits this device: ${reason}. ` +
        `Choose a cloud coordinator with \`oxagen models use haiku\`.`,
    );
    this.name = "NoFittingModelError";
  }
}

/** Weights aren't cached and auto-download is off. Tell the user how to pull. */
export class AutoDownloadDisabledError extends Error {
  constructor(modelId: string) {
    super(
      `On-device model "${modelId}" is not cached and auto-download is disabled. ` +
        `Run \`oxagen models pull\` to download it.`,
    );
    this.name = "AutoDownloadDisabledError";
  }
}

export interface OnDeviceProviderDeps {
  device?: DeviceProfile;
  /** Config overrides (default to the runtime config accessors). */
  modelId?: string;
  quantPref?: Quantization[];
  cacheDir?: string;
  autoDownload?: boolean;
  verifyChecksum?: boolean;
  /** Capability table (defaults to the registry). */
  table?: CapabilityRow[];
  /** Injectable HTTP + runtime + clock, so tests avoid the network/native dep. */
  fetchImpl?: FetchImpl;
  loadRuntime?: () => Promise<OnDeviceRuntime | null>;
  now?: () => string;
}

const defaultFetch: FetchImpl = async (url, init) => {
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    body: res.body as AsyncIterable<Uint8Array> | null,
  };
};

export class OnDeviceProvider implements ModelProvider {
  private readonly device: DeviceProfile;
  private readonly quantPref: Quantization[];
  private readonly cacheDir: string;
  private readonly autoDownload: boolean;
  private readonly verifyChecksum: boolean;
  private readonly fetchImpl: FetchImpl;
  private readonly loadRuntime: () => Promise<OnDeviceRuntime | null>;
  private readonly now: () => string;
  /** The resolved model+quant for this device, computed once at construction. */
  private readonly resolution: ResolveResult;
  /** Memoised loaded model, so repeated completions don't reload the weights. */
  private loaded: LoadedModel | null = null;

  constructor(deps: OnDeviceProviderDeps = {}) {
    this.device = deps.device ?? detectDevice();
    this.quantPref = deps.quantPref ?? getQuantizationPreference();
    this.cacheDir = deps.cacheDir ?? getCacheDir();
    this.autoDownload = deps.autoDownload ?? getAutoDownload();
    this.verifyChecksum = deps.verifyChecksum ?? getVerifyChecksum();
    this.fetchImpl = deps.fetchImpl ?? defaultFetch;
    this.loadRuntime = deps.loadRuntime ?? (() => loadOptionalRuntime());
    this.now = deps.now ?? (() => new Date().toISOString());
    this.resolution = resolveBestOnDeviceModel(
      this.device,
      this.quantPref,
      deps.modelId ?? getOnDeviceModelId(),
      deps.table,
    );
  }

  /** The resolved capability row, or null when nothing fits the device. */
  get resolvedRow(): CapabilityRow | null {
    return this.resolution.row;
  }

  /** The resolved quantization, or null when nothing fits the device. */
  get resolvedQuant(): Quantization | null {
    return this.resolution.quant;
  }

  /** Why this pick (or why nothing fit) — surfaced by the `models` command. */
  get rationale(): string {
    return this.resolution.rationale;
  }

  id(): string {
    return this.resolution.row?.modelId ?? "on-device";
  }

  kind(): "on-device" {
    return "on-device";
  }

  async isAvailable(): Promise<boolean> {
    if (!this.resolution.row || !this.resolution.quant) return false;
    const runtime = await this.loadRuntime();
    if (!runtime) return false;
    return isCached(
      this.cacheDir,
      this.resolution.row.modelId,
      this.resolution.quant,
    ).cached;
  }

  /**
   * Make on-device serving ready: verify a model fits, the optional dep is
   * installed, and the weights are cached (downloading them when auto-download
   * is on). Each failure is a typed, actionable error — never a silent fallback.
   */
  async ensureReady(onProgress?: ProgressFn): Promise<void> {
    const { row, quant } = this.resolution;
    if (!row || !quant)
      throw new NoFittingModelError(this.resolution.rationale);

    const runtime = await this.loadRuntime();
    if (!runtime) throw new OptionalDepMissingError();

    const cached = isCached(this.cacheDir, row.modelId, quant);
    if (cached.cached) return;

    if (!this.autoDownload) throw new AutoDownloadDisabledError(row.modelId);
    await this.pull(onProgress);
  }

  /**
   * Download + cache the resolved model's weights (checksum-verified). Idempotent
   * against a valid cache. Exposed for `oxagen models pull`.
   */
  async pull(
    onProgress?: ProgressFn,
  ): Promise<{ path: string; fromCache: boolean }> {
    const { row, quant } = this.resolution;
    if (!row || !quant)
      throw new NoFittingModelError(this.resolution.rationale);
    const source = row.sources?.[quant];
    if (!source) {
      throw new Error(
        `No download source for ${row.modelId} at ${quant} in the capability table.`,
      );
    }
    const res = await ensureModelCached({
      dir: this.cacheDir,
      modelId: row.modelId,
      quant,
      source,
      verifyChecksum: this.verifyChecksum,
      fetchImpl: this.fetchImpl,
      now: this.now(),
      ...(onProgress ? { onProgress } : {}),
    });
    return { path: res.path, fromCache: res.fromCache };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    await this.ensureReady();
    const { row, quant } = this.resolution;
    // ensureReady guarantees these are set and the file is cached.
    const source = isCached(this.cacheDir, row!.modelId, quant!);
    const runtime = await this.loadRuntime();
    if (!runtime) throw new OptionalDepMissingError();

    if (!this.loaded) this.loaded = await runtime.load(source.path);
    const out = await this.loaded.complete(req);
    return {
      text: out.text,
      usage: out.usage,
      model: row!.modelId,
      kind: "on-device",
      costUsd: 0,
    };
  }

  estimateCost(req: CompletionRequest): { tokens: number; usd: number } {
    const inputTokens = estimateInputTokens(req);
    const outputTokens = req.maxOutputTokens ?? 1024;
    // On-device inference has no per-token provider charge.
    return { tokens: inputTokens + outputTokens, usd: 0 };
  }

  capabilities(): ModelCapabilities {
    const row = this.resolution.row;
    return {
      id: row?.modelId ?? "on-device",
      kind: "on-device",
      vendor: "on-device",
      contextWindow: row?.contextWindow ?? 0,
      offline: true,
      tools: true,
      ...(row ? { codeScore: row.codeScore, params: row.params } : {}),
    };
  }

  /** Release loaded weights (frees RAM). Safe to call when nothing is loaded. */
  async dispose(): Promise<void> {
    await this.loaded?.dispose();
    this.loaded = null;
  }
}
