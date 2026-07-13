"use client";

/**
 * sandbox-repo-picker.tsx — multi-repo selection for the "warm a sandbox" flow.
 *
 * Lets a user add up to `MAX_SANDBOX_REPOS` GitHub repos, each with its own
 * branch, to be cloned into `/work/<repo>` while the sandbox provisions.
 * Options come from the workspace's connected GitHub repos (same source as the
 * chat composer's code-mode picker); a row can't select a repo another row in
 * this picker already has, so the same repo can't be queued twice. When the
 * workspace has no usable GitHub connection, renders a short hint pointing at
 * the integrations page instead of an unusable picker.
 *
 * State + row logic are pure exported functions so they're testable without
 * rendering (no jsdom / Base UI portals needed for the row-management rules).
 */

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RepoSelector, type RepoOption } from "@/components/chat/repo-selector";

/** One row of the picker — a repo selection plus its editable branch text. */
export interface SandboxRepoSelection {
  /** Stable React key; unrelated to the repo itself. */
  id: string;
  /** The chosen `RepoOption.key`, or null while the row is still empty. */
  repoKey: string | null;
  /** Editable branch text, prefilled from the repo's default branch on selection. */
  branch: string;
}

/** Hard cap on repos per warm — matches the `start_sandbox` action's zod limit. */
export const MAX_SANDBOX_REPOS = 8;

/** A fresh, empty row for the "Add repo" button. */
export function createSandboxRepoRow(): SandboxRepoSelection {
  return { id: crypto.randomUUID(), repoKey: null, branch: "" };
}

/** Apply a repo pick to a row, prefilling its branch from the repo's default. */
export function selectRepoForRow(
  row: SandboxRepoSelection,
  repo: RepoOption,
): SandboxRepoSelection {
  return { ...row, repoKey: repo.key, branch: repo.defaultBranch ?? "" };
}

/** True while there's room for another row. */
export function canAddSandboxRepoRow(
  rows: readonly SandboxRepoSelection[],
): boolean {
  return rows.length < MAX_SANDBOX_REPOS;
}

/** The repo options a given row may pick from — excludes repos other rows already hold. */
export function optionsForRow(
  row: SandboxRepoSelection,
  rows: readonly SandboxRepoSelection[],
  repositories: readonly RepoOption[],
): RepoOption[] {
  const usedElsewhere = new Set(
    rows.filter((r) => r.id !== row.id && r.repoKey).map((r) => r.repoKey),
  );
  return repositories.filter((r) => !usedElsewhere.has(r.key));
}

/** Resolve the picker's rows into the `{owner, repo, branch?}[]` the start action expects. */
export function toSandboxRepoInputs(
  rows: readonly SandboxRepoSelection[],
  repositories: readonly RepoOption[],
): Array<{ owner: string; repo: string; branch?: string }> {
  const out: Array<{ owner: string; repo: string; branch?: string }> = [];
  for (const row of rows) {
    if (!row.repoKey) continue;
    const repo = repositories.find((r) => r.key === row.repoKey);
    if (!repo) continue;
    const branch = row.branch.trim();
    out.push(
      branch
        ? { owner: repo.owner, repo: repo.name, branch }
        : { owner: repo.owner, repo: repo.name },
    );
  }
  return out.slice(0, MAX_SANDBOX_REPOS);
}

export interface SandboxRepoPickerProps {
  /** The workspace's usable GitHub repos. Empty ⇒ render the connect-a-repo hint. */
  repositories: RepoOption[];
  rows: SandboxRepoSelection[];
  onRowsChange: (next: SandboxRepoSelection[]) => void;
  /** Route to the integrations page, shown in the no-repos hint. */
  connectIntegrationsHref: string;
  disabled?: boolean;
}

export function SandboxRepoPicker({
  repositories,
  rows,
  onRowsChange,
  connectIntegrationsHref,
  disabled = false,
}: SandboxRepoPickerProps) {
  if (repositories.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        Connect a GitHub integration to clone repos into new sandboxes —{" "}
        <a
          href={connectIntegrationsHref}
          className="font-medium text-foreground underline underline-offset-2"
        >
          set one up
        </a>
        .
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Clone repos into{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
            /work/&lt;repo&gt;
          </code>{" "}
          as the sandbox provisions — optional, add as many as you need.
        </p>
      ) : null}

      {rows.map((row) => {
        const options = optionsForRow(row, rows, repositories);
        const selectedRepo =
          repositories.find((r) => r.key === row.repoKey) ?? null;
        return (
          <div
            key={row.id}
            className="flex flex-col gap-2 sm:flex-row sm:items-center"
          >
            <RepoSelector
              repositories={options}
              selectedKey={row.repoKey}
              onSelectRepo={(repo) =>
                onRowsChange(
                  rows.map((r) =>
                    r.id === row.id ? selectRepoForRow(r, repo) : r,
                  ),
                )
              }
              ariaLabel="Repository to clone"
              placeholder="Select repo"
              className="sm:w-56"
              isLoading={disabled}
            />
            <Input
              value={row.branch}
              onChange={(e) =>
                onRowsChange(
                  rows.map((r) =>
                    r.id === row.id ? { ...r, branch: e.target.value } : r,
                  ),
                )
              }
              placeholder={selectedRepo?.defaultBranch ?? "branch"}
              aria-label="Branch"
              maxLength={200}
              disabled={disabled}
              className="sm:w-40"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Remove repo"
              onClick={() => onRowsChange(rows.filter((r) => r.id !== row.id))}
              disabled={disabled}
            >
              <X className="size-3.5" aria-hidden />
            </Button>
          </div>
        );
      })}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit gap-1.5"
        onClick={() => onRowsChange([...rows, createSandboxRepoRow()])}
        disabled={disabled || !canAddSandboxRepoRow(rows)}
      >
        <Plus className="size-3.5" aria-hidden />
        Add repo
      </Button>
    </div>
  );
}

export default SandboxRepoPicker;
