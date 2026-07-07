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
   * Accessible label for the trigger. Defaults to "Select repository". The
   * pin context bar overrides it ("Pinned repository") so the always-visible
   * pin selector doesn't collide with the code-mode toolbar's selector in
   * tests / a11y trees when both can appear.
   */
  ariaLabel?: string;
  placeholder?: string;
}

export function RepoSelector({
  repositories,
  selectedKey,
  onSelectRepo,
  isLoading = false,
  ariaLabel = "Select repository",
  placeholder = "Select repository",
}: RepoSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <GitBranch className="size-4 text-muted-foreground" />
      <Select
        value={selectedKey ?? ""}
        onValueChange={(value) => {
          const repo = repositories.find((r) => r.key === value);
          if (repo) onSelectRepo(repo);
        }}
        disabled={isLoading || repositories.length === 0}
      >
        <SelectTrigger className="w-48" aria-label={ariaLabel}>
          <SelectValue placeholder={placeholder} />
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
