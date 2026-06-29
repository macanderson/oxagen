"use client";

import * as React from "react";
import { GitBranch, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface Repository {
  id: string;
  name: string;
  owner: string;
  url: string;
  branch: string;
}

interface RepoSelectorProps {
  repositories: Repository[];
  selectedRepoId: string | null;
  onSelectRepo: (repoId: string) => void;
  onAddRepo?: () => void;
  isLoading?: boolean;
}

export function RepoSelector({
  repositories,
  selectedRepoId,
  onSelectRepo,
  onAddRepo,
  isLoading = false,
}: RepoSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <GitBranch className="size-4 text-muted-foreground" />
      <Select
        value={selectedRepoId || ""}
        onValueChange={(value) => {
          if (value) onSelectRepo(value);
        }}
        disabled={isLoading}
      >
        <SelectTrigger className="w-48">
          <SelectValue placeholder="Select repository" />
        </SelectTrigger>
        <SelectContent>
          {repositories.map((repo) => (
            <SelectItem key={repo.id} value={repo.id}>
              {repo.owner}/{repo.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {onAddRepo && (
        <Button
          size="icon"
          variant="ghost"
          onClick={onAddRepo}
          disabled={isLoading}
          title="Add repository"
        >
          <Plus className="size-4" />
        </Button>
      )}
    </div>
  );
}
