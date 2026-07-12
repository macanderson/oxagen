"use client";

/**
 * files-tab.tsx — commit a file (repo.file.put) and see the resulting diff.
 *
 * There is no file-browse capability today (repo.file.put is write-only;
 * there's no repo.file.get/list contract) — this tab covers the JTBD the
 * spec actually lists ("commit a file directly and see the resulting diff"),
 * not a directory browser. See the builder's final report for the gap.
 */

import * as React from "react";
import { FileCode2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import type { RepoFilePutOutput } from "@oxagen/oxagen/contracts/repo.file.put";
import { putRepoFileAction } from "../actions";

export interface FilesTabProps {
  scope: { orgSlug: string; workspaceSlug: string };
  slug: { owner: string; repo: string } | null;
  canManage: boolean;
}

export function FilesTab({ scope, slug, canManage }: FilesTabProps) {
  const [path, setPath] = React.useState("");
  const [content, setContent] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [branch, setBranch] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<RepoFilePutOutput | null>(null);

  if (!slug) {
    return (
      <EmptyState
        icon={<FileCode2 />}
        title="Repo setup incomplete"
        description="Finish connecting a repo before committing files."
        variant="dashed"
      />
    );
  }

  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">
        Only workspace owners and admins can commit files.
      </p>
    );
  }

  async function submit() {
    if (!slug) return;
    setSubmitting(true);
    setError(null);
    const res = await putRepoFileAction({
      ...scope,
      owner: slug.owner,
      repo: slug.repo,
      path,
      content,
      message,
      branch: branch.trim() || undefined,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setResult(res.result);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="repo-files-tab">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="file-path">Path</Label>
            <Input
              id="file-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="src/index.ts"
              required
              data-testid="file-path-input"
            />
          </div>
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="file-branch">Branch (required — non-default)</Label>
            <Input
              id="file-branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="feature/my-change"
              required
              data-testid="file-branch-input"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="file-content">Content</Label>
          <Textarea
            id="file-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="min-h-48 font-mono text-xs"
            data-testid="file-content-input"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="file-message">Commit message</Label>
          <Input
            id="file-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            required
            data-testid="file-message-input"
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button
          type="submit"
          disabled={
            submitting || !path.trim() || !message.trim() || !branch.trim()
          }
          className="self-start"
          data-testid="file-commit-submit"
        >
          {submitting ? "Committing…" : "Commit file"}
        </Button>
      </form>

      {result && (
        <div
          className="flex flex-col gap-2 rounded-md border border-border/60 p-3"
          data-testid="file-commit-result"
        >
          <a
            href={result.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline"
          >
            View file on GitHub ↗
          </a>
          <p className="font-mono text-xs text-muted-foreground">
            {result.commitSha.slice(0, 12)}
          </p>
          {result.diffs?.map((d) => (
            <pre
              key={d.path}
              className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1.5 text-[11px] text-muted-foreground"
            >
              {d.patch}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}
