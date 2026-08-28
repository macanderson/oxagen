"use client";

/**
 * branches-tab.tsx — create a branch (repo.branch.create).
 *
 * There is no repo.branch.list capability today, so this tab cannot show a
 * true branch list without fabricating data. Instead it shows the branches
 * created THIS session, labeled as such, plus the create form.
 */

import * as React from "react";
import { GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
import { createBranchAction } from "../actions";

export interface BranchesTabProps {
  scope: { orgSlug: string; workspaceSlug: string };
  slug: { owner: string; repo: string } | null;
  canManage: boolean;
  onBranchCreated: (branch: string) => void;
}

interface CreatedBranch {
  branch: string;
  ref: string;
  sha: string;
}

export function BranchesTab({
  scope,
  slug,
  canManage,
  onBranchCreated,
}: BranchesTabProps) {
  const [branch, setBranch] = React.useState("");
  const [fromBranch, setFromBranch] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<CreatedBranch[]>([]);

  async function submit() {
    if (!slug) return;
    setSubmitting(true);
    setError(null);
    const res = await createBranchAction({
      ...scope,
      owner: slug.owner,
      repo: slug.repo,
      branch,
      fromBranch: fromBranch.trim() || undefined,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setCreated((p) => [
      { branch, ref: res.result.ref, sha: res.result.sha },
      ...p,
    ]);
    onBranchCreated(branch);
    setBranch("");
    setFromBranch("");
  }

  if (!slug) {
    return (
      <EmptyState
        icon={<GitBranch />}
        title="Repo setup incomplete"
        description="Finish connecting a repo before creating branches."
        variant="dashed"
      />
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="repo-branches-tab">
      {canManage && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="branch-name">New branch</Label>
            <Input
              id="branch-name"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="feature/my-change"
              required
              data-testid="branch-name-input"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="branch-from">From branch (optional)</Label>
            <Input
              id="branch-from"
              value={fromBranch}
              onChange={(e) => setFromBranch(e.target.value)}
              placeholder="Repo default branch"
            />
          </div>
          <Button
            type="submit"
            disabled={submitting || !branch.trim()}
            data-testid="branch-create-submit"
          >
            {submitting ? "Creating…" : "Create branch"}
          </Button>
        </form>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}

      {created.length === 0 ? (
        <EmptyState
          icon={<GitBranch />}
          title="No branches created this session"
          description="Oxagen doesn't list existing branches yet (no repo.branch.list capability) — branches you create here show up below."
          variant="muted"
        />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="created-branches-list">
          {created.map((b) => (
            <li
              key={b.ref}
              className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm"
            >
              <span className="font-medium text-foreground">{b.branch}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {b.sha.slice(0, 8)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
