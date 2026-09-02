import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoCiStatus } from "@oxagen/oxagen/contracts/repo.ci.status";
import { createGitHubClient } from "@oxagen/github";
import { resolveGitHubToken } from "./lib/github-token";
import { buildCiSummary } from "./lib/ci-status";

export const repoCiStatusHandler: CapabilityHandler<
  typeof repoCiStatus
> = async (input, ctx) => {
  const token = await resolveGitHubToken(ctx);
  const gh = createGitHubClient({ token });
  const checks = await gh.listCiChecks({
    owner: input.owner,
    repo: input.repo,
    ref: input.ref,
  });
  const { overall, counts, runs } = buildCiSummary(checks);
  return {
    ref: input.ref,
    sha: checks.sha,
    overall,
    counts,
    runs,
  };
};
