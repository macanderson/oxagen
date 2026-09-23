import { describe, expect, it } from "vitest";
import {
  type SteeringManifest,
  steeringManifestFrameSchema,
  steeringManifestSchema,
} from "../wire";
import { steeringManifestFrame } from "./steering-manifest";

const manifest: SteeringManifest = {
  schema: "oxagen.steering.manifest/1",
  delivers: ["must", "should"],
  budget_tokens: 4096,
  spent_tokens: 120,
  included: 1,
  cut: 1,
  text_digest: `sha256:${"a".repeat(64)}`,
  items: [
    {
      id: "no-force-push",
      kind: "record",
      force: "must",
      recorded_at: "2026-09-20T00:00:00.000Z",
      tokens: 40,
      outcome: "included",
    },
    {
      id: "prefer-small-prs",
      kind: "record",
      force: "may",
      recorded_at: "2026-09-19T00:00:00.000Z",
      tokens: 30,
      outcome: "cut",
      reason: "tier",
    },
  ],
};

describe("steeringManifestFrame", () => {
  it("seals the bundle's manifest as it was signed, naming the bundle", () => {
    const frame = steeringManifestFrame(
      manifest,
      { version: 7, etag: "etag-7" },
      [],
    );
    expect(frame).toEqual({
      ...manifest,
      bundle_version: 7,
      bundle_etag: "etag-7",
    });
    expect(steeringManifestFrameSchema.parse(frame)).toEqual(frame);
    expect(steeringManifestSchema.safeParse(frame).success).toBe(false);
  });

  it("appends every delivered steer as an included must item and counts it", () => {
    const frame = steeringManifestFrame(
      manifest,
      { version: 7, etag: "etag-7" },
      [
        {
          id: "cmd_1",
          text: "Stop after the migration lands.",
          command: "steer",
          issuedAt: "2026-09-21T10:00:00.000Z",
        },
        {
          id: "cmd_2",
          text: "Résumé the plan first.",
          command: "message",
          issuedAt: "2026-09-21T10:01:00.000Z",
        },
      ],
    );
    expect(frame.included).toBe(3);
    expect(frame.cut).toBe(1);
    expect(frame.items.slice(2)).toEqual([
      {
        id: "cmd_1",
        kind: "steer",
        force: "must",
        recorded_at: "2026-09-21T10:00:00.000Z",
        tokens: 8,
        outcome: "included",
      },
      {
        id: "cmd_2",
        kind: "steer",
        force: "must",
        recorded_at: "2026-09-21T10:01:00.000Z",
        // ceil(utf8 bytes / 4): the accented characters cost their bytes.
        tokens: 6,
        outcome: "included",
      },
    ]);
    expect(steeringManifestFrameSchema.parse(frame)).toEqual(frame);
  });
});
