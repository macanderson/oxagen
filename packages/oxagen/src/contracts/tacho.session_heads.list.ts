/**
 * Which of a batch of sessions the control plane already holds for the
 * calling host, asked by `oxagen agent backfill` before it seals anything
 * (ADR-161, spec `docs/specs/tacho/backfill.md` section 4).
 *
 * A host that lost its `TACHO_HOME`, or reinstalled, has no local record of
 * the sessions it shipped. Its backfill would start each of them at seq 0,
 * and ingest answers a second chain for a session it holds as a chain break.
 * The pass asks here first and skips every session in the answer.
 *
 * Machine-to-machine, authenticated by the host's API key. The answer names
 * only root sessions the calling host holds, or that an earlier enrollment of
 * the same agent in the same workspace recorded, so a host learns nothing
 * about another agent's sessions. Read-only.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { hostEnrollmentIdSchema } from "../tacho/schemas";

/** The most session uuids one call takes. */
export const TACHO_SESSION_HEADS_MAX = 500;

/**
 * A harness session id the call takes: Claude Code's are uuids. The bound
 * keeps the body small enough for one route limit, and the character set
 * needs no JSON escape.
 */
export const TACHO_HARNESS_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const tachoSessionHeadsList = registerCapability({
  name: "list_tacho_session_heads",
  domain: "tacho",
  description:
    "List which of a batch of sessions the control plane already holds for the calling Tacho host, with how each was recorded.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      host_enrollment_id: hostEnrollmentIdSchema,
      /** The chain uuids the host derived for the sessions it may backfill. */
      session_uuids: z
        .array(z.string().uuid())
        .min(1)
        .max(TACHO_SESSION_HEADS_MAX),
      /**
       * The same sessions' harness session ids. A machine enrolled again
       * after it lost `TACHO_HOME` derives new chain uuids, so a session an
       * earlier enrollment of the same agent recorded is found by its id.
       */
      harness_session_ids: z
        .array(z.string().regex(TACHO_HARNESS_SESSION_ID))
        .max(TACHO_SESSION_HEADS_MAX)
        .optional(),
    })
    .strict(),
  output: z
    .object({
      /**
       * One entry per named session the control plane holds: by chain uuid
       * for this host, or by harness session id for this host's agent. Order
       * is not meaningful.
       */
      sessions: z
        .array(
          z
            .object({
              session_uuid: z.string().uuid(),
              harness_session_id: z.string(),
              /** How many frames the control plane holds, from seq 0. */
              seq_count: z.number().int().min(0),
              /**
               * `live`, `backfill` (rebuilt from a transcript), or `mixed`
               * (a live resume continued a backfill).
               */
              record_basis: z.enum(["live", "backfill", "mixed"]),
              /** The normalizer version a backfill sealed the session under. */
              backfill_normalizer: z.string().nullable(),
            })
            .strict(),
        )
        // A session can match by its uuid and by its id, once each.
        .max(TACHO_SESSION_HEADS_MAX * 2),
    })
    .strict(),
});

export type TachoSessionHeadsListInput = z.output<
  typeof tachoSessionHeadsList.input
>;
export type TachoSessionHeadsListOutput = z.output<
  typeof tachoSessionHeadsList.output
>;
