export * from "./types.js";
export * from "./images.js";
export * from "./policy.js";
export { createDockerSandbox } from "./docker.js";

import type { SandboxDriver } from "./types.js";
import { createDockerSandbox } from "./docker.js";

let _instance: SandboxDriver | null = null;

export function getSandbox(): SandboxDriver {
  if (_instance) return _instance;
  _instance = createDockerSandbox();
  return _instance;
}

export function setSandboxForTests(driver: SandboxDriver | null): void {
  _instance = driver;
}
