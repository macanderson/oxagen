"use client";

import { Switch } from "@/components/ui/switch";
import { SectionCard } from "./field-controls";

export function DefaultsSection({
  setAsDefault,
  onSetAsDefaultChange,
}: {
  setAsDefault: boolean;
  onSetAsDefaultChange: (v: boolean) => void;
}) {
  return (
    <SectionCard
      title="Defaults"
      description="Whether new sandbox runs in this environment use this template unless another is specified."
    >
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={setAsDefault} onCheckedChange={onSetAsDefaultChange} />
        Set as this environment&apos;s default template
      </label>
    </SectionCard>
  );
}
