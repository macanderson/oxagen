import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

/**
 * A contained run's GitHub access (ADR-152, ADR-254). The operator names one
 * repository and hands over no token. The bridge sends the run's Git smart
 * HTTP for that repository to the daemon's Git custody proxy (ADR-151). The
 * proxy has the server mint a token for the workspace's binding of the
 * repository, uses it for one request outside the sandbox, and revokes it.
 * The REST API is not reachable from the sandbox.
 */
export const containedGitHubSchema = z
  .object({
    repository: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
      .refine((value) => !/\/\.\.?$/.test(value), "Invalid repository name"),
  })
  .strict();

/** What the bridge needs from the daemon's Git custody for one run. */
export interface ContainedGitHubCustody {
  /** The one repository the run may reach, as `owner/name`. */
  repository: string;
  /**
   * A lease for the launcher's own session, good for the one request it is
   * issued for, or the reason there is none.
   */
  lease: () => { status: number; body: unknown };
  /** ADR-151's proxy: checks the mandate, mints, forwards, records, revokes. */
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  /** Drops the lease once its request has ended. */
  release: (token: string) => void;
}

const SEGMENT = "[A-Za-z0-9_-][A-Za-z0-9._-]*";
const GIT_ROUTE = new RegExp(
  `^/github/git/(${SEGMENT})/(${SEGMENT})/(info/refs\\?service=git-(?:upload|receive)-pack|git-upload-pack|git-receive-pack)$`,
);

/**
 * Map a sandbox path to the custody proxy's path for the same Git request,
 * or refuse it. Only the smart-HTTP endpoints of the run's own repository
 * pass. Anything else is refused, another repository under the same owner
 * and the REST API included.
 */
export function custodyGitPath(
  path: string,
  repository: string,
): string | undefined {
  const git = GIT_ROUTE.exec(path);
  if (!git) return undefined;
  const [, owner, name, rest] = git;
  const repo = (name as string).replace(/\.git$/, "");
  if (`${owner}/${repo}`.toLowerCase() !== repository.toLowerCase())
    return undefined;
  return `/github/${owner}/${repo}.git/${rest}`;
}
