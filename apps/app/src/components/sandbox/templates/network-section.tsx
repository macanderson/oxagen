"use client";

import type { SandboxNetworkMode } from "@oxagen/oxagen/contracts/sandbox-template-manifest";
import { NETWORK_MODE_META, NETWORK_MODE_OPTIONS } from "./manifest-field-meta";
import { Field, NativeSelect, SectionCard } from "./field-controls";

export function NetworkSection({
  networkMode,
  onNetworkModeChange,
}: {
  networkMode: SandboxNetworkMode;
  onNetworkModeChange: (v: SandboxNetworkMode) => void;
}) {
  const meta = NETWORK_MODE_META[networkMode];
  return (
    <SectionCard
      title="Network"
      description="Egress/connectivity posture the sandbox provisions with."
    >
      <Field label="Network mode" help={meta.help}>
        <NativeSelect
          value={networkMode}
          onChange={(v) => onNetworkModeChange(v as SandboxNetworkMode)}
          data-testid="sandbox-template-network-select"
        >
          {NETWORK_MODE_OPTIONS.map((mode) => (
            <option key={mode} value={mode}>
              {NETWORK_MODE_META[mode].label}
              {NETWORK_MODE_META[mode].provisionable
                ? ""
                : " — not yet provisionable"}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {!meta.provisionable && (
        <p
          className="text-xs text-warning"
          data-testid="sandbox-template-network-warning"
        >
          Declared for portability; not yet provisionable. A run using this mode
          will fail fast at provision time.
        </p>
      )}
    </SectionCard>
  );
}
