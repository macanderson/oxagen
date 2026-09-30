import { z } from "zod";
import { registerCapability } from "../registry";
import { sha256Schema } from "../steering-repo/common";
import { studioServerNameSchema } from "./tool.studio.draft.save";
import { studioListingSchema } from "./tool.studio.listing.get";

/**
 * Ask a machine to list the tools of a Studio draft for a server that runs on
 * machines (ADR-233, #4756). The draft's server.toml names the server: a
 * local command, or a registry package with source.machines. Oxagen pins it
 * first. A local command takes the version and SHA-256 the person names. A
 * registry package takes the SHA-256 Oxagen reads from the public registry.
 * The machine checks the pin before it starts anything. Read the progress
 * with `get_studio_listing`.
 */
export const toolStudioListingStart = registerCapability({
  name: "start_studio_listing",
  domain: "tool",
  description:
    "Ask one machine in a Studio draft's source.machines to start the draft's server, pinned, and list its tools. A local command takes the version and SHA-256 you name, and a registry package takes the SHA-256 Oxagen reads from its registry. The machine checks the pin before it starts anything, and the tools it lists become the draft's source.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // Listing reads a server's tool list and spends no model tokens.
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  // It starts a program on a person's machine before any review.
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  audit: { targetKind: "tool_server_folder", targetIdField: "server" },
  input: z
    .object({
      /** The folder name under tools/servers/. */
      server: studioServerNameSchema,
      /** The draft revision you see. A draft saved since then is refused. */
      revision: z.number().int().min(1),
      /**
       * A local command's pin: the version you run and the SHA-256 of the
       * executable the command resolves to on the machine. Omit it for a
       * registry package, whose digest Oxagen reads itself.
       */
      pin: z
        .object({
          version: z.string().min(1).max(64),
          digest: sha256Schema,
        })
        .strict()
        .optional(),
    })
    .strict(),
  output: z.object({ listing: studioListingSchema }),
});

export type ToolStudioListingStartInput = z.output<typeof toolStudioListingStart.input>;
export type ToolStudioListingStartOutput = z.output<typeof toolStudioListingStart.output>;
