export * from "./types";
export * from "./images";
export * from "./policy";
export * from "./workspace";
export { createDockerSandbox } from "./docker";
export { createModalSandbox } from "./modal";
export { createVercelSandbox } from "./vercel";

import type { SandboxDriver } from "./types";
import { createDockerSandbox } from "./docker";
import { createModalSandbox } from "./modal";
import { createVercelSandbox } from "./vercel";

// Explicit provider names a sandbox template can select per run.
export type SandboxProviderName = "modal" | "vercel" | "docker";

// A test-injected driver short-circuits BOTH the env-driven default and any
// per-run provider override, so a single mock stands in for every call site.
let _testOverride: SandboxDriver | null = null;
// The env-driven default driver (SANDBOX_DRIVER / auto-detect), built lazily.
let _default: SandboxDriver | null = null;
// Per-provider drivers built for explicit `getSandbox(provider)` overrides.
const _byProvider = new Map<SandboxProviderName, SandboxDriver>();

// Driver selection is env-driven so swapping providers is a deploy-time
// concern, not a code change. Order of precedence:
//   SANDBOX_DRIVER=vercel → @vercel/sandbox Firecracker microVMs (Vercel Functions)
//   SANDBOX_DRIVER=modal  → hosted Firecracker via Modal (prod default
//                           once MODAL_RUNNER_URL is set on Vercel)
//   SANDBOX_DRIVER=docker → local Dockerode (dev + self-hosted)
//   unset                 → modal if MODAL_RUNNER_URL is present, else docker
//
// The agent.code.execute capability is gated by isSandboxAvailable() in
// materializeTools so an unconfigured driver is never advertised to the model.

/**
 * Single source of truth for whether a sandbox driver is usable.
 *
 * Returns true only when BOTH of the following hold:
 *   1. SANDBOX_ENABLED=true   — opt-in flag (off by default in prod, OXA-1348)
 *   2. A driver is actually configured with its required credentials:
 *        vercel: SANDBOX_DRIVER=vercel (OIDC creds resolved lazily — flag alone
 *                is enough because the token is injected by the Vercel runtime)
 *        modal:  SANDBOX_DRIVER=modal AND MODAL_RUNNER_URL AND MODAL_RUNNER_TOKEN set
 *        docker: explicit SANDBOX_DRIVER=docker, OR no explicit driver and no
 *                modal env vars present (docker is the local-dev fallback)
 *
 * This function is intentionally side-effect-free (no singleton creation) so
 * it can be called from materialize-tools without initialising a driver.
 */
export function isSandboxAvailable(): boolean {
  if (process.env.SANDBOX_ENABLED !== "true") return false;

  const explicit = process.env.SANDBOX_DRIVER?.toLowerCase();

  if (explicit === "vercel") {
    // Vercel sandbox: OIDC token is injected automatically in the Vercel
    // runtime. Explicit driver selection is the only required precondition.
    return true;
  }

  if (explicit === "modal") {
    // Modal sandbox: requires both URL and auth token.
    return Boolean(process.env.MODAL_RUNNER_URL && process.env.MODAL_RUNNER_TOKEN);
  }

  if (explicit === "docker") {
    // Docker sandbox: no extra credentials needed — Docker socket path is
    // always available in dev. Explicit selection is sufficient.
    return true;
  }

  // No explicit driver: mirror the auto-detect logic in getSandbox().
  // Modal auto-detects when both URL and token are set; otherwise docker.
  // Docker is always available locally so return true in the unset case
  // (the caller already verified SANDBOX_ENABLED=true above).
  return true;
}

function createVercelDriver(): SandboxDriver {
  return createVercelSandbox({
    token: process.env.VERCEL_SANDBOX_TOKEN,
    teamId: process.env.VERCEL_SANDBOX_TEAM_ID,
    projectId: process.env.VERCEL_SANDBOX_PROJECT_ID,
  });
}

function createModalDriver(): SandboxDriver {
  const modalUrl = process.env.MODAL_RUNNER_URL;
  const modalToken = process.env.MODAL_RUNNER_TOKEN;
  if (!modalUrl || !modalToken) {
    throw new Error(
      "SANDBOX_DRIVER=modal requires MODAL_RUNNER_URL and MODAL_RUNNER_TOKEN",
    );
  }
  return createModalSandbox({ runnerUrl: modalUrl, runnerToken: modalToken });
}

/**
 * Build (or reuse) the driver for an EXPLICIT provider override — a sandbox
 * template selecting a provider per run. An unavailable provider (e.g. modal
 * without its runner creds) throws a clear error rather than silently falling
 * back to another driver, so a template that demands modal never runs on docker.
 */
function driverForProvider(provider: string): SandboxDriver {
  const p = provider.toLowerCase();
  if (p !== "modal" && p !== "vercel" && p !== "docker") {
    throw new Error(
      `[sandbox] unknown provider "${provider}" — expected "modal", "vercel", or "docker"`,
    );
  }
  const cached = _byProvider.get(p);
  if (cached) return cached;
  const driver =
    p === "vercel"
      ? createVercelDriver()
      : p === "modal"
        ? createModalDriver()
        : createDockerDriver();
  _byProvider.set(p, driver);
  return driver;
}

function createDockerDriver(): SandboxDriver {
  return createDockerSandbox();
}

/** Build the env-driven default driver (SANDBOX_DRIVER / auto-detect). */
function createDefaultDriver(): SandboxDriver {
  const explicit = process.env.SANDBOX_DRIVER?.toLowerCase();

  // Explicit SANDBOX_DRIVER=vercel always wins — checked before modal
  // so an explicit choice is never silently overridden by URL auto-detect.
  if (explicit === "vercel") return createVercelDriver();

  const modalUrl = process.env.MODAL_RUNNER_URL;
  const modalToken = process.env.MODAL_RUNNER_TOKEN;
  const wantModal =
    explicit === "modal" || (!explicit && Boolean(modalUrl && modalToken));
  if (wantModal) return createModalDriver();

  return createDockerDriver();
}

/**
 * Resolve a sandbox driver.
 *
 * With no argument, returns the deployment-default driver selected by
 * `SANDBOX_DRIVER` (or auto-detect). With a `provider`, returns the driver for
 * that provider — a sandbox template's per-run override — building it on first
 * use. `SANDBOX_DRIVER` remains the default/fallback for runs with no template.
 */
export function getSandbox(provider?: string): SandboxDriver {
  // Test injection wins for every path so one mock covers all call sites.
  if (_testOverride) return _testOverride;
  if (provider) return driverForProvider(provider);
  if (_default) return _default;
  _default = createDefaultDriver();
  return _default;
}

export function setSandboxForTests(driver: SandboxDriver | null): void {
  _testOverride = driver;
  // Clearing the override also drops the lazily-built caches so the next
  // getSandbox() rebuilds against the current env.
  if (driver === null) {
    _default = null;
    _byProvider.clear();
  }
}
