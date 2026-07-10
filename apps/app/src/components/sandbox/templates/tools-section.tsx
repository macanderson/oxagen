"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SandboxTemplateTool } from "@oxagen/oxagen/contracts/sandbox-template-manifest";
import type { ToolSourceOption } from "@/app/[orgSlug]/[workspaceSlug]/workbench/sandboxes/sandbox-template-actions";
import { TOOL_KIND_META, TOOL_KIND_OPTIONS } from "./manifest-field-meta";
import { Field, NativeSelect, SectionCard } from "./field-controls";

export function ToolsSection({
  tools,
  onToolsChange,
  toolSources,
}: {
  tools: SandboxTemplateTool[];
  onToolsChange: (tools: SandboxTemplateTool[]) => void;
  toolSources: ToolSourceOption[];
}) {
  const listId = "sandbox-tool-suggestions";
  return (
    <SectionCard
      title="Preloaded tools"
      description="Workspace-installed capabilities, MCP servers, agent skills, or raw tools bound into this sandbox."
    >
      <Field label="Tools">
        <div className="flex flex-col gap-2">
          <datalist id={listId}>
            {toolSources.map((s) => (
              <option key={`${s.kind}:${s.ref}`} value={s.ref}>
                {s.label} ({s.kind})
              </option>
            ))}
          </datalist>
          {tools.map((t, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <NativeSelect
                  value={t.kind}
                  onChange={(v) =>
                    onToolsChange(
                      tools.map((tool, idx) =>
                        idx === i
                          ? { ...tool, kind: v as SandboxTemplateTool["kind"] }
                          : tool,
                      ),
                    )
                  }
                >
                  {TOOL_KIND_OPTIONS.map((k) => (
                    <option key={k} value={k}>
                      {TOOL_KIND_META[k].label}
                    </option>
                  ))}
                </NativeSelect>
                <Input
                  className="max-md:h-11 font-mono"
                  list={listId}
                  value={t.ref}
                  placeholder="ref (capability name / skill or server id)"
                  onChange={(e) =>
                    onToolsChange(
                      tools.map((tool, idx) =>
                        idx === i ? { ...tool, ref: e.target.value } : tool,
                      ),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="xs"
                  className="max-md:h-11"
                  onClick={() =>
                    onToolsChange(tools.filter((_, idx) => idx !== i))
                  }
                >
                  ✕
                </Button>
              </div>
              <span className="pl-1 text-xs text-muted-foreground">
                {TOOL_KIND_META[t.kind].help}
              </span>
            </div>
          ))}
          <Button
            variant="outline"
            size="xs"
            className="max-md:h-11 self-start"
            onClick={() =>
              onToolsChange([...tools, { kind: "capability", ref: "" }])
            }
            data-testid="sandbox-template-add-tool"
          >
            + Add tool
          </Button>
        </div>
      </Field>
    </SectionCard>
  );
}
