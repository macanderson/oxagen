// The region this process answers from (#3841), as a failed read's error
// line prints it: `trace 01K5RSXQ7F2E · us-east-1 · 2026-09-11 09:16:04Z`.
// The deploy sets OXAGEN_REGION in the container's manifest
// (tools/scripts/package-for-node.sh). A process without it, such as a local
// dev server, answers null, and the page says the region was not recorded
// rather than guessing one.
import "server-only";

export function deployRegion(): string | null {
  const region = process.env.OXAGEN_REGION?.trim() ?? "";
  return region === "" ? null : region;
}
