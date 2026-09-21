import { z } from "zod";
import { registerCapability } from "../registry";

export const runFramesIngest = registerCapability({
  name: "ingest_run_frames",
  domain: "run",
  description:
    "Append evidence to the attempt bound to a run credential and refresh its expiry.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      events: z
        .array(
          z
            .object({
              attemptSeq: z
                .number()
                .int()
                .positive()
                .max(Number.MAX_SAFE_INTEGER),
              eventType: z.string().min(1).max(128),
              observedAt: z.string().datetime({ offset: true }),
              payload: z.record(z.unknown()).optional(),
              encryptedPayloadRef: z.string().max(128).optional(),
              payloadDigest: z.string().max(128).optional(),
              body: z
                .object({
                  contentType: z.string().min(1).max(128),
                  base64: z
                    .string()
                    .max(1_398_104)
                    .regex(
                      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
                    ),
                })
                .strict()
                .optional(),
            })
            .strict(),
        )
        .min(1)
        .max(200),
    })
    .strict(),
  output: z
    .object({
      expiresAt: z.string().datetime(),
      lastAttemptSeq: z.number().int(),
      lastRunSeq: z.string(),
      events: z.array(
        z
          .object({
            attemptSeq: z.number().int(),
            runSeq: z.string(),
            eventId: z.string(),
            eventDigest: z.string(),
            idempotent: z.boolean(),
          })
          .strict(),
      ),
    })
    .strict(),
});
