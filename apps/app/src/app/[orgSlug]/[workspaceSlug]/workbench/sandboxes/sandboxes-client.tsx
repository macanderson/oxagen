"use client";

/**
 * sandboxes-client.tsx — the Workbench → Sandboxes list + "warm a sandbox" panel.
 *
 * Lists a workspace's durable sandbox sessions and lets a manager warm a new one
 * from a template. Every warm is NAMED (a required human label) so sessions are
 * identifiable in the list instead of showing a bare sbx_ id. Picking a template
 * shows a rich card of exactly what's baked into its image — languages +
 * versions, package managers, pre-installed system packages — so the choice is
 * informed. Warming calls startSandboxAction and, on success, routes to the
 * sandbox detail page where the terminal + file browser live. When durable
 * sandboxes aren't configured (SANDBOX_ENABLED off / no Modal driver) the panel
 * still lists any recorded sessions but explains why warming a new one will fail.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Boxes, Play, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardPanel,
} from "@/components/ui/card";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { workspace } from "@/lib/routes";
import type { SandboxSummary, SandboxStatus } from "@/lib/workbench/sandboxes";
import {
  WARM_UP_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  templateById,
} from "@/components/sandbox/warm-up-templates";
import { SandboxTemplateCard } from "@/components/sandbox/sandbox-template-card";
import { startSandboxAction } from "./actions";

const STATUS_TONE: Record<SandboxStatus, "success" | "warning" | "secondary"> = {
  running: "success",
  idle: "warning",
  stopped: "secondary",
  gone: "secondary",
};

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86_400)}d ago`;
}

export interface SandboxesClientProps {
  orgSlug: string;
  workspaceSlug: string;
  initialSandboxes: SandboxSummary[];
  canManage: boolean;
  unavailable: boolean;
}

export function SandboxesClient({
  orgSlug,
  workspaceSlug,
  initialSandboxes,
  canManage,
  unavailable,
}: SandboxesClientProps) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE_ID);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const template = useMemo(() => templateById(templateId), [templateId]);
  const sandboxes = initialSandboxes;
  const trimmedName = name.trim();
  const canWarm = canManage && !pending && trimmedName.length > 0;

  const onWarm = () => {
    setError(null);
    startTransition(async () => {
      const res = await startSandboxAction({
        orgSlug,
        workspaceSlug,
        name: trimmedName,
        templateId,
      });
      if (res.ok) {
        router.push(
          workspace.workbench.sandbox({ orgSlug, workspaceSlug }, res.sandbox.sessionId),
        );
        return;
      }
      setError(res.error);
    });
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Warm-up panel */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Play className="h-4 w-4" aria-hidden />
            Warm a sandbox
          </CardTitle>
          <CardDescription>
            Name it, pick a template, and provision a durable sandbox — its
            one-time setup runs at create time so an agent wakes up to a ready
            workspace.
          </CardDescription>
        </CardHeader>
        <CardPanel className="flex flex-col gap-4">
          {unavailable ? (
            <div
              role="status"
              className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground"
            >
              Durable sandboxes aren&apos;t configured for this environment
              (SANDBOX_ENABLED + a Modal driver are required). You can still
              browse recorded sessions below; warming a new one will fail until
              it&apos;s enabled.
            </div>
          ) : null}

          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="sandbox-name">Name</Label>
              <Input
                id="sandbox-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. acme-api refactor"
                maxLength={80}
                autoComplete="off"
                aria-describedby="sandbox-name-hint"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sandbox-template">Template</Label>
              <Select
                value={templateId}
                onValueChange={(v) => setTemplateId(v ?? DEFAULT_TEMPLATE_ID)}
              >
                <SelectTrigger
                  id="sandbox-template"
                  className="w-full sm:w-64"
                  aria-label="Sandbox template"
                >
                  <SelectValue placeholder="Choose a template" />
                </SelectTrigger>
                <SelectPopup>
                  {WARM_UP_TEMPLATES.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <Button
              type="button"
              onClick={onWarm}
              disabled={!canWarm}
              className="shrink-0"
            >
              {pending ? "Warming…" : "Warm sandbox"}
            </Button>
          </div>
          <p id="sandbox-name-hint" className="text-xs text-muted-foreground">
            A name so you can tell your sandboxes apart later — it doesn&apos;t
            need to be unique.
          </p>

          <SandboxTemplateCard template={template} />

          {!canManage ? (
            <p className="text-xs text-muted-foreground">
              Only workspace owners and admins can warm sandboxes.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          ) : null}
        </CardPanel>
      </Card>

      {/* Session list */}
      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Sessions</h2>
        {sandboxes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center">
            <Boxes className="h-6 w-6 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">
              No sandbox sessions yet. Warm one above to give an agent a ready
              workspace.
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {sandboxes.map((s) => (
              <li key={s.sessionId}>
                <Link
                  href={workspace.workbench.sandbox(
                    { orgSlug, workspaceSlug },
                    s.sessionId,
                  )}
                  className="flex flex-col gap-2 rounded-xl border border-border bg-background p-4 transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Terminal className="h-4 w-4 text-muted-foreground" aria-hidden />
                      {s.label ?? s.sessionId}
                    </span>
                    <Badge variant={STATUS_TONE[s.status]}>{s.status}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {s.label ? (
                      <span className="font-mono">{s.sessionId}</span>
                    ) : null}
                    <span>image: {s.image}</span>
                    <span>driver: {s.driver}</span>
                    <span>last used: {relativeTime(s.lastUsedAt)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default SandboxesClient;
