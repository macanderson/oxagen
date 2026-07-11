"use client";

/**
 * Compact at-a-glance spec chips for a saved-template row/card — lets a user
 * compare templates in a list without opening the editor.
 */
import { Badge } from "@/components/ui/badge";
import type { SandboxTemplateSummary } from "@/app/[orgSlug]/[workspaceSlug]/workbench/sandboxes/sandbox-template-actions";
import { NETWORK_MODE_META, PROVIDER_META } from "./manifest-field-meta";

type ChipTemplate = Pick<
  SandboxTemplateSummary,
  "provider" | "runtime" | "resources" | "network" | "secretSelection" | "tools"
>;

export function templateResourceSummary(
  resources: ChipTemplate["resources"],
): string {
  if (resources.vcpu == null && resources.memoryMb == null)
    return "provider default";
  return `${resources.vcpu ?? "—"} vCPU / ${resources.memoryMb ?? "—"} MB`;
}

export function templateSecretSummary(
  secretSelection: ChipTemplate["secretSelection"],
): string {
  if (secretSelection === "all") return "all keys";
  const n = secretSelection.keyPublicIds.length;
  return `${n} key${n === 1 ? "" : "s"}`;
}

function truncateImageRef(ref: string): string {
  return ref.length > 28 ? `…${ref.slice(-27)}` : ref;
}

export function TemplateSpecChips({ template }: { template: ChipTemplate }) {
  const { provider, runtime, resources, network, secretSelection, tools } =
    template;
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      data-testid="sandbox-template-spec-chips"
    >
      <Badge variant="outline" size="sm" title={PROVIDER_META[provider].help}>
        {PROVIDER_META[provider].label}
      </Badge>
      {runtime && (
        <Badge
          variant="outline"
          size="sm"
          className="font-mono"
          title={runtime}
        >
          {truncateImageRef(runtime)}
        </Badge>
      )}
      <Badge variant="outline" size="sm">
        {templateResourceSummary(resources)}
      </Badge>
      <Badge
        variant="outline"
        size="sm"
        title={NETWORK_MODE_META[network.mode].help}
      >
        {NETWORK_MODE_META[network.mode].label}
      </Badge>
      <Badge variant="outline" size="sm">
        {templateSecretSummary(secretSelection)}
      </Badge>
      <Badge variant="outline" size="sm">
        {tools.length} tool{tools.length === 1 ? "" : "s"}
      </Badge>
    </div>
  );
}
