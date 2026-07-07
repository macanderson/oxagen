"use client";

import * as React from "react";
import { Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectPopup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * A workspace environment as returned by the `environment.list` capability
 * (`environmentSummarySchema` in `packages/oxagen/src/contracts/environment.create.ts`).
 * There is no "local/staging/production" `type` field on the real contract —
 * environments are workspace-defined (name + slug), with exactly one
 * `isDefault` per workspace.
 */
export interface EnvironmentOption {
  id: string;
  name: string;
  isDefault: boolean;
}

interface EnvironmentSelectorProps {
  environments: EnvironmentOption[];
  selectedEnvId: string | null;
  onSelectEnv: (envId: string) => void;
  isLoading?: boolean;
  /**
   * Extra classes for the select trigger. Defaults to a mobile-first width
   * (`w-full` below `sm`, fixed `sm:w-40` on desktop) with a ≥44px touch
   * target on phones — pass a class to override from the parent layout.
   */
  className?: string;
}

export function EnvironmentSelector({
  environments,
  selectedEnvId,
  onSelectEnv,
  isLoading = false,
  className,
}: EnvironmentSelectorProps) {
  return (
    <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
      <Settings className="size-4 shrink-0 text-muted-foreground" />
      <Select
        value={selectedEnvId ?? ""}
        onValueChange={(value) => {
          if (value) onSelectEnv(value);
        }}
        disabled={isLoading || environments.length === 0}
      >
        <SelectTrigger
          className={cn("min-h-11 w-full sm:min-h-0 sm:w-40", className)}
          aria-label="Select environment"
        >
          <SelectValue placeholder="Select environment" />
        </SelectTrigger>
        <SelectPopup>
          {environments.map((env) => (
            <SelectItem key={env.id} value={env.id}>
              <div className="flex items-center gap-2">
                <span>{env.name}</span>
                {env.isDefault && (
                  <Badge variant="secondary" className="text-[10px]">
                    Default
                  </Badge>
                )}
              </div>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
