"use client";

import * as React from "react";
import { Pin } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RepoSelector, type RepoOption } from "./repo-selector";
import { EnvironmentSelector, type EnvironmentOption } from "./environment-selector";
import {
  ComposerPrStatusChip,
  type ComposerPrStatus,
} from "./composer-pr-status-chip";

/**
 * composer-context-controls — the single, compact footer row of chat context
 * controls that lives directly UNDER the prompt textarea (inside the composer).
 *
 * It replaces the two previous heavy, duplicated bars (`ChatAgentToolbar` for
 * code mode and `ChatContextBar` for pinning): both showed full-width repo +
 * environment selectors ABOVE the composer. This unifies them into one small
 * row that both code mode and pin mode share:
 *
 *   [ org/repo ]                              [ PR #123 ● ] [ environment ] [pin]
 *   └── bottom-left ──┘                       └───────── bottom-right ─────────┘
 *
 * The controls are small, borderless ghost triggers (not boxed selects), so the
 * composer footer stays visually quiet. Pinning is only offered in pin mode
 * (code mode requires both selections anyway, so a pin there is redundant).
 */

interface ComposerContextControlsProps {
  repositories: RepoOption[];
  environments: EnvironmentOption[];
  selectedRepoKey: string | null;
  selectedEnvId: string | null;
  onSelectRepo: (repo: RepoOption) => void;
  onSelectEnv: (envId: string) => void;
  /**
   * "code": both selections required (send-gated upstream), no pin affordance.
   * "pin": lightweight pin-to-conversation mode, pin toggle shown.
   */
  mode: "code" | "pin";
  /** Pin state — only meaningful in "pin" mode. */
  isPinned?: boolean;
  onTogglePin?: () => void;
  /** The open PR for this conversation, if the coding agent has opened one. */
  pr?: ComposerPrStatus | null;
  /** Slugs for the PR chip's scoped CI fetch. */
  orgSlug?: string;
  workspaceSlug?: string;
  disabled?: boolean;
}

/** Compact, borderless trigger classes shared by both selectors. */
const COMPACT_TRIGGER =
  "h-7 w-auto max-w-[11rem] gap-1 border-0 bg-transparent px-1.5 text-xs shadow-none hover:bg-muted focus:ring-0 data-[popup-open]:border-0";

export function ComposerContextControls({
  repositories,
  environments,
  selectedRepoKey,
  selectedEnvId,
  onSelectRepo,
  onSelectEnv,
  mode,
  isPinned = false,
  onTogglePin,
  pr,
  orgSlug,
  workspaceSlug,
  disabled = false,
}: ComposerContextControlsProps) {
  const hasRepos = repositories.length > 0;
  const hasEnvironments = environments.length > 0;
  const selectedRepo = repositories.find((r) => r.key === selectedRepoKey) ?? null;
  const selectedEnv = environments.find((e) => e.id === selectedEnvId) ?? null;
  const canPin = Boolean(selectedRepo || selectedEnv);
  const showPin = mode === "pin" && onTogglePin !== undefined;

  const pinLabel = isPinned
    ? "Unpin from chat"
    : "Pin to chat — stick this repository and environment to future turns";

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
      data-testid="composer-context-controls"
      data-mode={mode}
    >
      {/* Bottom-left: org / repository */}
      {hasRepos ? (
        <RepoSelector
          repositories={repositories}
          selectedKey={selectedRepoKey}
          onSelectRepo={onSelectRepo}
          isLoading={disabled}
          className={COMPACT_TRIGGER}
          ariaLabel={mode === "pin" ? "Pinned repository" : "Select repository"}
          placeholder="Repository"
        />
      ) : null}

      {/* Bottom-right cluster: PR chip · environment · pin */}
      <div className="ml-auto flex min-w-0 items-center gap-2">
        {pr && orgSlug && workspaceSlug ? (
          <ComposerPrStatusChip
            pr={pr}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
        ) : null}

        {hasEnvironments ? (
          <EnvironmentSelector
            environments={environments}
            selectedEnvId={selectedEnvId}
            onSelectEnv={onSelectEnv}
            isLoading={disabled}
            className={COMPACT_TRIGGER}
            ariaLabel={mode === "pin" ? "Pinned environment" : "Select environment"}
            placeholder="Environment"
          />
        ) : null}

        {showPin ? (
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
                    "size-7",
                    isPinned &&
                      "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
                  )}
                  data-testid="pin-to-chat"
                />
              }
            >
              <Pin className={cn("size-3.5", isPinned && "fill-current")} aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup>{pinLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
