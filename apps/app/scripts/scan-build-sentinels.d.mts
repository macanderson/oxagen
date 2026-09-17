// Types for scan-build-sentinels.mjs, so the arch test imports it typed.
export const SENTINELS: readonly string[];
export const SCANNED_DIRS: readonly string[];
export function scanBuild(
  buildDir: string,
): { file: string; sentinel: string }[];
