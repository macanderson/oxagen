"use client";

import * as React from "react";
import { Pin } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RepoSelector, type RepoOption } from "./repo-selector";
import { EnvironmentSelector, type EnvironmentOption } from "./environment-selector";

interface ChatContextBarProps {
  repositories: RepoOption[];
  environments: EnvironmentOption[];
  selectedRepoKey: string | null;
  selectedEnvId: string | null;
  onSelectRepo: (repo: RepoOption) => void;
  onSelectEnv: (envId: string) => void;
  /** Whether the current selection is pinned to the conversation. */
  isPinned: boolean;
  /** Toggle the pin. Only invoked when there is something to pin. */
  onTogglePin: () => void;
  disabled?: boolean;
}

/**
 * The persistent chat context bar shown directly above the composer. It lets
 * the user choose an org/repository and an environment and **pin** them to the
 * conversation, so the assistant knows which repo/environment the user means on
 * every future turn (see pinned-context.ts). Pinning is optional and the two
 * selections are independent.
 *
 * Distinct from the code-mode `ChatAgentToolbar` (which spins a sandbox and
 * requires BOTH selections): this bar is a lightweight, always-visible pin
 * affordance. The two share the composer's selection state and are shown
 * mutually exclusively (this bar when code mode is off, the toolbar when on),
 * and the selectors here use distinct aria-labels so they never collide.
 */
export function ChatContextBar({
  repositories,
  environments,
  selectedRepoKey,
  selectedEnvId,
  onSelectRepo,
  onSelectEnv,
  isPinned,
  onTogglePin,
  disabled = false,
}: ChatContextBarProps) {
  const hasRepos = repositories.length > 0;
  const hasEnvironments = environments.length > 0;
  const selectedRepo = repositories.find((r) => r.key === selectedRepoKey) ?? null;
  const selectedEnv = environments.find((e) => e.id === selectedEnvId) ?? null;
  const canPin = Boolean(selectedRepo || selectedEnv);

  const pinLabel = isPinned
    ? "Unpin from chat"
    : "Pin to chat — stick this repository and environment to future chat turns";

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-t-2xl border border-b-0 border-border bg-card/50 px-4 py-2 backdrop-blur-sm"
      data-testid="chat-context-bar"
    >
      {hasRepos ? (
        <RepoSelector
          repositories={repositories}
          selectedKey={selectedRepoKey}
          onSelectRepo={onSelectRepo}
          isLoading={disabled}
          ariaLabel="Pinned repository"
          placeholder="Pin a repository"
        />
      ) : null}

      {hasEnvironments ? (
        <EnvironmentSelector
          environments={environments}
          selectedEnvId={selectedEnvId}
          onSelectEnv={onSelectEnv}
          isLoading={disabled}
          ariaLabel="Pinned environment"
          placeholder="Pin an environment"
        />
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        {isPinned && (selectedRepo || selectedEnv) ? (
          <Badge
            variant="secondary"
            className="max-w-[16rem] gap-1 truncate text-[10px]"
            data-testid="pinned-summary"
          >
            <Pin className="size-2.5 fill-current" aria-hidden="true" />
            <span className="truncate">
              {selectedRepo ? `${selectedRepo.owner}/${selectedRepo.name}` : ""}
              {selectedRepo && selectedEnv ? " · " : ""}
              {selectedEnv ? selectedEnv.name : ""}
            </span>
          </Badge>
        ) : null}

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={pinLabel}
                aria-pressed={isPinned}
                disabled={disabled || (!canPin && !isPinned)}
                onClick={onTogglePin}
                className={cn(
                  "size-8",
                  isPinned && "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
                )}
                data-testid="pin-to-chat"
              />
            }
          >
            <Pin className={cn("size-4", isPinned && "fill-current")} aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>{pinLabel}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}
