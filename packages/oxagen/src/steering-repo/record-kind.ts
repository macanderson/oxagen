// record-kind.ts: the eight kinds a steering record can be. It imports only
// zod, so a capability contract can name a record kind without pulling the
// YAML reader in record.ts into the eager contracts graph
// (skill-frontmatter.test.ts). record.ts re-exports all three names.
import { z } from "zod";

export const RECORD_KINDS = [
  "business-rule",
  "code-rule",
  "constraint",
  "procedure",
  "skill",
  "fact",
  "preference",
  "memory",
] as const;
export const recordKindSchema = z.enum(RECORD_KINDS);
export type RecordKind = z.output<typeof recordKindSchema>;
