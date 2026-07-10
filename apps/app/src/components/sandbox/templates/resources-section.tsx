"use client";

import { RESOURCE_FIELD_META, RESOURCE_LIMITS } from "./manifest-field-meta";
import { BoundedNumber, SectionCard } from "./field-controls";

export function ResourcesSection({
  vcpu,
  onVcpuChange,
  memoryMb,
  onMemoryMbChange,
  timeoutMs,
  onTimeoutMsChange,
  diskMb,
  onDiskMbChange,
}: {
  vcpu: string;
  onVcpuChange: (v: string) => void;
  memoryMb: string;
  onMemoryMbChange: (v: string) => void;
  timeoutMs: string;
  onTimeoutMsChange: (v: string) => void;
  diskMb: string;
  onDiskMbChange: (v: string) => void;
}) {
  return (
    <SectionCard
      title="Resources"
      description="Bounded compute envelope. Every field is optional — a blank field lets the provider substitute its own default."
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <BoundedNumber
          label={RESOURCE_FIELD_META.vcpu.label}
          max={RESOURCE_LIMITS.vcpu}
          value={vcpu}
          onChange={onVcpuChange}
          help={RESOURCE_FIELD_META.vcpu.help}
        />
        <BoundedNumber
          label={RESOURCE_FIELD_META.memoryMb.label}
          max={RESOURCE_LIMITS.memoryMb}
          value={memoryMb}
          onChange={onMemoryMbChange}
          help={RESOURCE_FIELD_META.memoryMb.help}
        />
        <BoundedNumber
          label={RESOURCE_FIELD_META.timeoutMs.label}
          max={RESOURCE_LIMITS.timeoutMs}
          value={timeoutMs}
          onChange={onTimeoutMsChange}
          help={RESOURCE_FIELD_META.timeoutMs.help}
        />
        <BoundedNumber
          label={RESOURCE_FIELD_META.diskMb.label}
          max={RESOURCE_LIMITS.diskMb}
          value={diskMb}
          onChange={onDiskMbChange}
          help={RESOURCE_FIELD_META.diskMb.help}
        />
      </div>
    </SectionCard>
  );
}
