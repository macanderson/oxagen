import {
  budgetTokens,
  type ContextFrame,
} from "@contextgraphprotocol/typescript-sdk";
import { z } from "zod";
import { digestBytes } from "../digest";

/** The local transfer profile consumes full CGP frames. References need a resolver. */
const fullFrameSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    title: z.string().min(1),
    content: z.string().max(256_000),
    score: z.number().min(0).max(1),
    token_cost: z.number().int().min(0),
    content_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    citation_label: z.string().min(1),
    representation: z.literal("full").optional(),
    valid_from: z.string().datetime({ offset: true }).optional(),
    valid_to: z.string().datetime({ offset: true }).optional(),
    provenance: z
      .array(
        z
          .object({
            type: z.string().min(1),
            uri: z.string().min(1),
            digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
            method: z.string().min(1),
            by: z.string().min(1),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export function handoffFrame(
  content: string,
  source: {
    stream_id: string;
    seq: string;
    digest: string;
    issuer: string;
  },
): ContextFrame {
  return {
    id: `arp-handoff:${source.stream_id}:${source.seq}`,
    kind: "episode",
    title: "Operator handoff summary",
    content,
    score: 1,
    token_cost: budgetTokens(content),
    content_digest: digestBytes(content),
    citation_label: `Source run, frame ${source.seq}`,
    provenance: [
      {
        type: "derivation",
        uri: `urn:arp:source:${encodeURIComponent(source.stream_id)}:${source.seq}`,
        digest: source.digest,
        method: "operator-handoff-summary",
        by: source.issuer,
      },
    ],
  };
}

// SDK 0.1 types kind as a closed union. CGP requires unknown kinds to survive.
export type HandoffFrame = Omit<ContextFrame, "kind"> & { kind: string };

export function readHandoffFrames(bytes: Buffer): HandoffFrame[] {
  const frames = z
    .array(fullFrameSchema)
    .min(1)
    .max(1)
    .parse(JSON.parse(bytes.toString("utf8")));
  for (const frame of frames) {
    if (
      (frame.valid_from && Date.parse(frame.valid_from) > Date.now()) ||
      (frame.valid_to && Date.parse(frame.valid_to) <= Date.now())
    ) {
      throw new Error("ARP context frame is outside its CGP validity window.");
    }
    if (
      frame.content_digest !== digestBytes(frame.content) ||
      frame.token_cost !== budgetTokens(frame.content)
    ) {
      throw new Error(
        "ARP context frame has an invalid CGP content digest or token cost.",
      );
    }
  }
  return frames;
}
