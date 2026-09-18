/**
 * `list_repositories`: every repository the workspace binds, main and linked
 * (Mission Control spec §10.1), for the Workspace settings dialog's
 * Repositories section, the CLI and MCP.
 *
 * One row per binding head, carrying the binding version the head points at.
 * The main repository sorts first; the linked ones follow by full name.
 * `connectionLive` is false when the GitHub connection behind a head has been
 * retired, the state in which that repository silently stops resolving.
 *
 * Makes no GitHub call: every fact here is local, so the list renders while
 * GitHub is down. A read: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { repositoryMainBind } from "./repository.main.bind";

export const repositoryRole = z.enum(["main", "linked"]);

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
            owner: z.string().min(1),
            name: z.string().min(1),
            /** `owner/name` as GitHub reported it when the binding was written. */
            fullName: z.string().min(1),
            defaultRef: z.string().min(1),
            htmlUrl: z.string().url(),
            boundAt: z.string().datetime({ offset: true }),
            connectionLive: z.boolean(),
          })
          .strict(),
      ),
    })
    .strict(),
});

export type RepositoryListInput = z.output<typeof repositoryList.input>;
export type RepositoryListOutput = z.output<typeof repositoryList.output>;
