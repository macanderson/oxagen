/**
 * `list_repositories`: every repository the workspace binds, main and linked
 * (Mission Control spec §10.1), for the Repositories page, the CLI and
 * MCP.
 *
 * One row per binding head, carrying the binding version the head points at.
 * The main repository sorts first; the linked ones follow by full name.
 * `connectionLive` is false when the GitHub connection behind a head has been
 * retired, the state in which that repository silently stops resolving.
 * `events` says whether GitHub can deliver the repository's events at all:
 * the App's installation lifecycle and the connection's state.
 *
 * Makes no GitHub call: every fact here is local, so the list renders while
 * GitHub is down. A read: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { repositoryMainBind } from "./repository.main.bind";

export const repositoryRole = z.enum(["main", "linked"]);

/**
 * Whether GitHub can deliver this repository's events to Oxagen, from the
 * facts Oxagen holds: the connection's state and the App installation's
 * lifecycle, which the App's own `installation` events keep current (§11.4).
 * `installed` means the App is installed and the connection is live, which is
 * the precondition for delivery and not a claim that an event arrived.
 * `unknown` is an installation the registry has no row for.
 *
 * A GitLab project (#3762) has no App installation. It reads `installed` when
 * its connection is live and Oxagen registered the project webhook, `paused`
 * or `retired` from the connection as on GitHub, and `unknown` otherwise.
 */
export const repositoryEventDelivery = z.enum([
  "installed",
  "suspended",
  "uninstalled",
  "paused",
  "retired",
  "unknown",
]);

export const repositoryList = registerCapability({
  name: "list_repositories",
  domain: "repository",
  description:
    "List the workspace's repositories — its one main repository and every linked one — with each one's role and approved default ref.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({}).strict(),
  output: z
    .object({
      repositories: z.array(
        z
          .object({
            bindingId: repositoryMainBind.output.shape.bindingId,
            role: repositoryRole,
            /** The host: a GitHub repository or a gitlab.com project. */
            provider: z.enum(["github", "gitlab"]),
            owner: z.string().min(1),
            name: z.string().min(1),
            /** `owner/name` as GitHub reported it when the binding was written. */
            fullName: z.string().min(1),
            defaultRef: z.string().min(1),
            htmlUrl: z.string().url(),
            boundAt: z.string().datetime({ offset: true }),
            connectionLive: z.boolean(),
            events: repositoryEventDelivery,
          })
          .strict(),
      ),
    })
    .strict(),
});

export type RepositoryListInput = z.output<typeof repositoryList.input>;
export type RepositoryListOutput = z.output<typeof repositoryList.output>;
