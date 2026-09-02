/**
 * OR-Set (Observed-Remove Set) — a CRDT that supports both add and remove
 * operations with conflict resolution.
 *
 * Each add is tagged with a unique identifier. Remove tombstones only the
 * tags that the removing node has observed. Concurrent adds from other nodes
 * survive removal (add wins over concurrent remove).
 *
 * Used for: semantic facts (can be retracted) and procedural rules.
 */
import { canonicalStringify } from "../canonical-json";

export interface ORSetEntry<T> {
  value: T;
  tags: Set<string>;
}

/**
 * Element identity. Two values that are structurally equal must map to the same
 * id so that concurrent adds of "the same fact" on different replicas collapse
 * onto one entry. Uses canonical (sorted-key) JSON so key ordering never splits
 * an element in two.
 */
function elementId<T>(value: T): string {
  return typeof value === "string" ? value : canonicalStringify(value);
}

export class ORSet<T> {
  private entries = new Map<string, ORSetEntry<T>>();
  private tombstones = new Set<string>();

  /**
   * Add an element with a unique tag.
   * The tag must be globally unique (e.g., nodeId + lamport clock).
   */
  add(value: T, tag: string): void {
    const id = elementId(value);
    const entry = this.entries.get(id) ?? { value, tags: new Set<string>() };
    entry.tags.add(tag);
    this.entries.set(id, entry);
  }

  /**
   * Remove an element. Only tombstones tags we've currently observed.
   * Concurrent adds (with tags we haven't seen) survive this removal.
   */
  remove(value: T): void {
    const id = elementId(value);
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const tag of entry.tags) {
      this.tombstones.add(tag);
    }
  }

  /**
   * Check if an element is present (has at least one non-tombstoned tag).
   */
  has(value: T): boolean {
    const id = elementId(value);
    const entry = this.entries.get(id);
    if (!entry) return false;
    for (const tag of entry.tags) {
      if (!this.tombstones.has(tag)) return true;
    }
    return false;
  }

  /**
   * Get all present elements (those with at least one live tag).
   */
  values(): T[] {
    const result: T[] = [];
    for (const entry of this.entries.values()) {
      const hasLiveTag = [...entry.tags].some((t) => !this.tombstones.has(t));
      if (hasLiveTag) result.push(entry.value);
    }
    return result;
  }

  /**
   * Merge two OR-Sets. Result contains the union of all entries and tombstones.
   * An element is present if it has any tag not in the merged tombstone set.
   *
   * O(total tags): each source tag is touched once.
   */
  merge(other: ORSet<T>): ORSet<T> {
    const result = new ORSet<T>();
    const absorb = (src: Map<string, ORSetEntry<T>>): void => {
      for (const [id, entry] of src) {
        const existing = result.entries.get(id);
        if (existing) {
          for (const tag of entry.tags) existing.tags.add(tag);
        } else {
          result.entries.set(id, {
            value: entry.value,
            tags: new Set(entry.tags),
          });
        }
      }
    };
    absorb(this.entries);
    absorb(other.entries);

    for (const t of this.tombstones) result.tombstones.add(t);
    for (const t of other.tombstones) result.tombstones.add(t);

    return result;
  }

  /**
   * Garbage-collect fully-observed tombstones and the dead tags/entries they
   * cover, bounding otherwise-unbounded growth from repeated add/remove churn.
   *
   * CAUSAL-SAFETY CONTRACT — read before calling:
   *   `observedEverywhere(tag)` MUST return true only for a tag that every peer
   *   this replica will ever merge with has already observed (both its add and
   *   its removal), e.g. a tag below the version-vector floor across all peers.
   *   Dropping a tombstone a peer has not yet seen would resurrect the removed
   *   element on the next merge. When unsure, return false — GC is purely a
   *   memory optimization and is never required for correctness. This method is
   *   never called automatically; the caller owns the causal-safety judgement.
   */
  compact(observedEverywhere: (tag: string) => boolean): void {
    for (const [id, entry] of [...this.entries]) {
      for (const tag of [...entry.tags]) {
        if (this.tombstones.has(tag) && observedEverywhere(tag)) {
          // Removal has fully propagated: physically drop the dead tag and its
          // tombstone together so neither costs memory nor is ever re-seen.
          entry.tags.delete(tag);
          this.tombstones.delete(tag);
        }
      }
      if (entry.tags.size === 0) this.entries.delete(id);
    }
    // Drop any remaining safely-observed tombstones whose add never materialized
    // here (their add is also below the floor, so it can never arrive later).
    for (const tag of [...this.tombstones]) {
      if (observedEverywhere(tag)) this.tombstones.delete(tag);
    }
  }

  /** Number of present elements. */
  get size(): number {
    return this.values().length;
  }

  /** Export state for serialization. */
  toJSON(): {
    entries: Array<{ value: T; tags: string[] }>;
    tombstones: string[];
  } {
    return {
      entries: [...this.entries.values()].map((e) => ({
        value: e.value,
        tags: [...e.tags],
      })),
      tombstones: [...this.tombstones],
    };
  }

  /**
   * Rebuild an OR-Set from `toJSON` output. Round-trips exactly:
   * `fromJSON(s.toJSON()).toJSON()` deep-equals `s.toJSON()`.
   */
  static fromJSON<T>(data: {
    entries: Array<{ value: T; tags: string[] }>;
    tombstones: string[];
  }): ORSet<T> {
    const set = new ORSet<T>();
    for (const e of data.entries) {
      set.entries.set(elementId(e.value), {
        value: e.value,
        tags: new Set(e.tags),
      });
    }
    for (const t of data.tombstones) set.tombstones.add(t);
    return set;
  }
}
