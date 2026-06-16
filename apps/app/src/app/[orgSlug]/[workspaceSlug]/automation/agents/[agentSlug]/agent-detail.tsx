"use client";
/**
 * agent-detail.tsx — agent definition view + lifecycle controls.
 *
 * Surfaces:
 *   - Header: name, lifecycle status, deployment status, edit link.
 *   - Deploy toggle: activate/deactivate via agent.deploy. Activation requires a
 *     published version — the typed backend error
 *     (agent_deploy_requires_published_version) is surfaced verbatim.
 *   - Publish: publishes the latest version via agent.definition.publish and
 *     shows the returned checksum.
 *   - Definition: instructions, graph access, tools.
 *   - Version: current version + published marker (+ checksum after a publish).
 *   - Triggers: add / edit / delete via agent.trigger.*.
 */
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Rocket, UploadCloud } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { workspace } from "@/lib/routes";
import {
  LIFECYCLE_BADGE,
  DEPLOYMENT_BADGE,
  TOOL_TYPE_LABEL,
} from "../agent-ui";
import type { AgentDefinitionGetOutput, AgentTriggerListOutput } from "../agent-actions";
import { deployAgentAction, publishAgentAction } from "../agent-actions";
import { TriggersPanel } from "./triggers-panel";

export interface AgentDetailProps {
  agent: AgentDefinitionGetOutput;
  triggers: AgentTriggerListOutput["triggers"];
  canEdit: boolean;
  orgSlug: string;
  workspaceSlug: string;
  agentSlug: string;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground">{children}</span>
    </div>
  );
}

export function AgentDetail({
  agent,
  triggers,
  canEdit,
  orgSlug,
  workspaceSlug,
  agentSlug,
}: AgentDetailProps) {
  const router = useRouter();
  const { add: addToast } = useToast();
  const ctx = { orgSlug, workspaceSlug };

  const [busy, setBusy] = React.useState<"publish" | "deploy" | null>(null);
  const [checksum, setChecksum] = React.useState<string | null>(null);

  const lifecycle = LIFECYCLE_BADGE[agent.status];
  const deployment = DEPLOYMENT_BADGE[agent.deploymentStatus];
  const isDeployed = agent.deploymentStatus === "active";

  async function handlePublish() {
    setBusy("publish");
    try {
      const result = await publishAgentAction({ orgSlug, workspaceSlug, agentId: agent.agentId });
      if (result.ok) {
        setChecksum(result.data.checksum);
        addToast({
          title: "Version published",
          description: `v${result.data.version} is now the active version.`,
          type: "background",
        });
        router.refresh();
      } else {
        addToast({ title: "Failed to publish", description: result.error, type: "background" });
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleDeployToggle() {
    setBusy("deploy");
    try {
      const next = isDeployed ? "inactive" : "active";
      const result = await deployAgentAction({
        orgSlug,
        workspaceSlug,
        agentId: agent.agentId,
        deploymentStatus: next,
      });
      if (result.ok) {
        addToast({
          title: next === "active" ? "Agent deployed" : "Agent deactivated",
          description:
            next === "active"
              ? "The agent is now active and its enabled triggers are live."
              : "The agent is inactive and its triggers are dormant.",
          type: "background",
        });
        router.refresh();
      } else {
        // Surface the typed activation error (no published version) verbatim.
        addToast({ title: "Cannot change deployment", description: result.error, type: "background" });
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">{agent.name}</h2>
            <Badge variant={lifecycle.variant} size="sm">
              {lifecycle.label}
            </Badge>
            <Badge variant={deployment.variant} size="sm">
              {deployment.label}
            </Badge>
          </div>
          {agent.description && (
            <p className="max-w-prose text-sm text-muted-foreground">{agent.description}</p>
          )}
          <p className="font-mono text-xs text-muted-foreground">{agent.slug}</p>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <Button
              render={<Link href={workspace.agents.edit(ctx, agentSlug)} />}
              variant="outline"
              size="sm"
              startIcon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              Edit
            </Button>
          )}
        </div>
      </div>

      {/* ── Lifecycle controls ─────────────────────────────────────────────── */}
      {canEdit && (
        <section
          aria-labelledby="agent-lifecycle-heading"
          className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card px-4 py-4"
        >
          <p id="agent-lifecycle-heading" className="text-sm font-semibold text-foreground">
            Lifecycle
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handlePublish}
              disabled={busy !== null}
              startIcon={<UploadCloud className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              {busy === "publish" ? "Publishing…" : "Publish latest version"}
            </Button>
            <Button
              type="button"
              variant={isDeployed ? "destructive-outline" : "gradient"}
              size="sm"
              onClick={handleDeployToggle}
              disabled={busy !== null}
              startIcon={<Rocket className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              {busy === "deploy"
                ? "Working…"
                : isDeployed
                  ? "Deactivate"
                  : "Deploy (activate)"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Activation requires a published version. Publishing makes the latest version immutable
            and the active version.
          </p>
          {checksum && (
            <p className="font-mono text-xs text-muted-foreground">
              Published checksum: <span className="text-foreground">{checksum}</span>
            </p>
          )}
        </section>
      )}

      {/* ── Version + state ─────────────────────────────────────────────────── */}
      <section aria-labelledby="agent-version-heading" className="flex flex-col gap-3">
        <p id="agent-version-heading" className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
          Version
        </p>
        <div className="grid grid-cols-2 gap-4 rounded-lg border border-border/60 bg-card px-4 py-4 sm:grid-cols-3">
          <Field label="Latest version">
            {agent.version != null ? `v${agent.version}` : "—"}
          </Field>
          <Field label="Published">
            {agent.isPublished ? (
              <Badge variant="success" size="sm">
                Published
              </Badge>
            ) : (
              <Badge variant="outline" size="sm">
                Unpublished
              </Badge>
            )}
          </Field>
          <Field label="Type">{agent.agentType}</Field>
        </div>
      </section>

      {/* ── Definition ──────────────────────────────────────────────────────── */}
      <section aria-labelledby="agent-definition-heading" className="flex flex-col gap-3">
        <p id="agent-definition-heading" className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
          Definition
        </p>
        <div className="flex flex-col gap-4 rounded-lg border border-border/60 bg-card px-4 py-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Graph mode">{agent.config.graph.mode ?? "read"}</Field>
            <Field label="Retrieval">{agent.config.graph.retrieval.strategy}</Field>
            <Field label="Max hops">{agent.config.graph.budget.maxHops}</Field>
            <Field label="Max nodes">{agent.config.graph.budget.maxNodes}</Field>
          </div>
          <Field label="Ontology">
            <span className="font-mono text-xs">{agent.config.graph.ontologyId}</span>
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Tools</span>
            {agent.config.agentTools && agent.config.agentTools.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {agent.config.agentTools.map((tool, i) => (
                  <li key={i}>
                    <Badge variant="secondary" size="sm">
                      {TOOL_TYPE_LABEL[tool.type] ?? tool.type}: {tool.ref}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-sm text-muted-foreground">No tools.</span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Instructions</span>
            {agent.config.instructions ? (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
                {agent.config.instructions}
              </pre>
            ) : (
              <span className="text-sm text-muted-foreground">No instructions.</span>
            )}
          </div>
        </div>
      </section>

      {/* ── Triggers ────────────────────────────────────────────────────────── */}
      <TriggersPanel
        agentId={agent.agentId}
        triggers={triggers}
        canEdit={canEdit}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
      />
    </div>
  );
}
