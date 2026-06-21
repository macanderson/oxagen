/**
 * field-renderer-types.ts — Shared TypeScript types for the field-renderer module.
 */

import type { schemaFieldSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";
import type { z } from "zod";

export type SchemaField = z.infer<typeof schemaFieldSchema>;

export interface FieldRendererProps {
  field: SchemaField;
  /** Namespace prefix for field ID (e.g. "config", "auth") */
  namespace?: string;
  disabled?: boolean;
}

export interface FieldWrapperProps {
  id: string;
  label: string;
  description?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  /** Switch fields render label inline (right of toggle) */
  inline?: boolean;
}

export interface TagInputProps {
  id: string;
  value: string[];
  onChange: (tags: string[]) => void;
  onBlur: () => void;
  placeholder?: string;
  disabled?: boolean;
  itemPattern?: string;
}

export interface MultiSelectWidgetProps {
  id: string;
  value: string[];
  onChange: (v: string[]) => void;
  onBlur: () => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}
