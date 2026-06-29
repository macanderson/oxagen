"use client";

import * as React from "react";
import { Settings } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface Environment {
  id: string;
  name: string;
  type: "local" | "staging" | "production";
  apiUrl?: string;
}

interface EnvironmentSelectorProps {
  environments: Environment[];
  selectedEnvId: string | null;
  onSelectEnv: (envId: string) => void;
  isLoading?: boolean;
}

const environmentBadgeColor: Record<Environment["type"], string> = {
  local: "bg-blue-100 text-blue-800",
  staging: "bg-yellow-100 text-yellow-800",
  production: "bg-red-100 text-red-800",
};

export function EnvironmentSelector({
  environments,
  selectedEnvId,
  onSelectEnv,
  isLoading = false,
}: EnvironmentSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <Settings className="size-4 text-muted-foreground" />
      <Select
        value={selectedEnvId || ""}
        onValueChange={(value) => {
          if (value) onSelectEnv(value);
        }}
        disabled={isLoading}
      >
        <SelectTrigger className="w-40">
          <SelectValue placeholder="Select environment" />
        </SelectTrigger>
        <SelectContent>
          {environments.map((env) => (
            <SelectItem key={env.id} value={env.id}>
              <div className="flex items-center gap-2">
                <span>{env.name}</span>
                <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${environmentBadgeColor[env.type]}`}>
                  {env.type}
                </span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
