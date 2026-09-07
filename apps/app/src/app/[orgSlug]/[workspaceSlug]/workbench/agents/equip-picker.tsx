"use client";
/**
 * equip-picker.tsx — the reusable 2-tab picker for the Agent Builder's tool
 * allowlist step.
 *
 * An agent's allowlist is ONE uniform list — capabilities and MCP servers —
 * modeled as AgentTool { type, ref, config? }. Per ADR-041 the skill and
 * subagent pools are gone with the runtime. This component surfaces the two
 * remaining pools as tabs and toggles each item in or out of the caller-owned
 * agentTools[] via onChange. It holds no state of its own; the builder owns
 * the list.
 */
import * as React from "react";
import { Check, Plus, ShieldAlert, ShoppingBag } from "lucide-react";
import type { AgentTool, AgentToolType } from "@oxagen/oxagen/agent-schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
  TabsIndicator,
} from "@/components/ui/tabs";
import type { AgentToolRow } from "@/lib/workbench/tools";

export interface McpOption {
  ref: string;
  name: string;
  title: string | null;
  description: string | null;
  enabled: boolean;
}

export interface EquipSources {
  tools: AgentToolRow[];
  mcp: McpOption[];
}

export interface EquipPickerProps {
  sources: EquipSources;
  value: AgentTool[];
  onChange: (next: AgentTool[]) => void;
  disabled?: boolean;
  /**
   * When set, renders an "Install more from Marketplace" affordance below the
   * pools so new MCP servers / capabilities can be installed without leaving
   * the wizard. Callers gate this on manage rights — installs flow through the
   * agent-tools choke point (lib/agent-tools/install-actions).
   */
  onBrowseMarketplace?: () => void;
}

function has(value: AgentTool[], type: AgentToolType, ref: string): boolean {
  return value.some((t) => t.type === type && t.ref === ref);
}

function toggle(
  value: AgentTool[],
  type: AgentToolType,
  ref: string,
): AgentTool[] {
  if (has(value, type, ref)) {
    return value.filter((t) => !(t.type === type && t.ref === ref));
  }
  return [...value, { type, ref }];
}

function riskVariant(
  risk: AgentToolRow["riskLevel"],
): "default" | "secondary" | "outline" {
  if (risk === "high") return "default";
  if (risk === "medium") return "secondary";
  return "outline";
}

function EquipRow({
  title,
  subtitle,
  meta,
  added,
  disabled,
  onToggle,
  testId,
}: {
  title: string;
  subtitle?: string | null;
  meta?: React.ReactNode;
  added: boolean;
  disabled?: boolean;
  onToggle: () => void;
  testId: string;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2.5"
      data-testid={testId}
    >
      <div className="min-w-0 flex flex-col gap-0.5">
        <span className="font-medium text-foreground truncate">{title}</span>
        {subtitle ? (
          <span className="text-xs text-muted-foreground truncate">
            {subtitle}
          </span>
        ) : null}
        {meta ? (
          <div className="flex items-center gap-1.5 pt-0.5">{meta}</div>
        ) : null}
      </div>
      <Button
        type="button"
        variant={added ? "secondary" : "outline"}
        size="sm"
        className="h-7 flex-shrink-0"
        disabled={disabled}
        onClick={onToggle}
        aria-pressed={added}
        startIcon={
          added ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          )
        }
        data-testid={`${testId}-toggle`}
      >
        {added ? "Added" : "Add"}
      </Button>
    </div>
  );
}

function EmptyPool({ label }: { label: string }) {
  return (
    <p className="px-1 py-6 text-center text-xs text-muted-foreground">
      No {label} available in this workspace.
    </p>
  );
}

export function EquipPicker({
  sources,
  value,
  onChange,
  disabled,
  onBrowseMarketplace,
}: EquipPickerProps) {
  const count = (type: AgentToolType) =>
    value.filter((t) => t.type === type).length;

  return (
    <Tabs defaultValue="tools">
      <TabsList variant="underline" className="relative mb-4">
        <TabsTab value="tools">Capabilities ({count("function")})</TabsTab>
        <TabsTab value="mcp">MCP ({count("mcp_server")})</TabsTab>
        <TabsIndicator />
      </TabsList>

      {/* Tools (capabilities) */}
      <TabsPanel value="tools" className="flex flex-col gap-2">
        {sources.tools.length === 0 ? (
          <EmptyPool label="tools" />
        ) : (
          sources.tools.map((t) => (
            <EquipRow
              key={t.name}
              title={t.name}
              subtitle={t.description}
              meta={
                <>
                  <Badge
                    variant={riskVariant(t.riskLevel)}
                    className="text-[10px]"
                  >
                    {t.riskLevel} risk
                  </Badge>
                  {t.requiresApproval ? (
                    <Badge
                      variant="outline"
                      className="inline-flex items-center gap-1 text-[10px]"
                    >
                      <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                      approval
                    </Badge>
                  ) : null}
                  {t.external ? (
                    <Badge variant="outline" className="text-[10px]">
                      external
                    </Badge>
                  ) : null}
                </>
              }
              added={has(value, "function", t.name)}
              disabled={disabled}
              onToggle={() => onChange(toggle(value, "function", t.name))}
              testId={`equip-tool-${t.name}`}
            />
          ))
        )}
      </TabsPanel>

      {/* MCP servers */}
      <TabsPanel value="mcp" className="flex flex-col gap-2">
        {sources.mcp.length === 0 ? (
          <EmptyPool label="MCP servers" />
        ) : (
          sources.mcp.map((m) => (
            <EquipRow
              key={m.ref}
              title={m.title ?? m.name}
              subtitle={m.description ?? m.name}
              meta={
                !m.enabled ? (
                  <Badge variant="outline" className="text-[10px]">
                    disabled
                  </Badge>
                ) : undefined
              }
              added={has(value, "mcp_server", m.ref)}
              disabled={disabled}
              onToggle={() => onChange(toggle(value, "mcp_server", m.ref))}
              testId={`equip-mcp-${m.ref}`}
            />
          ))
        )}
      </TabsPanel>

      {onBrowseMarketplace ? (
        <div className="mt-4 flex justify-center border-t border-border/40 pt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="max-md:h-11 max-md:w-full"
            onClick={onBrowseMarketplace}
            startIcon={
              <ShoppingBag className="h-3.5 w-3.5" aria-hidden="true" />
            }
            data-testid="equip-browse-marketplace"
          >
            Install more from Marketplace
          </Button>
        </div>
      ) : null}
    </Tabs>
  );
}
