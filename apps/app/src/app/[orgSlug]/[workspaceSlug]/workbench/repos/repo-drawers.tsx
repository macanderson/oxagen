"use client";

/**
 * repo-drawers.tsx — the four Repos-list header/row Drawer forms:
 *   - CreateRepoDrawer   → repo.create   (creates a NEW GitHub repo; does not
 *                          itself add a workspace connection — connect it via
 *                          the GitHub App install afterward to see it in this
 *                          table)
 *   - ForkRepoDrawer     → repo.fork
 *   - ConfigureRepoDrawer→ repo.configure (opened from a row's gear icon)
 *   - EditFileLauncherDrawer → agent.repo.edit — dispatches the coding agent
 *     against an owner/repo with a natural-language instruction and opens a
 *     PR. Note: the contract has no separate "file path" field (unlike the
 *     original surfacing spec's wording) — the instruction itself should name
 *     the file(s) to touch; the agent resolves the rest.
 */

import * as React from "react";
import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { Drawer } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { parseRepoSlug } from "@/lib/workbench/repo-slug";
import type { RepoRow } from "@/lib/workbench/repos";
import {
  createRepoAction,
  forkRepoAction,
  configureRepoAction,
  editRepoFileAction,
} from "./actions";

interface Scope {
  orgSlug: string;
  workspaceSlug: string;
}

// ── Create repo ──────────────────────────────────────────────────────────────

