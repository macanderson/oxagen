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
   * Accessible label for the trigger. Defaults to "Select environment". The
   * pin context bar overrides it ("Pinned environment") so the always-visible
   * pin selector doesn't collide with the code-mode toolbar's selector.
   */
  ariaLabel?: string;
  placeholder?: string;
}

export function EnvironmentSelector({
  environments,
  selectedEnvId,
  onSelectEnv,
  isLoading = false,
  ariaLabel = "Select environment",
  placeholder = "Select environment",
}: EnvironmentSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <Settings className="size-4 text-muted-foreground" />
      <Select
        value={selectedEnvId ?? ""}
        onValueChange={(value) => {
          if (value) onSelectEnv(value);
        }}
        disabled={isLoading || environments.length === 0}
      >
        <SelectTrigger className="w-40" aria-label={ariaLabel}>
          <SelectValue placeholder={placeholder} />
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
