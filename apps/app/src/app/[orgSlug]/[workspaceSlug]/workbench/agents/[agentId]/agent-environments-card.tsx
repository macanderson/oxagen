"use client";

import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import type {
  ActionResult,
  AgentEnvironmentBinding,
  EnvironmentOption,
  TemplateOption,
} from "./environments-actions";

interface Scope {
  orgSlug: string;
  workspaceSlug: string;
}

interface Props {
  scope: Scope;
  agentId: string;
  canManage: boolean;
  bindings: AgentEnvironmentBinding[];
  environments: EnvironmentOption[];
  templates: TemplateOption[];
  bindAction: (
    args: Scope & {
      agentId: string;
      environmentId: string;
      sandboxTemplateId?: string | null;
      isPrimary?: boolean;
    },
  ) => Promise<ActionResult<{ binding: AgentEnvironmentBinding }>>;
  unbindAction: (
    args: Scope & { agentId: string; environmentId: string },
  ) => Promise<ActionResult>;
}

export function AgentEnvironmentsCard(props: Props) {
  const { scope, agentId, canManage, bindings, environments, templates } = props;
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Bind form state.
  const boundEnvIds = useMemo(
    () => new Set(bindings.map((b) => b.environmentId)),
    [bindings],
  );
  const availableEnvs = environments.filter((e) => !boundEnvIds.has(e.id));
  const [envId, setEnvId] = useState<string>("");
  const [templateId, setTemplateId] = useState<string>("");
  const [primary, setPrimary] = useState(false);

  const templatesForEnv = useMemo(
    () => templates.filter((t) => t.environmentId === envId),
    [templates, envId],
  );

  const run = (fn: () => Promise<ActionResult<unknown>>) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.error);
    });

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-border/40 p-4"
      data-testid="agent-environments-card"
    >
      <div>
        <h3 className="text-sm font-medium">Environments</h3>
        <p className="text-xs text-muted-foreground">
          Bind this agent to environments and their sandbox templates. The primary binding
          resolves first at run time; unbinding the primary falls back to the workspace default
          environment and its default template.
        </p>
      </div>

      {error && (
        <Alert variant="error">
          <AlertTitle>Couldn&apos;t update bindings</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="overflow-x-auto rounded-md border border-border/40">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/40 text-xs text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">Environment</th>
              <th className="px-3 py-2 text-left font-medium">Template</th>
              <th className="px-3 py-2 text-left font-medium">Primary</th>
              {canManage && <th className="px-2 py-2" />}
            </tr>
          </thead>
          <tbody>
            {bindings.length === 0 && (
              <tr>
                <td
                  colSpan={canManage ? 4 : 3}
                  className="px-3 py-4 text-center text-muted-foreground"
                >
                  No bindings — this agent uses the workspace default environment and template.
                </td>
              </tr>
            )}
            {bindings.map((b) => (
              <tr
                key={b.id}
                className="border-b border-border/30 last:border-0"
                data-testid={`agent-binding-row-${b.environmentSlug}`}
              >
                <td className="px-3 py-2">
                  <span className="font-medium">{b.environmentName}</span>{" "}
                  <span className="text-xs text-muted-foreground">{b.environmentSlug}</span>
                </td>
                <td className="px-3 py-2 text-xs">
                  {b.sandboxTemplateName ?? (
                    <span className="text-muted-foreground">environment default</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {b.isPrimary ? (
                    <Badge variant="secondary" size="sm">
                      ★ primary
                    </Badge>
                  ) : canManage ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="max-md:h-11"
                      disabled={pending}
                      onClick={() =>
                        run(() =>
                          props.bindAction({
                            ...scope,
                            agentId,
                            environmentId: b.environmentId,
                            sandboxTemplateId: b.sandboxTemplateId,
                            isPrimary: true,
                          }),
                        )
                      }
                      data-testid={`agent-binding-primary-${b.environmentSlug}`}
                    >
                      Make primary
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                {canManage && (
                  <td className="px-2 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="xs"
                      className="max-md:h-11 text-destructive"
                      disabled={pending}
                      onClick={() =>
                        run(() =>
                          props.unbindAction({
                            ...scope,
                            agentId,
                            environmentId: b.environmentId,
                          }),
                        )
                      }
                      data-testid={`agent-binding-unbind-${b.environmentSlug}`}
                    >
                      Unbind
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && (
        <div className="flex flex-col gap-2 rounded-md border border-border/40 p-3">
          <span className="text-xs font-medium text-muted-foreground">Bind an environment</span>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Environment</span>
              <select
                className="max-md:h-11 rounded-md border border-border/50 bg-background px-2 py-1.5 text-sm"
                value={envId}
                onChange={(e) => {
                  setEnvId(e.target.value);
                  setTemplateId("");
                }}
                data-testid="agent-bind-env-select"
              >
                <option value="">Select…</option>
                {availableEnvs.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name} ({env.slug})
                    {env.isDefault ? " ★" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Template (optional)</span>
              <select
                className="max-md:h-11 rounded-md border border-border/50 bg-background px-2 py-1.5 text-sm"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                disabled={!envId}
                data-testid="agent-bind-template-select"
              >
                <option value="">Environment default</option>
                {templatesForEnv.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.isDefault ? " ★" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={primary} onCheckedChange={setPrimary} />
              Primary
            </label>
            <Button
              size="sm"
              className="max-md:h-11"
              disabled={pending || !envId}
              onClick={() =>
                run(async () => {
                  const res = await props.bindAction({
                    ...scope,
                    agentId,
                    environmentId: envId,
                    sandboxTemplateId: templateId || null,
                    isPrimary: primary,
                  });
                  if (res.ok) {
                    setEnvId("");
                    setTemplateId("");
                    setPrimary(false);
                  }
                  return res;
                })
              }
              data-testid="agent-bind-submit"
            >
              Bind
            </Button>
          </div>
          {availableEnvs.length === 0 && environments.length > 0 && (
            <p className="text-xs text-muted-foreground">
              This agent is bound to every environment.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
