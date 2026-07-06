"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RepoSelector, type RepoOption } from "./repo-selector";
import { EnvironmentSelector, type EnvironmentOption } from "./environment-selector";
import { cn } from "@/lib/utils";

interface ChatAgentToolbarProps {
  repositories: RepoOption[];
  environments: EnvironmentOption[];
  selectedRepoKey: string | null;
  selectedEnvId: string | null;
  onSelectRepo: (repo: RepoOption) => void;
  onSelectEnv: (envId: string) => void;
  isLoading?: boolean;
  isCollapsed?: boolean;
  onToggleCollapse?: (collapsed: boolean) => void;
}

/**
 * Code-mode agent toolbar: repo + environment pickers shown above the
 * composer while code mode is active. Both selections are required before a
 * coding turn can be sent — see the composer's send-gate.
 */
export function ChatAgentToolbar({
  repositories,
  environments,
  selectedRepoKey,
  selectedEnvId,
  onSelectRepo,
  onSelectEnv,
  isLoading = false,
  isCollapsed = false,
  onToggleCollapse,
}: ChatAgentToolbarProps) {
  const selectedRepo = repositories.find((r) => r.key === selectedRepoKey);
  const selectedEnv = environments.find((e) => e.id === selectedEnvId);

  return (
    <div className="rounded-t-2xl border border-b-0 border-border bg-card/50 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className={cn("flex flex-1 flex-wrap gap-4", isCollapsed && "hidden")}>
          <RepoSelector
            repositories={repositories}
            selectedKey={selectedRepoKey}
            onSelectRepo={onSelectRepo}
            isLoading={isLoading}
          />
          <EnvironmentSelector
            environments={environments}
            selectedEnvId={selectedEnvId}
            onSelectEnv={onSelectEnv}
            isLoading={isLoading}
          />
        </div>

        {(selectedRepo || selectedEnv) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {selectedRepo && (
              <span className="truncate">
                {selectedRepo.owner}/{selectedRepo.name}
              </span>
            )}
            {selectedRepo && selectedEnv && <span>•</span>}
            {selectedEnv && <span>{selectedEnv.name}</span>}
          </div>
        )}

        {onToggleCollapse && (
          <Button
            type="button"
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
