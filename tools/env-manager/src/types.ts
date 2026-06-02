// Shared types for the env-manager tool.
// ServiceName, EnvName and their constant arrays are the canonical versions
// from @oxagen/config — re-exported here so the rest of the tool keeps a
// single local import path.
export type { EnvName, ServiceName } from "@oxagen/config";
export { ENV_NAMES, SERVICE_NAMES } from "@oxagen/config";

// Where a value comes from, for a given environment.
//  - static:   a literal baked into the registry (derived from @oxagen/config)
//  - generate: a fresh random hex secret, consistent across services within
//              one env+key (e.g. api and app share the same BETTER_AUTH_SECRET)
//  - manual:   the operator supplies the value via the paste-and-fan-out UI;
//              the tool will not auto-resolve it, only show whether it's present
export type Source =
  | { type: "static"; value: string }
  | { type: "generate"; bytes?: number }
  | { type: "manual" };

export interface CatalogEntry {
  key: string;
  group: string;
  description: string;
  /** Secret values are stored as Vercel "encrypted"; non-secrets as "plain". */
  secret: boolean;
  /** Which Vercel projects need this var. */
  services: import("@oxagen/config").ServiceName[];
  /** Per-environment value source. Omit an environment to skip the var there. */
  sources: Partial<Record<import("@oxagen/config").EnvName, Source>>;
}

/** One env var as it currently exists on a Vercel project. */
export interface VercelEnvVar {
  id: string;
  key: string;
  target: string[];
  gitBranch: string | null;
  type: string;
}

/** Result of resolving a Source to a concrete value (never sent to browser). */
export interface ResolveResult {
  value?: string;
  manual?: boolean;
  error?: string;
}

/** One deploy operation outcome (no secret values — safe to surface to the UI). */
export interface DeployResult {
  key: string;
  env: import("@oxagen/config").EnvName;
  service: import("@oxagen/config").ServiceName;
  status: "ok" | "skipped" | "manual" | "error";
  detail?: string;
}
