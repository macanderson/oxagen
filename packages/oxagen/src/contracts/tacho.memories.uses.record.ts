/**
 * The memory files a run read on an enrolled host, and the memory files each
 * full scan found there, sent by the Tacho daemon (ADR-245).
 *
 * A use names the file, the run's root session as the host knows it, how many
 * times the run read the file since the host last reported, and when it last
 * did. The handler finds the run's `tse_…` id and the file's memory, and keeps
 * one use per memory, run, and signal. A run that reads a file twice adds one
 * use. A use whose run Oxagen has not recorded yet comes back in `pending`,
 * and the daemon sends it again with its next report.
 *
 * A scan names a folder where a harness keeps its memory files, and every
 * memory file the scan found there. Each waiting or promoted memory of the
 * host's agent from a file under that folder that the scan did not find
 * retires. The daemon sends a scan only when it listed every folder.
 *
 * Machine-to-machine, authenticated by the host's API key. The host names
 * itself so the handler can check the key's scope names the same host.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { hostEnrollmentIdSchema, tachoHarnessSchema } from "../tacho/schemas";

/** The most uses one report carries. The daemon sends more in later calls. */
export const MEMORY_USES_PER_REPORT = 200;
/** The most memory files one scan names. A larger scan is not sent. */
export const MEMORY_SCAN_PATHS_MAX = 4_000;
/** The most scans one report carries. */
export const MEMORY_SCANS_PER_REPORT = 8;

const pathSchema = z.string().min(1).max(1024);

const useSchema = z
  .object({
    /** The harness whose memory folder holds the file. */
    harness: tachoHarnessSchema,
    /** The memory file's path on the host. With the harness, it is the memory's source. */
    path: pathSchema,
    /** The root session of the run that read the file, as the host recorded it. */
    session_uuid: z.string().uuid(),
    /** How many times the run read the file since the host last reported it. */
    count: z.number().int().min(1).max(10_000),
    /** When the run last read the file. */
    used_at: z.string().datetime({ offset: true }),
  })
  .strict();

const scanSchema = z
  .object({
    harness: tachoHarnessSchema,
    /** The folder the scan read, ending in a path separator. */
    root: pathSchema.regex(
      /[\\/]$/,
      "a scan's root ends in a path separator",
    ),
    /** Every memory file the scan found under the root. */
    paths: z.array(pathSchema).max(MEMORY_SCAN_PATHS_MAX),
  })
  .strict()
  .superRefine((scan, ctx) => {
    scan.paths.forEach((path, index) => {
      if (!path.startsWith(scan.root) || path.length === scan.root.length)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["paths", index],
          message: "every path a scan names is a file under its root",
        });
    });
  });

export const tachoMemoryUsesRecord = registerCapability({
  name: "record_tacho_memory_uses",
  domain: "tacho",
  description:
    "Count the memory files runs read on an enrolled Tacho host, and retire the memories whose files a full scan no longer finds.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      host_enrollment_id: hostEnrollmentIdSchema,
      uses: z.array(useSchema).max(MEMORY_USES_PER_REPORT).default([]),
      scans: z.array(scanSchema).max(MEMORY_SCANS_PER_REPORT).default([]),
    })
    .strict(),
  output: z
    .object({
      /** Uses stored, each against the memory its file holds. */
      recorded: z.number().int().min(0),
      /** Uses of a file that holds no memory in the workspace. They are dropped. */
      unknown: z.number().int().min(0),
      /** The index in `uses` of each use whose run Oxagen has not recorded yet. */
      pending: z.array(z.number().int().min(0)),
      /** Memories the scans retired. */
      retired: z.number().int().min(0),
    })
    .strict(),
});

export type TachoMemoryUsesRecordInput = z.output<
  typeof tachoMemoryUsesRecord.input
>;
export type TachoMemoryUsesRecordOutput = z.output<
  typeof tachoMemoryUsesRecord.output
>;
