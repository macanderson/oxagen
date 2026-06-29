"use client";

import * as React from "react";
import { GitPullRequest, Copy, ExternalLink, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface PRDetails {
  number: number;
  title: string;
  url: string;
  branch: string;
  state: "open" | "closed" | "merged";
  author: string;
  createdAt: string;
  description?: string;
  files?: {
    name: string;
    changes: number;
    additions: number;
    deletions: number;
  }[];
}

interface PRInspectionCardProps {
  pr: PRDetails;
  onViewDiff?: (filePath: string) => void;
}

const stateColors: Record<PRDetails["state"], string> = {
  open: "bg-green-100 text-green-800",
  closed: "bg-red-100 text-red-800",
  merged: "bg-purple-100 text-purple-800",
};

export function PRInspectionCard({ pr, onViewDiff }: PRInspectionCardProps) {
  const [expanded, setExpanded] = React.useState(false);
  const totalChanges = pr.files?.reduce((sum, f) => sum + f.changes, 0) ?? 0;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <GitPullRequest className="size-5 shrink-0 text-muted-foreground" />
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate font-semibold hover:underline"
              title={pr.title}
            >
              #{pr.number}: {pr.title}
            </a>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant={pr.state === "open" ? "default" : "secondary"} className={stateColors[pr.state]}>
              {pr.state}
            </Badge>
            <span className="text-xs text-muted-foreground">by {pr.author}</span>
            <span className="text-xs text-muted-foreground">{pr.branch}</span>
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => {
              navigator.clipboard.writeText(pr.url);
            }}
            title="Copy URL"
          >
            <Copy className="size-4" />
          </Button>
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center rounded-md hover:bg-accent h-9 w-9"
            title="Open in GitHub"
          >
            <ExternalLink className="size-4" />
          </a>
        </div>
      </div>

      {pr.description && (
        <p className="mt-3 text-sm text-muted-foreground line-clamp-2">{pr.description}</p>
      )}

      {pr.files && pr.files.length > 0 && (
        <div className="mt-4">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex w-full items-center justify-between rounded hover:bg-muted/50 px-2 py-1"
          >
            <span className="text-sm font-medium">
              {pr.files.length} files changed ({totalChanges} changes)
            </span>
            {expanded ? (
              <ChevronUp className="size-4" />
            ) : (
              <ChevronDown className="size-4" />
            )}
          </button>

          {expanded && (
            <div className="mt-2 space-y-1 border-t border-border pt-2">
              {pr.files.map((file) => (
                <div
                  key={file.name}
                  className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-muted/50 text-sm"
                >
                  <span className="truncate font-mono text-xs" title={file.name}>
                    {file.name}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-green-600">+{file.additions}</span>
                    <span className="text-xs text-red-600">-{file.deletions}</span>
                    {onViewDiff && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onViewDiff(file.name)}
                        className="text-xs"
                      >
                        View
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
