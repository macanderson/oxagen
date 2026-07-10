"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, SectionCard } from "./field-controls";

export function IdentitySection({
  name,
  onNameChange,
  slug,
  onSlugChange,
  description,
  onDescriptionChange,
}: {
  name: string;
  onNameChange: (v: string) => void;
  /** The effective (auto-derived-or-typed) slug currently shown in the field. */
  slug: string;
  onSlugChange: (v: string) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
}) {
  return (
    <SectionCard
      title="Identity"
      description="How this template is named and found."
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Name"
          help="Human-readable name shown in the sandbox templates panel."
        >
          <Input
            className="max-md:h-11"
            value={name}
            placeholder="SWE-bench runner"
            onChange={(e) => onNameChange(e.target.value)}
            data-testid="sandbox-template-name-input"
          />
        </Field>
        <Field
          label="Slug"
          help="URL/DB-safe identifier, unique within the environment. Auto-derived from Name until you edit it directly."
        >
          <Input
            className="max-md:h-11 font-mono"
            value={slug}
            placeholder="swe-bench-runner"
            onChange={(e) => onSlugChange(e.target.value)}
          />
        </Field>
      </div>
      <Field
        label="Description"
        help="What this sandbox is for. Purely descriptive; never parsed."
      >
        <Textarea
          value={description}
          rows={2}
          placeholder="What this sandbox is for."
          onChange={(e) => onDescriptionChange(e.target.value)}
        />
      </Field>
    </SectionCard>
  );
}
