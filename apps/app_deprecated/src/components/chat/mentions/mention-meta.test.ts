/**
 * mention-meta.test.ts — the mention-type parity lock.
 *
 * Three lists must never drift:
 *   1. MENTION_TYPES        — the type registry (@oxagen/ai/mentions).
 *   2. MENTION_TYPE_META    — per-type chip/menu presentation (this package).
 *   3. REFERENCE_TYPES      — the reference.search contract's enum.
 *
 * The dep direction forbids the contract importing MentionType, so the contract
 * documents this file as the enforcer of the two-list lockstep. Adding a mention
 * type without an icon/tint entry, or without extending the contract enum, fails
 * here — before it can ship a chip with no icon or a search that can't return it.
 */

import { describe, it, expect } from "vitest";
import { MENTION_TYPES } from "@oxagen/ai/mentions";
import { REFERENCE_TYPES } from "@oxagen/oxagen/contracts/reference.search";
import { MENTION_TYPE_META } from "./mention-meta";

describe("MENTION_TYPE_META", () => {
  it("provides presentation metadata for every MentionType", () => {
    const metaKeys = Object.keys(MENTION_TYPE_META).sort();
    const typeKeys = MENTION_TYPES.map((t) => t.type).sort();
    expect(metaKeys).toEqual(typeKeys);

    for (const meta of Object.values(MENTION_TYPE_META)) {
      // Every entry carries a real icon component and a non-empty tint class.
      expect(meta.icon).toBeTruthy();
      expect(typeof meta.iconClassName).toBe("string");
      expect(meta.iconClassName.length).toBeGreaterThan(0);
    }
  });

  it("stays in lockstep with the reference.search contract's REFERENCE_TYPES", () => {
    const mentionTypes = MENTION_TYPES.map((t) => t.type)
      .slice()
      .sort();
    const referenceTypes = [...REFERENCE_TYPES].sort();
    expect(referenceTypes).toEqual(mentionTypes);
  });
});
