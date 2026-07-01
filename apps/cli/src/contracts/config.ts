/**
 * Unified config shape (all groups).
 *
 * The merged `AppConfig` every group's typed accessors read a slice of:
 * `runtime` (Group 1's coordinator + on-device settings), `routing` (Group 2's
 * router policy), `graph` (Group 3), `monitors` (Group 5), `pipeline`
 * (Groups 4/6's assist-tool + quality-gate policy), and `timeouts` (Group 8).
 * The pipeline's `pipeline-config.json` (once Group 6 lands) is the runtime
 * source of truth; this type mirrors it.
 *
 * Reconciled against shipped code:
 *   - `Quantization` and `Complexity` are imported from `./model-provider.js`
 *     and `./orchestrator.js` (the canonical, already-shipped Group 1/2
 *     sources) instead of being redeclared here, so there is exactly one of
 *     each in the barrel.
 *   - The stub's `CoordinatorModel` type (`"on-device" | "haiku"`) is dropped.
 *     Shipped Group 1 (`runtime/types.ts`'s `RuntimeConfigDefaults.coordinator`
 *     and `runtime/config.ts`'s `getCoordinator()`) types the coordinator as a
 *     plain `string` — any registry id (not just `"on-device"`/`"haiku"`) is a
 *     valid coordinator, and the registry's candidate list is data
 *     (`models.json`), not a closed union. `RuntimeConfig.coordinator` below
 *     follows the shipped `string` shape. See the PR description's
 *     "Reconciliation notes".
 */
import type { Complexity } from "./orchestrator.js";
import type { Quantization } from "./model-provider.js";
import type { TimeoutConfig } from "./timeouts.js";

export interface OnDeviceConfig {
  autoDownload: boolean; // auto-pull the best OSS on-device code model on opt-in
  modelId: string; // "auto" resolves the best model for this device
  cacheDir: string;
  verifyChecksum: boolean;
  quantizationPreference: Quantization[];
}

export interface RuntimeConfig {
  /**
   * Coordinator model id: `"on-device"` (default) or a cloud registry id such
   * as `"haiku"`. Typed `string`, not a closed literal union — see the file
   * header's reconciliation note.
   */
  coordinator: string;
  onDevice: OnDeviceConfig;
}

export interface RoutingConfig {
  trivialMaxComplexity: Complexity; // coordinator only does work at or below this
  switchCostTokenBudget: number; // guard against low-value mid-turn model switches
  defaultCodeWorker: string; // "sonnet-5"
  cheapBasicWorker: string; // "haiku"
}

export interface GraphConfig {
  enabled: boolean;
  endpoint: string;
  maxNodes: number;
  fallbackToGrep: boolean;
}

export interface MonitorsConfig {
  askBeforeMonitoring: boolean;
  dispatchOnPullRequest: boolean;
  dispatchOnCiFix: boolean;
  pollIntervalSeconds: number;
}

export interface PipelineConfig {
  enabled: boolean; // false turns off judge, enhancer, and survey
  verifyWork: boolean; // true means evidence of done is mandatory
  promptEnhancement: { enabled: boolean; minAcceptableScore: number };
  survey: {
    enabled: boolean;
    maxQuestions: number;
    alwaysAllowFreeText: boolean;
    preferBestPracticeOverAsking: boolean;
  };
  judge: { enabled: boolean; defaultModel: string; mustDifferFromWorker: boolean };
  plan: { minComplexity: Complexity };
  screenshots: { requireWhenScreenImpacted: boolean };
}

export interface AppConfig {
  pipeline: PipelineConfig;
  runtime: RuntimeConfig;
  routing: RoutingConfig;
  graph: GraphConfig;
  monitors: MonitorsConfig;
  timeouts: TimeoutConfig;
}