export function CreateRepoDrawer({
  open,
  onOpenChange,
  orgSlug,
  workspaceSlug,
}: Scope & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { add: toast } = useToast();
  const [name, setName] = React.useState("");
  const [org, setOrg] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [isPrivate, setIsPrivate] = React.useState(true);
  const [autoInit, setAutoInit] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{
    fullName: string;
    htmlUrl: string;
    defaultBranch: string;
  } | null>(null);

  function reset() {
    setName("");
    setOrg("");
    setDescription("");
    setIsPrivate(true);
    setAutoInit(true);
    setError(null);
    setResult(null);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    const res = await createRepoAction({
      orgSlug,
      workspaceSlug,
      name,
      org: org.trim() || undefined,
      description: description.trim() || undefined,
      private: isPrivate,
      autoInit,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setResult(res.result);
    toast({ title: "Repository created", description: res.result.fullName });
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
      title="Create repo"
      description="Creates a new GitHub repository. Connect it through the GitHub App to see it in this list."
    >
      {result ? (
        <div className="flex flex-col gap-3" data-testid="create-repo-success">
          <p className="text-sm text-foreground">
            Created <span className="font-medium">{result.fullName}</span>{" "}
            (default branch{" "}
            <code className="rounded bg-muted px-1">
              {result.defaultBranch}
            </code>
            ).
          </p>
          <a
            href={result.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline"
          >
            View on GitHub ↗
          </a>
          <Button type="button" variant="outline" size="sm" onClick={reset}>
            Create another
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-repo-name">Name</Label>
            <Input
              id="create-repo-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-new-repo"
              required
              data-testid="create-repo-name-input"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-repo-org">Organization (optional)</Label>
            <Input
              id="create-repo-org"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="Leave blank for your personal account"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-repo-description">Description</Label>
            <Textarea
              id="create-repo-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              checked={isPrivate}
              onCheckedChange={(c) => setIsPrivate(c === true)}
            />
            Private repository
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              checked={autoInit}
              onCheckedChange={(c) => setAutoInit(c === true)}
            />
            Initialize with a README
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button
            type="submit"
            disabled={submitting || !name.trim()}
            data-testid="create-repo-submit"
          >
            {submitting ? "Creating…" : "Create repo"}
          </Button>
        </form>
      )}
    </Drawer>
  );
}

// ── Fork repo ────────────────────────────────────────────────────────────────

export function ForkRepoDrawer({
  open,
  onOpenChange,
  orgSlug,
  workspaceSlug,
}: Scope & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { add: toast } = useToast();
  const [owner, setOwner] = React.useState("");
  const [repo, setRepo] = React.useState("");
  const [intoOrg, setIntoOrg] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{
    fullName: string;
    htmlUrl: string;
    defaultBranch: string;
  } | null>(null);

  function reset() {
    setOwner("");
    setRepo("");
    setIntoOrg("");
    setError(null);
    setResult(null);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    const res = await forkRepoAction({
      orgSlug,
      workspaceSlug,
      owner,
      repo,
      intoOrg: intoOrg.trim() || undefined,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setResult(res.result);
    toast({ title: "Repository forked", description: res.result.fullName });
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
      title="Fork repo"
      description="Fork a GitHub repository into your account or organization."
    >
      {result ? (
        <div className="flex flex-col gap-3" data-testid="fork-repo-success">
          <p className="text-sm text-foreground">
            Forked to <span className="font-medium">{result.fullName}</span>.
          </p>
          <a
            href={result.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline"
          >
            View on GitHub ↗
          </a>
          <Button type="button" variant="outline" size="sm" onClick={reset}>
            Fork another
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fork-owner">Owner</Label>
            <Input
              id="fork-owner"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="octocat"
              required
              data-testid="fork-repo-owner-input"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fork-repo">Repository</Label>
            <Input
              id="fork-repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="hello-world"
              required
              data-testid="fork-repo-name-input"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fork-into-org">
              Fork into organization (optional)
            </Label>
            <Input
              id="fork-into-org"
              value={intoOrg}
              onChange={(e) => setIntoOrg(e.target.value)}
              placeholder="Leave blank for your personal account"
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button
            type="submit"
            disabled={submitting || !owner.trim() || !repo.trim()}
            data-testid="fork-repo-submit"
          >
            {submitting ? "Forking…" : "Fork repo"}
          </Button>
        </form>
      )}
    </Drawer>
  );
}

// ── Configure repo ───────────────────────────────────────────────────────────

export function ConfigureRepoDrawer({
  target,
  onOpenChange,
  orgSlug,
  workspaceSlug,
  onSaved,
}: Scope & {
  target: RepoRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { add: toast } = useToast();
  const [recordTypes, setRecordTypes] = React.useState("");
  const [syncCadence, setSyncCadence] = React.useState<
    "manual" | "polling" | "webhook"
  >("polling");
  const [pollingIntervalSeconds, setPollingIntervalSeconds] =
    React.useState("300");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!target) return;
    setRecordTypes("");
    setSyncCadence("polling");
    setPollingIntervalSeconds("300");
    setError(null);
  }, [target]);

  async function submit() {
    if (!target) return;
    setSubmitting(true);
    setError(null);
    const parsedTypes = recordTypes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const res = await configureRepoAction({
      orgSlug,
      workspaceSlug,
      repoId: target.publicId,
      recordTypes: parsedTypes.length > 0 ? parsedTypes : undefined,
      syncCadence,
      pollingIntervalSeconds:
        syncCadence === "polling" && pollingIntervalSeconds
          ? Number(pollingIntervalSeconds)
          : undefined,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    toast({ title: "Repo configured", description: target.displayName });
    onSaved();
    onOpenChange(false);
  }

  return (
    <Drawer
      open={target !== null}
      onOpenChange={onOpenChange}
      title={target ? `Configure ${target.displayName}` : "Configure repo"}
      description="Ingestion filters and sync cadence for this repo connection."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="configure-record-types">
            Record types (comma-separated)
          </Label>
          <Input
            id="configure-record-types"
            value={recordTypes}
            onChange={(e) => setRecordTypes(e.target.value)}
            placeholder="pull_request, issue, commit"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="configure-sync-cadence">Sync cadence</Label>
          <Select
            value={syncCadence}
            onValueChange={(v) => v && setSyncCadence(v as typeof syncCadence)}
          >
            <SelectTrigger
              id="configure-sync-cadence"
              aria-label="Sync cadence"
            >
              <SelectValue placeholder="Sync cadence" />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="manual">Manual</SelectItem>
              <SelectItem value="polling">Polling</SelectItem>
              <SelectItem value="webhook">Webhook</SelectItem>
            </SelectPopup>
          </Select>
        </div>
        {syncCadence === "polling" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="configure-polling-interval">
              Polling interval (seconds)
            </Label>
            <Input
              id="configure-polling-interval"
              type="number"
              min={1}
              value={pollingIntervalSeconds}
              onChange={(e) => setPollingIntervalSeconds(e.target.value)}
            />
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button
          type="submit"
          disabled={submitting}
          data-testid="configure-repo-submit"
        >
          {submitting ? "Saving…" : "Save configuration"}
        </Button>
      </form>
    </Drawer>
  );
}

// ── Edit file & open PR launcher ────────────────────────────────────────────

const MANUAL_REPO = "__manual__";

export function EditFileLauncherDrawer({
  open,
  onOpenChange,
  orgSlug,
  workspaceSlug,
  repos,
}: Scope & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repos: RepoRow[];
}) {
  const { add: toast } = useToast();
  const resolvable = React.useMemo(
    () =>
      repos
        .map((r) => ({ row: r, slug: parseRepoSlug(r.displayName) }))
        .filter(
          (r): r is { row: RepoRow; slug: { owner: string; repo: string } } =>
            r.slug !== null,
        ),
    [repos],
  );
  const [choice, setChoice] = React.useState<string>(
    resolvable[0]
      ? `${resolvable[0].slug.owner}/${resolvable[0].slug.repo}`
      : MANUAL_REPO,
  );
  const [manualOwner, setManualOwner] = React.useState("");
  const [manualRepo, setManualRepo] = React.useState("");
  const [instruction, setInstruction] = React.useState("");
  const [baseBranch, setBaseBranch] = React.useState("");
  const [branchName, setBranchName] = React.useState("");
  const [model, setModel] = React.useState("");
  const [maxSteps, setMaxSteps] = React.useState("12");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{
    prNumber: number;
    prUrl: string;
    branch: string;
    changedFiles: string[];
    summary: string;
  } | null>(null);

  function reset() {
    setInstruction("");
    setBaseBranch("");
    setBranchName("");
    setModel("");
    setMaxSteps("12");
    setError(null);
    setResult(null);
  }

  const { owner, repo } =
    choice === MANUAL_REPO
      ? { owner: manualOwner.trim(), repo: manualRepo.trim() }
      : (() => {
          const [o = "", r = ""] = choice.split("/");
          return { owner: o, repo: r };
        })();

  async function submit() {
    setSubmitting(true);
    setError(null);
    const res = await editRepoFileAction({
      orgSlug,
      workspaceSlug,
      owner,
      repo,
      instruction,
      baseBranch: baseBranch.trim() || undefined,
      branchName: branchName.trim() || undefined,
      model: model.trim() || undefined,
      maxSteps: Number(maxSteps) || 12,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setResult(res.result);
    toast({
      title: "Pull request opened",
      description: `#${res.result.prNumber}`,
    });
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
      title="Edit file & open PR"
      description="Dispatch the coding agent against a repo with a natural-language instruction. Name the file(s) to touch in the instruction — the agent resolves the rest."
    >
      {result ? (
        <div
          className="flex flex-col gap-3"
          data-testid="edit-file-launcher-success"
        >
          <p className="text-sm text-foreground">
            Opened <span className="font-medium">#{result.prNumber}</span> on
            branch{" "}
            <code className="rounded bg-muted px-1">{result.branch}</code>.
          </p>
          <a
            href={result.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline"
          >
            View pull request ↗
          </a>
          <p className="text-sm text-muted-foreground">{result.summary}</p>
          {result.changedFiles.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-muted-foreground">
                Changed files
              </p>
              <ul className="flex flex-col gap-0.5">
                {result.changedFiles.map((f) => (
                  <li key={f} className="font-mono text-xs text-foreground">
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Button type="button" variant="outline" size="sm" onClick={reset}>
            Start another
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-file-repo">Repo</Label>
            <Select value={choice} onValueChange={(v) => v && setChoice(v)}>
              <SelectTrigger
                id="edit-file-repo"
                aria-label="Repo"
                data-testid="edit-file-repo-select"
              >
                <SelectValue placeholder="Choose a repo" />
              </SelectTrigger>
              <SelectPopup>
                {resolvable.map(({ slug }) => (
                  <SelectItem
                    key={`${slug.owner}/${slug.repo}`}
                    value={`${slug.owner}/${slug.repo}`}
                  >
                    <Github aria-hidden="true" /> {slug.owner}/{slug.repo}
                  </SelectItem>
                ))}
                <SelectItem value={MANUAL_REPO}>
                  Other (enter owner/repo)
                </SelectItem>
              </SelectPopup>
            </Select>
          </div>
          {choice === MANUAL_REPO && (
            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="edit-file-owner">Owner</Label>
                <Input
                  id="edit-file-owner"
                  value={manualOwner}
                  onChange={(e) => setManualOwner(e.target.value)}
                  placeholder="octocat"
                  required
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="edit-file-repo-name">Repository</Label>
                <Input
                  id="edit-file-repo-name"
                  value={manualRepo}
                  onChange={(e) => setManualRepo(e.target.value)}
                  placeholder="hello-world"
                  required
                />
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-file-instruction">Instruction</Label>
            <Textarea
              id="edit-file-instruction"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Update src/index.ts to add error handling for..."
              required
              minLength={10}
              data-testid="edit-file-instruction-input"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="edit-file-base-branch">
                Base branch (optional)
              </Label>
              <Input
                id="edit-file-base-branch"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                placeholder="main"
              />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="edit-file-branch-name">
                Branch name (optional)
              </Label>
              <Input
                id="edit-file-branch-name"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder="auto-generated"
              />
            </div>
          </div>
          <div className="flex gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="edit-file-model">Model (optional)</Label>
              <Input
                id="edit-file-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Workspace default"
              />
            </div>
            <div className="flex w-32 flex-col gap-1.5">
              <Label htmlFor="edit-file-max-steps">Max steps</Label>
              <Input
                id="edit-file-max-steps"
                type="number"
                min={1}
                max={40}
                value={maxSteps}
                onChange={(e) => setMaxSteps(e.target.value)}
              />
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button
            type="submit"
            disabled={
              submitting || !owner || !repo || instruction.trim().length < 10
            }
            data-testid="edit-file-launcher-submit"
          >
            {submitting ? "Running agent…" : "Run agent & open PR"}
          </Button>
        </form>
      )}
    </Drawer>
  );
}
