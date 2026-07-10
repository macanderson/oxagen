"use client";

import { Input } from "@/components/ui/input";
import type { SandboxProvider } from "@oxagen/oxagen/contracts/sandbox-template-manifest";
import { PROVIDER_META, PROVIDER_OPTIONS } from "./manifest-field-meta";
import { Field, NativeSelect, SectionCard } from "./field-controls";

export function ProviderRuntimeSection({
  provider,
  onProviderChange,
  runtime,
  onRuntimeChange,
}: {
  provider: SandboxProvider;
  onProviderChange: (v: SandboxProvider) => void;
  runtime: string;
  onRuntimeChange: (v: string) => void;
}) {
  return (
    <SectionCard
      title="Provider & runtime"
      description="Which vendor provisions the sandbox, and what image it boots. A template is portable across all three — this is the only field you'd change to move providers."
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Provider" help={PROVIDER_META[provider].help}>
          <NativeSelect
            value={provider}
            onChange={(v) => onProviderChange(v as SandboxProvider)}
            data-testid="sandbox-template-provider-select"
          >
            {PROVIDER_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_META[p].label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label="Runtime image ref"
          help="OCI image reference the provider boots. Blank uses the provider's default base image."
        >
          <Input
            className="max-md:h-11 font-mono"
            value={runtime}
            placeholder="ghcr.io/oxageninc/oxagen-ci-base:latest"
            onChange={(e) => onRuntimeChange(e.target.value)}
          />
        </Field>
      </div>
    </SectionCard>
  );
}
