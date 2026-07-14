"use client";

/**
 * locks-tab.tsx — agent.file_lock.list + .release.
 *
 * Fully backed by real capabilities (unlike Branches/Pull Requests/Files,
 * which have real-data gaps documented in their own files). Cites the
 * holding agent by naturalKey/agentId (already a descriptive string, e.g.
 * "coding-agent" or a user id) rather than a bare lock UUID — the lockId
 * itself is only ever shown as a small copyable chip, never the primary label.
 */

import * as React from "react";
import { Lock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableEmpty,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { CopyableId } from "@/components/knowledge/graph-explorer/copyable-id";
import type { RepoLock } from "@/lib/workbench/repos";
import { listFileLocksAction, releaseFileLockAction } from "../actions";

export interface LocksTabProps {
  scope: { orgSlug: string; workspaceSlug: string };
  slug: { owner: string; repo: string } | null;
  canManage: boolean;
}

function formatEpochMs(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function LocksTab({ scope, slug, canManage }: LocksTabProps) {
  const { add: toast } = useToast();
  const [locks, setLocks] = React.useState<RepoLock[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [releasing, setReleasing] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listFileLocksAction(
      slug ? { ...scope, owner: slug.owner, repo: slug.repo } : scope,
    );
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setLocks(res.locks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.orgSlug, scope.workspaceSlug, slug?.owner, slug?.repo]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function release(lockId: string) {
    setReleasing(lockId);
    const res = await releaseFileLockAction({ ...scope, lockId });
    setReleasing(null);
    if (!res.ok) {
      toast({
        title: "Couldn't release lock",
        description: res.error,
        type: "error",
      });
      return;
    }
    toast({ title: res.released ? "Lock released" : "Lock was already gone" });
    void load();
  }

  return (
    <div className="flex flex-col gap-3" data-testid="repo-locks-tab">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Live file locks — TTL-bounded leases agents hold while editing, so
          concurrent edits don&apos;t collide.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          data-testid="locks-refresh-btn"
        >
          <RefreshCw
            className={loading ? "animate-spin" : undefined}
            aria-hidden="true"
          />
          Refresh
        </Button>
      </div>

      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : locks.length === 0 && !loading ? (
        <EmptyState
          icon={<Lock />}
          title="No active locks"
          description="No agent currently holds a file lock in this workspace."
          variant="dashed"
        />
      ) : (
        <Table data-testid="locks-table">
          <TableHeader>
            <TableRow>
              <TableHead>Path</TableHead>
              <TableHead>Held by</TableHead>
              <TableHead>Acquired</TableHead>
              <TableHead>Expires</TableHead>
              {canManage && (
                <TableHead className="text-right">Action</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {locks.length === 0 && (
              <TableEmpty colSpan={canManage ? 5 : 4}>
                No active locks.
              </TableEmpty>
            )}
            {locks.map((lock) => (
              <TableRow
                key={lock.lockId}
                data-testid={`lock-row-${lock.lockId}`}
              >
                <TableCell className="font-mono text-xs">
                  {lock.naturalKey}
                </TableCell>
                <TableCell>
                  <span className="text-sm text-foreground">
                    {lock.agentId}
                  </span>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatEpochMs(lock.acquiredAt)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatEpochMs(lock.expiresAt)}
                </TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <CopyableId value={lock.lockId} label="lock" max={10} />
                      <Button
                        type="button"
                        variant="destructive-outline"
                        size="sm"
                        disabled={releasing === lock.lockId}
                        onClick={() => void release(lock.lockId)}
                        data-testid={`lock-release-${lock.lockId}`}
                      >
                        {releasing === lock.lockId ? "Releasing…" : "Release"}
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
