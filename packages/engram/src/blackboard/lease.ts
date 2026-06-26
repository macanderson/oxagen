/**
 * Lease Manager — exclusive resource access for operations that
 * genuinely cannot be concurrent (git worktree, db migration, deploy slot).
 *
 * Leases are time-bounded and auto-expire to prevent deadlocks.
 */

export interface Lease {
  id: string;
  agentId: string;
  /** Resource identifier (e.g., "git:worktree:main", "deploy:production"). */
  resource: string;
  grantedAt: number;
  expiresAt: number;
  renewable: boolean;
}

export interface LeaseResult {
  granted: boolean;
  lease?: Lease;
  heldBy?: string; // agentId of current holder
  expiresAt?: number; // when the blocking lease expires
}

export class LeaseManager {
  private leases = new Map<string, Lease>();
  private idCounter = 0;

  /**
   * Attempt to acquire an exclusive lease on a resource.
   * Returns null if the resource is already held by another agent.
   */
  acquire(agentId: string, resource: string, ttlMs = 60_000, renewable = true): LeaseResult {
    this.expireStale();

    const existing = this.leases.get(resource);
    if (existing && existing.agentId !== agentId) {
      return {
        granted: false,
        heldBy: existing.agentId,
        expiresAt: existing.expiresAt,
      };
    }

    // Grant or extend existing lease
    const lease: Lease = {
      id: `lease-${++this.idCounter}`,
      agentId,
      resource,
      grantedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      renewable,
    };

    this.leases.set(resource, lease);
    return { granted: true, lease };
  }

  /**
   * Release a lease explicitly (before TTL expiry).
   */
  release(resource: string, agentId: string): boolean {
    const lease = this.leases.get(resource);
    if (!lease || lease.agentId !== agentId) return false;
    this.leases.delete(resource);
    return true;
  }

  /**
   * Renew a lease (extend its TTL). Only works if the lease is renewable
   * and held by the requesting agent.
   */
  renew(resource: string, agentId: string, additionalMs = 60_000): boolean {
    const lease = this.leases.get(resource);
    if (!lease || lease.agentId !== agentId || !lease.renewable) return false;
    lease.expiresAt = Date.now() + additionalMs;
    return true;
  }

  /**
   * Check if a resource is currently leased.
   */
  isLeased(resource: string): boolean {
    this.expireStale();
    return this.leases.has(resource);
  }

  /**
   * Get all active leases for an agent.
   */
  getAgentLeases(agentId: string): Lease[] {
    this.expireStale();
    return [...this.leases.values()].filter((l) => l.agentId === agentId);
  }

  /**
   * Get all active leases.
   */
  getAllActive(): Lease[] {
    this.expireStale();
    return [...this.leases.values()];
  }

  private expireStale(): void {
    const now = Date.now();
    for (const [resource, lease] of this.leases) {
      if (lease.expiresAt < now) {
        this.leases.delete(resource);
      }
    }
  }

  /** Clear all leases (for tests). */
  clear(): void {
    this.leases.clear();
  }
}
