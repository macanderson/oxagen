"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RepoSelector, type Repository } from "./repo-selector";
import { EnvironmentSelector, type Environment } from "./environment-selector";
import { cn } from "@/lib/utils";

interface ChatAgentToolbarProps {
  repositories: Repository[];
  environments: Environment[];
  selectedRepoId: string | null;
  selectedEnvId: string | null;
  onSelectRepo: (repoId: string) => void;
  onSelectEnv: (envId: string) => void;
  onAddRepo?: () => void;
  isLoading?: boolean;
  isCollapsed?: boolean;
  onToggleCollapse?: (collapsed: boolean) => void;
}

export function ChatAgentToolbar({
  repositories,
  environments,
  selectedRepoId,
  selectedEnvId,
  onSelectRepo,
  onSelectEnv,
  onAddRepo,
  isLoading = false,
  isCollapsed = false,
  onToggleCollapse,
}: ChatAgentToolbarProps) {
  const selectedRepo = repositories.find((r) => r.id === selectedRepoId);
  const selectedEnv = environments.find((e) => e.id === selectedEnvId);

  return (
    <div className="border-b border-border bg-card/50 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className={cn("flex flex-1 gap-4", isCollapsed && "hidden")}>
          {repositories.length > 0 && (
            <RepoSelector
              repositories={repositories}
              selectedRepoId={selectedRepoId}
              onSelectRepo={onSelectRepo}
              onAddRepo={onAddRepo}
              isLoading={isLoading}
            />
          )}
          {environments.length > 0 && (
            <EnvironmentSelector
              environments={environments}
              selectedEnvId={selectedEnvId}
              onSelectEnv={onSelectEnv}
              isLoading={isLoading}
            />
          )}
        </div>

        {(selectedRepo || selectedEnv) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {selectedRepo && <span className="truncate">{selectedRepo.owner}/{selectedRepo.name}</span>}
            {selectedRepo && selectedEnv && <span>•</span>}
            {selectedEnv && <span>{selectedEnv.name}</span>}
          </div>
        )}

        {onToggleCollapse && (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onToggleCollapse(!isCollapsed)}
            title={isCollapsed ? "Show toolbar" : "Hide toolbar"}
          >
            <ChevronDown className={cn("size-4 transition-transform", isCollapsed && "rotate-180")} />
          </Button>
        )}
      </div>
    </div>
  );
}
