"use client";

import * as React from "react";
import { Pin } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RepoSelector, type RepoOption } from "./repo-selector";
import {
  EnvironmentSelector,
  type EnvironmentOption,
} from "./environment-selector";
import {
  ComposerPrStatusChip,
  type ComposerPrStatus,
} from "./composer-pr-status-chip";

/**
 * composer-context-controls — the single, compact footer row of chat context
 * controls that lives directly UNDER the prompt textarea (inside the composer).
 *
 * One small row shared by both code mode and pin mode:
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
  /**
   * When true the conversation's coding target is LOCKED (claimed on its first
   * code turn): the repo + environment selectors render disabled, showing the
   * locked values, with a "start a new conversation to change" tooltip. The pin
   * affordance is irrelevant while locked (code mode never pins).
   */
  locked?: boolean;
}

/** Compact, borderless trigger classes shared by both selectors. */
const COMPACT_TRIGGER =
  "h-7 w-auto max-w-[11rem] gap-1 border-0 bg-transparent px-1.5 text-xs shadow-none hover:bg-muted focus:ring-0 data-[popup-open]:border-0";

/** Human hint shown on the locked selectors (native `title` tooltip). */
const LOCK_HINT =
  "Locked for this conversation — start a new conversation to change";

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
  locked = false,
}: ComposerContextControlsProps) {
  const hasRepos = repositories.length > 0;
  const hasEnvironments = environments.length > 0;
  const selectedRepo =
    repositories.find((r) => r.key === selectedRepoKey) ?? null;
  const selectedEnv = environments.find((e) => e.id === selectedEnvId) ?? null;
  const canPin = Boolean(selectedRepo || selectedEnv);
  // A locked conversation never shows the pin toggle (code mode never pins) and
  // renders both selectors disabled with a lock tooltip.
  const showPin = mode === "pin" && onTogglePin !== undefined && !locked;

  const pinLabel = isPinned
    ? "Unpin from chat"
    : "Pin to chat — stick this repository and environment to future turns";

  // Wrap a locked selector so hovering the disabled control still reveals the
  // "start a new conversation" hint (a native `title` fires on the wrapper even
  // when the inner Select is disabled).
  const wrapLocked = (node: React.ReactNode) =>
    locked ? (
      <span
        title={LOCK_HINT}
        data-testid="locked-context-control"
        className="inline-flex min-w-0"
      >
        {node}
      </span>
    ) : (
      node
    );

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
      data-testid="composer-context-controls"
      data-mode={mode}
      data-locked={locked ? "true" : undefined}
    >
      {/* Bottom-left: org / repository */}
      {hasRepos
        ? wrapLocked(
            <RepoSelector
              repositories={repositories}
              selectedKey={selectedRepoKey}
              onSelectRepo={onSelectRepo}
              isLoading={disabled || locked}
              className={COMPACT_TRIGGER}
              ariaLabel={
                mode === "pin" ? "Pinned repository" : "Select repository"
              }
              placeholder="Repository"
            />,
          )
        : null}

      {/* Bottom-right cluster: PR chip · environment · pin */}
      <div className="ml-auto flex min-w-0 items-center gap-2">
        {pr && orgSlug && workspaceSlug ? (
          <ComposerPrStatusChip
            pr={pr}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
        ) : null}

        {hasEnvironments
          ? wrapLocked(
              <EnvironmentSelector
                environments={environments}
                selectedEnvId={selectedEnvId}
                onSelectEnv={onSelectEnv}
                isLoading={disabled || locked}
                className={COMPACT_TRIGGER}
                ariaLabel={
                  mode === "pin" ? "Pinned environment" : "Select environment"
                }
                placeholder="Environment"
              />,
            )
          : null}

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
              <Pin
                className={cn("size-3.5", isPinned && "fill-current")}
                aria-hidden="true"
              />
            </TooltipTrigger>
            <TooltipPopup>{pinLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
