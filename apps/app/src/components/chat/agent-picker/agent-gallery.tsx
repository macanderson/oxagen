"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { AgentPickerPanel } from "./agent-picker-panel";
import { useComposerSelectionState } from "./chat-selection-context";
import type { RepoOption } from "../repo-selector";
import type { EnvironmentOption } from "../environment-selector";
import type { AgentOption } from "./agent-picker-types";

/**
 * agent-gallery.tsx — the new-conversation empty-state hero. Presents the same
 * `AgentPickerPanel` as a welcoming "Choose your assistant" gallery so a fresh
 * chat starts by picking who to talk to. Reads the shared selection store (the
 * same one the composer chip drives) and applies picks to it; the parent
 * collapses the gallery away once the first message sends.
 */
export interface AgentGalleryProps {
  agents: AgentOption[];
  repos: RepoOption[];
  environments: EnvironmentOption[];
  defaultRepoKey: string | null;
  defaultEnvId: string | null;
  defaultAgentId: string | null;
  onSetDefaultAgent?: (agentId: string | null) => void;
  /** Scopes the v2 "Recent" row's persisted recency (see AgentPickerPanel). */
  workspaceSlug?: string;
  className?: string;
}

export function AgentGallery({
  agents,
  repos,
  environments,
  defaultRepoKey,
  defaultEnvId,
  defaultAgentId,
  onSetDefaultAgent,
  workspaceSlug,
  className,
}: AgentGalleryProps) {
  const {
    selectedAgentId,
    selectedRepoKey,
    selectedEnvId,
    applyAgentSelection,
  } = useComposerSelectionState();

  // A workspace with no agents keeps the plain empty state — nothing to pick.
  if (agents.length === 0) return null;

  return (
    <div
      className={cn(
        "mx-auto w-full max-w-md rounded-xl border border-border bg-card/50 text-left shadow-sm",
        className,
      )}
      data-testid="agent-gallery"
    >
      <div className="border-b border-border px-4 pb-2 pt-3">
        <h2 className="text-sm font-semibold text-foreground">
          Choose your assistant
        </h2>
        <p className="text-xs text-muted-foreground">
          Pick an agent to chat with — or start with the default assistant.
        </p>
      </div>
      <AgentPickerPanel
        variant="gallery"
        agents={agents}
        repos={repos}
        environments={environments}
        defaultRepoKey={defaultRepoKey}
        defaultEnvId={defaultEnvId}
        defaultAgentId={defaultAgentId}
        onSetDefaultAgent={onSetDefaultAgent}
        selectedAgentId={selectedAgentId}
        selectedRepoKey={selectedRepoKey}
        selectedEnvId={selectedEnvId}
        onApply={applyAgentSelection}
        workspaceSlug={workspaceSlug}
      />
    </div>
  );
}
