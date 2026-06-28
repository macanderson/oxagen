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

let _instance: SandboxDriver | null = null;

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

export function getSandbox(): SandboxDriver {
  if (_instance) return _instance;
  const explicit = process.env.SANDBOX_DRIVER?.toLowerCase();

  // Explicit SANDBOX_DRIVER=vercel always wins — checked before modal
  // so an explicit choice is never silently overridden by URL auto-detect.
  const wantVercel = explicit === "vercel";
  if (wantVercel) {
    _instance = createVercelSandbox({
      token: process.env.VERCEL_SANDBOX_TOKEN,
      teamId: process.env.VERCEL_SANDBOX_TEAM_ID,
      projectId: process.env.VERCEL_SANDBOX_PROJECT_ID,
    });
    return _instance;
  }

  const modalUrl = process.env.MODAL_RUNNER_URL;
  const modalToken = process.env.MODAL_RUNNER_TOKEN;
  const wantModal =
    explicit === "modal" || (!explicit && Boolean(modalUrl && modalToken));
  if (wantModal) {
    if (!modalUrl || !modalToken) {
      throw new Error(
        "SANDBOX_DRIVER=modal requires MODAL_RUNNER_URL and MODAL_RUNNER_TOKEN",
      );
    }
    _instance = createModalSandbox({ runnerUrl: modalUrl, runnerToken: modalToken });
    return _instance;
  }

  _instance = createDockerSandbox();
  return _instance;
}

export function setSandboxForTests(driver: SandboxDriver | null): void {
  _instance = driver;
}
