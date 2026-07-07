"use client";

import * as React from "react";
import { GitBranch } from "lucide-react";
import {
  Select,
  SelectPopup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * A single repo a code-mode turn can target, derived from a `connectorId ===
 * "github"` `connection.list` row plus its `connection.get` deliveryConfig
 * (`{ owner, repo, defaultBranch }` or `{ selectedRepos: ["owner/repo", …] }`
 * — see `_shared/code-mode-data.ts`). `key` is unique per repo (not per
 * connection) because a single GitHub connection can sync multiple repos.
 */
export interface RepoOption {
  key: string;
  connectionId: string;
  owner: string;
  name: string;
  defaultBranch: string | null;
}

interface RepoSelectorProps {
  repositories: RepoOption[];
  selectedKey: string | null;
  onSelectRepo: (repo: RepoOption) => void;
  isLoading?: boolean;
  /**
   * Extra classes for the select trigger. Defaults to a mobile-first width
   * (`w-full` below `sm`, fixed `sm:w-48` on desktop) with a ≥44px touch
   * target on phones — pass a class to override from the parent layout.
   */
  className?: string;
}

export function RepoSelector({
  repositories,
  selectedKey,
  onSelectRepo,
  isLoading = false,
  className,
}: RepoSelectorProps) {
  return (
    <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
      <GitBranch className="size-4 shrink-0 text-muted-foreground" />
      <Select
        value={selectedKey ?? ""}
        onValueChange={(value) => {
          const repo = repositories.find((r) => r.key === value);
          if (repo) onSelectRepo(repo);
        }}
        disabled={isLoading || repositories.length === 0}
      >
        <SelectTrigger
          className={cn("min-h-11 w-full sm:min-h-0 sm:w-48", className)}
          aria-label="Select repository"
        >
          <SelectValue placeholder="Select repository" />
        </SelectTrigger>
        <SelectPopup>
          {repositories.map((repo) => (
            <SelectItem key={repo.key} value={repo.key}>
              {repo.owner}/{repo.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
