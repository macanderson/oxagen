"use client";
/**
 * coding-agent-preferences-form.tsx — client component for the "Your
 * coding-agent preferences" section on Workspace → Settings → Agent Defaults
 * → Models sub-tab.
 *
 * Lets the calling user set (or clear) their OWN default repo, environment,
 * and agent for code sessions in this workspace — personal preferences, not
 * workspace governance (unlike the rest of the Models sub-tab, which is
 * Owner/Admin-gated). Saves via updateCodingAgentPreferencesAction
 * (`update_workspace_user_preferences`). Save/toast UX mirrors
 * ./models-form.tsx.
 */
import * as React from "react";
import { Save, GitBranch, Settings as EnvIcon, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type { RepoOption } from "@/components/chat/repo-selector";
import type { EnvironmentOption } from "@/components/chat/environment-selector";
import type { AgentOption } from "@/components/chat/agent-picker/agent-picker-types";
import {
  updateCodingAgentPreferencesAction,
  type UpdateCodingAgentPreferencesResult,
} from "./coding-agent-preferences-actions";

/** Sentinel Select value meaning "no personal default set". */
const UNSET = "__unset__";

export interface CodingAgentPreferencesFormProps {
  orgSlug: string;
  workspaceSlug: string;
  repos: RepoOption[];
  environments: EnvironmentOption[];
  agents: AgentOption[];
  initialRepoConnectionId: string | null;
  initialRepoSlug: string | null;
  initialEnvironmentId: string | null;
  initialAgentId: string | null;
}

/** Resolve the saved (connectionId, owner/repo slug) pair to a live RepoOption.key. */
function resolveRepoKey(
  repos: readonly RepoOption[],
  connectionId: string | null,
  slug: string | null,
): string {
  if (!connectionId || !slug) return UNSET;
  const match = repos.find(
    (r) => r.connectionId === connectionId && `${r.owner}/${r.name}` === slug,
  );
  return match?.key ?? UNSET;
}

/** Resolve the saved environment id if it still exists in the live list. */
function resolveEnvId(
  environments: readonly EnvironmentOption[],
  envId: string | null,
): string {
  if (!envId) return UNSET;
  return environments.some((e) => e.id === envId) ? envId : UNSET;
}

/** Resolve the saved agent id if it still exists in the live list. */
function resolveAgentId(
  agents: readonly AgentOption[],
  agentId: string | null,
): string {
  if (!agentId) return UNSET;
  return agents.some((a) => a.agentId === agentId) ? agentId : UNSET;
}

export function CodingAgentPreferencesForm({
  orgSlug,
  workspaceSlug,
  repos,
  environments,
  agents,
  initialRepoConnectionId,
  initialRepoSlug,
  initialEnvironmentId,
  initialAgentId,
}: CodingAgentPreferencesFormProps) {
  const [repoKey, setRepoKey] = React.useState(
    resolveRepoKey(repos, initialRepoConnectionId, initialRepoSlug),
  );
  const [envId, setEnvId] = React.useState(
    resolveEnvId(environments, initialEnvironmentId),
  );
  const [agentId, setAgentId] = React.useState(
    resolveAgentId(agents, initialAgentId),
  );
  const [isSaving, setIsSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSave(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsSaving(true);
    setError(null);
    try {
      const repo =
        repoKey === UNSET
          ? null
          : (repos.find((r) => r.key === repoKey) ?? null);
      const result: UpdateCodingAgentPreferencesResult =
        await updateCodingAgentPreferencesAction({
          orgSlug,
          workspaceSlug,
          defaultRepoConnectionId: repo?.connectionId ?? null,
          defaultRepoSlug: repo ? `${repo.owner}/${repo.name}` : null,
          defaultEnvironmentId: envId === UNSET ? null : envId,
          defaultAgentId: agentId === UNSET ? null : agentId,
        });
      if (result.ok) {
        setSavedAt(new Date());
      } else {
        setError(result.error);
      }
    } catch {
      // Never surface a raw thrown error in the form UI.
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="max-w-2xl border-t border-border/40 pt-6">
      <div className="mb-4 flex items-start gap-3">
        <Bot
          className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-semibold text-foreground">
            Your coding-agent preferences
          </p>
          <p className="text-xs text-muted-foreground">
            Personal defaults for repo, environment, and agent when you start a
            code session in this workspace. Only visible to you — not governed
            by workspace admins.
          </p>
        </div>
      </div>

      <form
        onSubmit={handleSave}
        aria-label="Your coding-agent preferences"
        className="flex flex-col gap-4"
        noValidate
      >
        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="coding-prefs-repo"
            className="text-xs text-muted-foreground"
          >
            Default repository
          </Label>
          <div className="flex items-center gap-2">
            <GitBranch
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <Select
              value={repoKey}
              onValueChange={(v) => setRepoKey(v ?? "")}
              disabled={isSaving}
            >
              <SelectTrigger
                id="coding-prefs-repo"
                size="sm"
                className="w-full max-md:h-11"
              >
                <SelectValue>
                  {(value: string | null) => {
                    if (!value || value === UNSET) return "No default";
                    const repo = repos.find((r) => r.key === value);
                    return repo ? `${repo.owner}/${repo.name}` : "No default";
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={UNSET}>No default</SelectItem>
                {repos.map((repo) => (
                  <SelectItem key={repo.key} value={repo.key}>
                    {repo.owner}/{repo.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="coding-prefs-env"
            className="text-xs text-muted-foreground"
          >
            Default environment
          </Label>
          <div className="flex items-center gap-2">
            <EnvIcon
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <Select
              value={envId}
              onValueChange={(v) => setEnvId(v ?? "")}
              disabled={isSaving}
            >
              <SelectTrigger
                id="coding-prefs-env"
                size="sm"
                className="w-full max-md:h-11"
              >
                <SelectValue>
                  {(value: string | null) => {
                    if (!value || value === UNSET) return "No default";
                    return (
                      environments.find((e) => e.id === value)?.name ??
                      "No default"
                    );
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={UNSET}>No default</SelectItem>
                {environments.map((env) => (
                  <SelectItem key={env.id} value={env.id}>
                    {env.name}
                    {env.isDefault ? " (workspace default)" : ""}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="coding-prefs-agent"
            className="text-xs text-muted-foreground"
          >
            Default agent
          </Label>
          <div className="flex items-center gap-2">
            <Bot
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <Select
              value={agentId}
              onValueChange={(v) => setAgentId(v ?? "")}
              disabled={isSaving}
            >
              <SelectTrigger
                id="coding-prefs-agent"
                size="sm"
                className="w-full max-md:h-11"
              >
                <SelectValue>
                  {(value: string | null) => {
                    if (!value || value === UNSET) return "No default";
                    return (
                      agents.find((a) => a.agentId === value)?.name ??
                      "No default"
                    );
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={UNSET}>No default</SelectItem>
                {agents.map((agent) => (
                  <SelectItem key={agent.agentId} value={agent.agentId}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>

        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="max-md:h-11"
            disabled={isSaving}
            startIcon={<Save className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            {isSaving ? "Saving…" : "Save preferences"}
          </Button>

          {savedAt !== null && (
            <p className="text-xs text-muted-foreground">
              Saved at{" "}
              {savedAt.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
