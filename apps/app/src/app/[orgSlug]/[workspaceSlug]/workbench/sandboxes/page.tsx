/**
 * page.tsx — Workspace → Workbench → Sandboxes (first-class page).
 *
 * Lists the workspace's durable sandbox sessions (`list_sandboxes`), hosts
 * the "warm a sandbox" panel, and owns sandbox template configuration
 * (moved here from workspace settings — sandbox config is a Workbench
 * concern, not a settings one). Data loads server-side via
 * resolveWorkbenchScope + listSandboxes; the client panel owns the template
 * picker, start action, and navigation to a session's detail page. Listing
 * is a pure Postgres read and works even when the durable driver is
 * unconfigured — only warming/running needs SANDBOX_ENABLED, which the
 * client surfaces as a soft warning.
 */
import type { Metadata } from "next";
import { logger } from "@oxagen/handlers/logger";
import { PageHeader } from "@/components/ui/page-header";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import {
  listSandboxes,
  isSandboxUnavailable,
  type SandboxSummary,
} from "@/lib/workbench/sandboxes";
import { SandboxesClient } from "./sandboxes-client";
import { SandboxTemplatesPanel } from "./sandbox-templates-panel";
import { loadCodeModeOptions } from "../../_shared/code-mode-data";
import type { RepoOption } from "@/components/chat/repo-selector";
import {
  readEnvironmentsAction,
  readSecretKeysAction,
  type EnvironmentSummary,
  type SecretKeySummary,
} from "../environments/actions";
import {
  readTemplatesAction,
  readToolSourcesAction,
  createTemplateAction,
  updateTemplateAction,
  setTemplateToolsAction,
  setDefaultTemplateAction,
  deleteTemplateAction,
  exportTemplateAction,
  importTemplateAction,
  type SandboxTemplateSummary,
  type ToolSourceOption,
} from "./sandbox-template-actions";

export const metadata: Metadata = {
  title: "Sandboxes | Workbench",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function WorkbenchSandboxesPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );

  let sandboxes: SandboxSummary[] = [];
  let unavailable = false;
  try {
    sandboxes = await listSandboxes(ctx);
  } catch (e) {
    // Degrade gracefully but never silently: an empty list that's really a
    // broken read looks like "no sandboxes".
    unavailable = isSandboxUnavailable(e);
    logger.error(
      { err: e, orgSlug, workspaceSlug },
      "sandboxes: listSandboxes failed — rendering an empty session list",
    );
    sandboxes = [];
  }

  // Environments + secret keys feed the template editor's binding pickers.
  // Masked reads — values never cross to the client. Each read degrades to
  // empty (logged) so a failure never blanks the sessions list above.
  const scope = { orgSlug, workspaceSlug };
  const [environments, secretKeys, templates, toolSources, codeModeOptions] =
    await Promise.all([
      readEnvironmentsAction(scope).then(
        (d) => d,
        (err) => {
          logger.error(
            { err, orgSlug, workspaceSlug },
            "sandboxes: readEnvironmentsAction failed — rendering empty environment options",
          );
          return [] as EnvironmentSummary[];
        },
      ),
      readSecretKeysAction(scope).then(
        (d) => d,
        (err) => {
          logger.error(
            { err, orgSlug, workspaceSlug },
            "sandboxes: readSecretKeysAction failed — rendering empty secret options",
          );
          return [] as SecretKeySummary[];
        },
      ),
      readTemplatesAction(scope).then(
        (d) => d,
        (err) => {
          logger.error(
            { err, orgSlug, workspaceSlug },
            "sandboxes: readTemplatesAction failed — rendering empty templates section",
          );
          return [] as SandboxTemplateSummary[];
        },
      ),
      readToolSourcesAction(scope).then(
        (d) => d,
        () => [] as ToolSourceOption[],
      ),
      // loadCodeModeOptions never throws (degrades to empty lists internally),
      // so no .catch needed here — mirrors its other call site in conversation-page.tsx.
      loadCodeModeOptions(ctx.orgId, ctx.workspaceId, ctx),
    ]);
  const repoOptions: RepoOption[] = codeModeOptions.repos;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Sandboxes"
          description="Durable code sandboxes agents build in — warm one from a template, drive its terminal, and inspect its files."
          className="pb-0"
        />
        <SandboxesClient
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialSandboxes={sandboxes}
          canManage={canManage}
          unavailable={unavailable}
          templates={templates}
          repoOptions={repoOptions}
        />
      </div>
      <SandboxTemplatesPanel
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        canManage={canManage}
        environments={environments}
        secretKeys={secretKeys}
        templates={templates}
        toolSources={toolSources}
        createTemplateAction={createTemplateAction}
        updateTemplateAction={updateTemplateAction}
        setTemplateToolsAction={setTemplateToolsAction}
        setDefaultTemplateAction={setDefaultTemplateAction}
        deleteTemplateAction={deleteTemplateAction}
        exportTemplateAction={exportTemplateAction}
        importTemplateAction={importTemplateAction}
      />
    </div>
  );
}
