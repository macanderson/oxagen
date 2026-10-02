/**
 * get_workspace_memory: one memory in full, for the Memories tab's drawer
 * (memory-collection spec, Memories tab; ADR-245).
 *
 * It answers the memory's text and where it came from, the runs that used it
 * (newest first, at most 100), and the memory PR that last cited it. A memory
 * another workspace holds answers not_found.
 *
 * A read. It writes nothing, and the in-app agent never receives it.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  workspaceMemoryIdSchema,
  workspaceMemorySchema,
} from "./steering.memories.shared";

/** The most uses one read answers. `uses_total` counts them all. */
export const WORKSPACE_MEMORY_USES_MAX = 100;

const instant = z.string().datetime({ offset: true });

export const steeringMemoriesGet = registerCapability({
  name: "get_workspace_memory",
  domain: "context",
  description:
    "Read one workspace memory with its full text, its source, the runs that used it, and the memory PR that last cited it.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z
    .object({
      memory_id: workspaceMemoryIdSchema,
    })
    .strict(),
  output: z
    .object({
      memory: workspaceMemorySchema.extend({
        /** The run that wrote it, or null for a memory with no run. */
        run: z.string().nullable(),
        /** `frame:<run>/<seq>` references, or URLs for a memory with no run. */
        evidence: z.array(z.string()),
        applies_to: z.array(z.string()).nullable(),
        tools: z.array(z.string()).nullable(),
        retired_at: instant.nullable(),
        retired_reason: z.enum(["deleted", "unused"]).nullable(),
      }),
      /** The runs that used it, newest first. */
      uses: z.array(
        z
          .object({
            /** The run, or null for a use the harness counted with no run. */
            run: z.string().nullable(),
            signal: z.enum(["read", "harness_count", "citation"]),
            /** Reads in the run, or the harness's count. */
            count: z.number().int().positive(),
            used_at: instant,
          })
          .strict(),
      ),
      /** Every use row the memory holds, beyond the 100 this read answers. */
      uses_total: z.number().int().nonnegative(),
      /** The memory PR that last cited it, or null when none has. */
      memory_pr: z
        .object({
          id: z.string(),
          number: z.number().int().positive(),
          url: z.string(),
          repository: z.string(),
          branch: z.string(),
          status: z.enum(["open", "merged", "closed"]),
          opened_at: instant,
          settled_at: instant.nullable(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
});

export type SteeringMemoriesGetInput = z.output<
  typeof steeringMemoriesGet.input
>;
export type SteeringMemoriesGetOutput = z.output<
  typeof steeringMemoriesGet.output
>;
