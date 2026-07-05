"use client";

import { useEffect, useState, type ReactElement } from "react";
import FileTreeCard, { type FileTreeEntry } from "./file-tree-card";

/**
 * workspace-context-panel — renders the active sandbox session's workspace
 * file tree by calling `agent.sandbox.files.list` client-side, mirroring
 * `workflow-progress.tsx`'s org+workspace-scoped fetch pattern. The scoped
 * `/api/v1/:org/:ws/agent/sandbox/files` Next path has no local route handler
 * — it falls through the next.config rewrite to the Hono API, which enforces
 * IAM itself, so this component makes no server action / invoke() call of its
 * own. Rendering of the tree itself is fully delegated to `FileTreeCard`.
 *
 * componentId: "workspace-context-panel"
 */

export interface WorkspaceContextPanelProps {
  sessionId: string;
  orgSlug?: string;
  workspaceSlug?: string;
  path?: string;
  depth?: number;
  title?: string;
}

interface SandboxFilesListResponse {
  entries: FileTreeEntry[];
}

export default function WorkspaceContextPanel({
  sessionId,
  orgSlug = "",
  workspaceSlug = "",
  path,
  depth,
  title,
}: WorkspaceContextPanelProps): ReactElement {
  const baseUrl =
    orgSlug !== "" && workspaceSlug !== "" && sessionId !== ""
      ? `/api/v1/${encodeURIComponent(orgSlug)}/${encodeURIComponent(workspaceSlug)}/agent/sandbox/files`
      : null;

  const [entries, setEntries] = useState<FileTreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!baseUrl) {
      // No org/workspace/session context to scope the request — surface it
      // rather than firing a slug-less request that would 404.
      setError("missing workspace context");
      return;
    }
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(baseUrl as string, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, path, depth }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as SandboxFilesListResponse;
        if (!cancelled) {
          setEntries(json.entries);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load workspace files");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- path/depth/sessionId are read once per baseUrl change, matching workflow-progress's single-fetch-per-scope pattern
  }, [baseUrl]);

  // ── Loading skeleton ──────────────────────────────────────────────────────

  if (!entries && !error) {
    return (
      <div
        className="my-2 animate-pulse space-y-2 rounded-xl border border-border bg-card p-4"
        data-component="workspace-context-panel"
      >
        <div className="h-4 w-32 rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-5/6 rounded bg-muted" />
        <div className="h-3 w-2/3 rounded bg-muted" />
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────

  if (error && !entries) {
    return (
      <div
        className="my-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3"
        data-component="workspace-context-panel"
      >
        <p className="text-sm text-destructive">Failed to load workspace files: {error}</p>
      </div>
    );
  }

  return (
    <div data-component="workspace-context-panel">
      <FileTreeCard entries={entries ?? []} title={title ?? "Workspace files"} />
    </div>
  );
}
