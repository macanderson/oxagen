// Shared types for the env-manager tool.

export type EnvName = "development" | "preview" | "production";
export type ServiceName = "api" | "app" | "mcp" | "website" | "admin" | "docs";

export const ENV_NAMES: readonly EnvName[] = ["development", "preview", "production"];
export const SERVICE_NAMES: readonly ServiceName[] = ["api", "app", "mcp", "website", "admin", "docs"];

// Where a value comes from, for a given environment.
//  - gsm:      gcloud secret manager (`gcloud secrets versions access`)
//  - neon:     neonctl connection-string for a Neon project
//  - generate: a fresh random hex secret (consistent across services within one env+key)
//  - static:   a literal value baked into the catalog
//  - manual:   the human sets it elsewhere (e.g. an Inngest dashboard key) — the tool
//              will not auto-resolve it, only show whether it's present on Vercel.
export type Source =
  | { type: "gsm"; secret: string }
  | { type: "neon"; project: string; role?: string; database?: string }
  | { type: "generate"; bytes?: number }
  | { type: "static"; value: string }
  | { type: "manual" };

export interface CatalogEntry {
  key: string;
  group: string;
  description: string;
  /** Secret values are stored as Vercel "encrypted"; non-secrets as "plain" (readable in the dashboard). */
  secret: boolean;
  /** Which Vercel projects need this var. */
  services: ServiceName[];
  /** Per-environment value source. Omit an environment to skip the var there entirely. */
  sources: Partial<Record<EnvName, Source>>;
}

/** One env var as it currently exists on a Vercel project. */
export interface VercelEnvVar {
  id: string;
  key: string;
  target: string[];
  gitBranch: string | null;
  type: string;
}

/** Result of resolving a Source to a concrete value (value itself is never sent to the browser). */
export interface ResolveResult {
  value?: string;
  manual?: boolean;
  error?: string;
}

/** One deploy operation outcome (no secret values — safe to surface to the UI). */
export interface DeployResult {
  key: string;
  env: EnvName;
  service: ServiceName;
  status: "ok" | "skipped" | "manual" | "error";
  detail?: string;
}
