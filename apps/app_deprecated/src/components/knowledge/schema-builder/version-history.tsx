"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";
import { fetchVersions, diffVersions } from "./schema-service";
import type { TenantSlugs, VersionItem, VersionDiff } from "./types";

interface VersionHistoryProps {
  slugs: TenantSlugs;
  pinnedVersionId: string | null;
  onPin: (versionId: string) => Promise<void>;
}

function DiffView({ diff }: { diff: VersionDiff }) {
  type DiffSection = { title: string; items: string[]; sign: "+" | "-" | "~" };
  const sections: DiffSection[] = (
    [
      {
        title: "Schemas Added",
        items: diff.schemasAdded,
        sign: "+",
      },
      {
        title: "Schemas Removed",
        items: diff.schemasRemoved,
        sign: "-",
      },
      {
        title: "Labels Added",
        items: diff.labelsAdded.map((l) => `${l.schemaName} / ${l.labelName}`),
        sign: "+",
      },
      {
        title: "Labels Removed",
        items: diff.labelsRemoved.map(
          (l) => `${l.schemaName} / ${l.labelName}`,
        ),
        sign: "-",
      },
      {
        title: "Labels Changed",
        items: diff.labelsChanged.flatMap((l) =>
          l.changes.map((c) => `${l.schemaName} / ${l.labelName}: ${c}`),
        ),
        sign: "~",
      },
      {
        title: "Relationships Added",
        items: diff.relationshipTypesAdded.map(
          (r) => `${r.schemaName} / ${r.relationshipTypeName}`,
        ),
        sign: "+",
      },
      {
        title: "Relationships Removed",
        items: diff.relationshipTypesRemoved.map(
          (r) => `${r.schemaName} / ${r.relationshipTypeName}`,
        ),
        sign: "-",
      },
      {
        title: "Properties Added",
        items: diff.propertiesAdded.map((p) => `${p.ownerName}.${p.key}`),
        sign: "+",
      },
      {
        title: "Properties Removed",
        items: diff.propertiesRemoved.map((p) => `${p.ownerName}.${p.key}`),
        sign: "-",
      },
      {
        title: "Properties Changed",
        items: diff.propertiesChanged.flatMap((p) =>
          p.changes.map((c) => `${p.ownerName}.${p.key}: ${c}`),
        ),
        sign: "~",
      },
    ] as DiffSection[]
  ).filter((s) => s.items.length > 0);

  if (sections.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        No changes between versions.
      </p>
    );
  }

  return (
    <div className="space-y-3 max-h-96 overflow-y-auto">
      {sections.map((section) => (
        <div key={section.title}>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
            {section.title}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item, idx) => (
              <li
                key={idx}
                className={
                  section.sign === "+"
                    ? "text-sm text-emerald-700 dark:text-emerald-400 font-mono"
                    : section.sign === "-"
                      ? "text-sm text-red-700 dark:text-red-400 font-mono"
                      : "text-sm text-amber-700 dark:text-amber-400 font-mono"
                }
              >
                {section.sign} {item}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function VersionHistory({
  slugs,
  pinnedVersionId,
  onPin,
}: VersionHistoryProps) {
  const [versions, setVersions] = React.useState<VersionItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [diffDialog, setDiffDialog] = React.useState<{
    open: boolean;
    fromVersionId: string;
    toVersionId: string;
    toVersionNumber: number;
  } | null>(null);
  const [diff, setDiff] = React.useState<VersionDiff | null>(null);
  const [diffLoading, setDiffLoading] = React.useState(false);
  const [pinning, setPinning] = React.useState<string | null>(null);

  // pinnedVersionId is received but used by caller for display — kept here for
  // potential future highlight logic without triggering the exhaustive-deps lint.
  const _pinnedVersionId = pinnedVersionId;
  void _pinnedVersionId;

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchVersions(slugs)
      .then(({ versions: vs }) => {
        if (!cancelled) setVersions(vs);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slugs]);

  const handleOpenDiff = async (
    fromVersionId: string,
    toVersionId: string,
    toVersionNumber: number,
  ) => {
    setDiffDialog({ open: true, fromVersionId, toVersionId, toVersionNumber });
    setDiff(null);
    setDiffLoading(true);
    try {
      const d = await diffVersions(slugs, fromVersionId, toVersionId);
      setDiff(d);
    } finally {
      setDiffLoading(false);
    }
  };

  const handlePin = async (versionId: string) => {
    setPinning(versionId);
    try {
      await onPin(versionId);
    } finally {
      setPinning(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <>
      <div className="rounded-xl border border-border overflow-hidden">
        {versions.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No versions yet.
          </div>
        )}
        {versions.map((v, idx) => (
          <div
            key={v.versionId}
            className={`flex items-start justify-between px-4 py-3 ${idx > 0 ? "border-t border-border" : ""}`}
          >
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm font-medium">
                  v{v.versionNumber}
                </span>
                {v.label && (
                  <span className="text-sm text-muted-foreground">
                    — {v.label}
                  </span>
                )}
                <Badge
                  variant={v.status === "published" ? "default" : "secondary"}
                  className="text-xs"
                >
                  {v.status}
                </Badge>
                {v.isPinned && (
                  <Badge variant="outline" className="text-xs">
                    pinned
                  </Badge>
                )}
              </div>
              {v.changeSummary && (
                <p className="text-xs text-muted-foreground">
                  {v.changeSummary}
                </p>
              )}
              {v.publishedAt && (
                <p className="text-xs text-muted-foreground">
                  {formatDate(v.publishedAt)}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 ml-4 shrink-0">
              {v.status === "published" && !v.isPinned && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handlePin(v.versionId)}
                  disabled={pinning === v.versionId}
                >
                  {pinning === v.versionId ? "Pinning…" : "Pin"}
                </Button>
              )}
              {v.status === "published" && idx < versions.length - 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const prevVersion = versions[idx + 1];
                    if (prevVersion) {
                      void handleOpenDiff(
                        prevVersion.versionId,
                        v.versionId,
                        v.versionNumber,
                      );
                    }
                  }}
                >
                  Diff
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <Dialog
        open={diffDialog?.open ?? false}
        onOpenChange={(open) => {
          if (!open) setDiffDialog(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Changes in v{diffDialog?.toVersionNumber}</DialogTitle>
          </DialogHeader>
          {diffLoading && <Skeleton className="h-48 w-full" />}
          {!diffLoading && diff && <DiffView diff={diff} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
