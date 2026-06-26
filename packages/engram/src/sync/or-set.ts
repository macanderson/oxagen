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

export interface ORSetEntry<T> {
  value: T;
  tags: Set<string>;
}

export class ORSet<T> {
  private entries = new Map<string, ORSetEntry<T>>();
  private tombstones = new Set<string>();

  /**
   * Add an element with a unique tag.
   * The tag must be globally unique (e.g., nodeId + lamport clock).
   */
  add(value: T, tag: string): void {
    const id = this.computeId(value);
    const entry = this.entries.get(id) ?? { value, tags: new Set() };
    entry.tags.add(tag);
    this.entries.set(id, entry);
  }

  /**
   * Remove an element. Only tombstones tags we've currently observed.
   * Concurrent adds (with tags we haven't seen) survive this removal.
   */
  remove(value: T): void {
    const id = this.computeId(value);
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
    const id = this.computeId(value);
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
   */
  merge(other: ORSet<T>): ORSet<T> {
    const result = new ORSet<T>();

    // Union all entries
    for (const [id, entry] of this.entries) {
      for (const tag of entry.tags) {
        result.entries.set(id, {
          value: entry.value,
          tags: new Set([...(result.entries.get(id)?.tags ?? []), tag]),
        });
      }
    }
    for (const [id, entry] of other.entries) {
      const existing = result.entries.get(id);
      if (existing) {
        for (const tag of entry.tags) existing.tags.add(tag);
      } else {
        result.entries.set(id, { value: entry.value, tags: new Set(entry.tags) });
      }
    }

    // Union all tombstones
    for (const t of this.tombstones) result.tombstones.add(t);
    for (const t of other.tombstones) result.tombstones.add(t);

    return result;
  }

  /** Number of present elements. */
  get size(): number {
    return this.values().length;
  }

  /** Export state for serialization. */
  toJSON(): { entries: Array<{ value: T; tags: string[] }>; tombstones: string[] } {
    return {
      entries: [...this.entries.values()].map((e) => ({ value: e.value, tags: [...e.tags] })),
      tombstones: [...this.tombstones],
    };
  }

  private computeId(value: T): string {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
}
