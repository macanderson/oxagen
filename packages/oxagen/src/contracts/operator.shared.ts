/**
 * Who an operator is, for any row that names one.
 *
 * A row's operator is the person who ran the agent. The record keys them by
 * a principal public id, and that id is what every list used to print. A
 * person reads a name, so the rows that name an operator carry these facts
 * beside the id, read from the user record and the role assignment in the
 * caller's scope. Every field the record may not hold is null; nothing
 * substitutes the id for a missing name.
 */
import { z } from "zod";

export const operatorFactsSchema = z
  .object({
    /** The principal public id (`prn_…`): the key, never the label. */
    id: z.string().min(1),
    /** The person's name as they gave it; null for a principal with none. */
    name: z.string().min(1).nullable(),
    email: z.string().min(1).nullable(),
    /** The stored avatar value: an https URL or a designed avatar; null when none. */
    avatarUrl: z.string().min(1).nullable(),
    /**
     * The role the principal holds in the caller's scope: the workspace role
     * when the read is workspace-scoped and one is assigned, else the org
     * role, else null.
     */
    role: z.string().min(1).nullable(),
  })
  .strict();

export type OperatorFacts = z.output<typeof operatorFactsSchema>;
