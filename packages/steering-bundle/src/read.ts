// read.ts: steering_read (steering-repo-spec, Agent use).
//
// It returns one record as the model reads it, a heading with the label and
// then the body with its @tool: mentions rendered, or one file from a skill's
// folder. The frontmatter never reaches the model. Both come from the
// published version, found by blob, so a read during a run sees the same text
// the run's index described.
import { z } from "zod";
import type { Bundle, BundleRecord } from "@oxagen/oxagen/steering-repo/bundle";
import { lineageSchema } from "@oxagen/oxagen/steering-repo/common";
import { readSteeringRecord } from "@oxagen/oxagen/steering-repo/record";
import { toolModesOf } from "./mentions";
import { recordSection, type BundleSource, type Delivery, type ReadBody } from "./render";

export const steeringReadInputSchema = z
  .object({
    lineage: lineageSchema.describe("The record or skill to read, such as a-intel.domain.refund."),
    file: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe("A file in the skill's folder, such as words.md. Unset, the record itself."),
  })
  .strict();
export type SteeringReadInput = z.input<typeof steeringReadInputSchema>;

export const steeringReadOutputSchema = z
  .object({
    lineage: z.string(),
    label: z.string(),
    kind: z.string(),
    source: z.enum(["workspace", "organization"]),
    version: z.number().int().min(1),
    path: z.string(),
    text: z.string(),
  })
  .strict();
export type SteeringReadOutput = z.output<typeof steeringReadOutputSchema>;

/** One file of a published version, read by its blob. */
export type ReadFile = (
  source: BundleSource,
  bundle: Bundle,
  file: { path: string; blob: string },
) => Promise<string>;

/** Why a read found nothing. */
export type SteeringReadMiss = "record_not_found" | "file_not_found";

export type SteeringReadResult =
  | { found: true; output: SteeringReadOutput }
  | { found: false; miss: SteeringReadMiss };

/** A record file that does not read as a steering record, so its body is unknown. */
export class RecordFileError extends Error {
  constructor(readonly path: string) {
    super(`${path} is not a steering record file, so its body cannot be read.`);
    this.name = "RecordFileError";
  }
}

/** The body reader renderRequest takes, over a file reader. */
export function recordBodyReader(delivery: Delivery, readFile: ReadFile): ReadBody {
  return async (source, record) => {
    const bundle = delivery[source];
    if (bundle === null) throw new Error(`The ${source} has no published version.`);
    const read = readSteeringRecord(
      await readFile(source, bundle, { path: record.path, blob: record.blob }),
    );
    if (!read.ok) throw new RecordFileError(record.path);
    return read.body;
  };
}

function findRecord(
  delivery: Delivery,
  lineage: string,
): { record: BundleRecord; source: BundleSource; bundle: Bundle } | null {
  // The workspace's own record wins over an organization record of the same lineage.
  const sources: BundleSource[] = ["workspace", "organization"];
  for (const source of sources) {
    const bundle = delivery[source];
    const record = bundle?.records.find((entry) => entry.lineage === lineage);
    if (bundle !== null && record !== undefined) return { record, source, bundle };
  }
  return null;
}

/** A skill file named by its path in the repository or in the skill's folder. */
function findFile(record: BundleRecord, file: string): { path: string; blob: string } | null {
  const folder = record.path.slice(0, record.path.lastIndexOf("/") + 1);
  const wanted = file.startsWith(folder) ? file : `${folder}${file.replace(/^\.?\//, "")}`;
  return record.files?.find((entry) => entry.path === wanted) ?? null;
}

/** Read one record, or one file from a skill's folder. */
export async function readSteering(
  delivery: Delivery,
  input: SteeringReadInput,
  readFile: ReadFile,
): Promise<SteeringReadResult> {
  const found = findRecord(delivery, input.lineage);
  if (found === null) return { found: false, miss: "record_not_found" };
  const { record, source, bundle } = found;
  const base = {
    lineage: record.lineage,
    label: record.label,
    kind: record.kind,
    source,
    version: bundle.version,
  };
  if (input.file !== undefined) {
    const file = findFile(record, input.file);
    if (file === null) return { found: false, miss: "file_not_found" };
    return {
      found: true,
      output: { ...base, path: file.path, text: await readFile(source, bundle, file) },
    };
  }
  const body = await recordBodyReader(delivery, readFile)(source, record);
  return {
    found: true,
    output: {
      ...base,
      path: record.path,
      text: recordSection(record.label, body, toolModesOf(bundle)),
    },
  };
}
