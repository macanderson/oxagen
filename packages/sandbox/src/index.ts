export * from "./types.js";
export * from "./images.js";
export * from "./policy.js";
export { createDockerSandbox } from "./docker.js";
export { createModalSandbox } from "./modal.js";
export { createVercelSandbox } from "./vercel.js";

import type { SandboxDriver } from "./types.js";
import { createDockerSandbox } from "./docker.js";
import { createModalSandbox } from "./modal.js";
import { createVercelSandbox } from "./vercel.js";

let _instance: SandboxDriver | null = null;

// Driver selection is env-driven so swapping providers is a deploy-time
// concern, not a code change. Order of precedence:
//   SANDBOX_DRIVER=vercel → @vercel/sandbox Firecracker microVMs (Vercel Functions)
//   SANDBOX_DRIVER=modal  → hosted Firecracker via Modal (prod default
//                           once MODAL_RUNNER_URL is set on Vercel)
//   SANDBOX_DRIVER=docker → local Dockerode (dev + self-hosted)
//   unset                 → modal if MODAL_RUNNER_URL is present, else docker
//
// The agent.code.execute capability itself is still gated by
// SANDBOX_ENABLED in materializeTools, so an unconfigured driver never
// gets advertised to the model.
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
