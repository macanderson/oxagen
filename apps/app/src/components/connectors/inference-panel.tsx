"use client";

/**
 * inference-panel.tsx — AI relationship inference configuration panel.
 *
 * Toggle enable/disable
 * Confidence threshold slider (if schema provides it)
 * ontologyPrompt textarea (large, optional)
 * Per-recordType toggles if perRecordType defined in schema
 */

import * as React from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Sparkles } from "lucide-react";
import { useConnectorSchema } from "./connector-schema-provider";

const INFERENCE_ENABLED_KEY = "inferenceEnabled";
const INFERENCE_CONFIDENCE_KEY = "inferenceConfidence";
const INFERENCE_PROMPT_KEY = "inferenceOntologyPrompt";
const INFERENCE_RECORD_TYPES_KEY = "inferenceRecordTypes";

export function InferencePanel() {
  const { schema, formState, setFieldValue } = useConnectorSchema();

  const inference = schema?.inference;
  if (!inference || !inference.enabled) return null;

  const enabled =
    typeof formState.values[INFERENCE_ENABLED_KEY] === "boolean"
      ? (formState.values[INFERENCE_ENABLED_KEY] as boolean)
      : (inference.defaultEnabled ?? true);

  const confidence =
    typeof formState.values[INFERENCE_CONFIDENCE_KEY] === "number"
      ? (formState.values[INFERENCE_CONFIDENCE_KEY] as number)
      : (inference.confidenceThreshold?.defaultValue ?? 0.75);

  const ontologyPrompt =
    typeof formState.values[INFERENCE_PROMPT_KEY] === "string"
      ? (formState.values[INFERENCE_PROMPT_KEY] as string)
      : (inference.ontologyPrompt ?? "");

  const perRecordTypes: Record<string, boolean> =
    formState.values[INFERENCE_RECORD_TYPES_KEY] &&
    typeof formState.values[INFERENCE_RECORD_TYPES_KEY] === "object" &&
    !Array.isArray(formState.values[INFERENCE_RECORD_TYPES_KEY])
      ? (formState.values[INFERENCE_RECORD_TYPES_KEY] as Record<string, boolean>)
      : (inference.perRecordType ?? {});

  const hasPerRecordType =
    inference.perRecordType && Object.keys(inference.perRecordType).length > 0;

  const confidenceMin = inference.confidenceThreshold?.min ?? 0;
  const confidenceMax = inference.confidenceThreshold?.max ?? 1;

  return (
    <div className="flex flex-col gap-5">
      {/* Main toggle */}
      <div className="flex items-center gap-3">
        <Switch
          id="inference-enabled"
          checked={enabled}
          onCheckedChange={(v) => setFieldValue(INFERENCE_ENABLED_KEY, v)}
        />
        <label htmlFor="inference-enabled" className="flex items-center gap-1.5 cursor-pointer select-none">
          <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          <span className="text-sm font-medium text-foreground">
            {inference.toggleLabel ?? "Enable AI relationship inference"}
          </span>
        </label>
      </div>

      {enabled && (
        <div className="flex flex-col gap-5 pl-0">
          {/* Confidence threshold slider */}
          {inference.confidenceThreshold && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="inference-confidence">
                Confidence threshold
              </Label>
              <div className="flex items-center gap-3">
                <Slider
                  id="inference-confidence"
                  value={confidence}
                  onValueChange={(v) => setFieldValue(INFERENCE_CONFIDENCE_KEY, v)}
                  min={confidenceMin}
                  max={confidenceMax}
                  step={0.01}
                  className="flex-1"
                />
                <span className="min-w-[3rem] text-right text-sm tabular-nums text-foreground">
                  {typeof confidence === "number" ? confidence.toFixed(2) : "—"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Relationships with confidence below this value will not be stored.
                Range: {confidenceMin}–{confidenceMax}.
              </p>
            </div>
          )}

          {/* Per-record type toggles */}
          {hasPerRecordType && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-foreground">Infer from record types</p>
              <div className="flex flex-col gap-2">
                {Object.entries(inference.perRecordType ?? {}).map(([rtId, defaultOn]) => {
                  const on =
                    typeof perRecordTypes[rtId] === "boolean"
                      ? perRecordTypes[rtId]
                      : defaultOn;
                  return (
                    <div key={rtId} className="flex items-center gap-3">
                      <Switch
                        id={`inference-rt-${rtId}`}
                        checked={on}
                        onCheckedChange={(v) =>
                          setFieldValue(INFERENCE_RECORD_TYPES_KEY, {
                            ...perRecordTypes,
                            [rtId]: v,
                          })
                        }
                      />
                      <label
                        htmlFor={`inference-rt-${rtId}`}
                        className="text-sm text-foreground capitalize cursor-pointer select-none"
                      >
                        {rtId.replace(/_/g, " ")}
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Ontology prompt textarea */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="inference-prompt">
              Ontology extraction prompt{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="inference-prompt"
              value={ontologyPrompt}
              onChange={(e) => setFieldValue(INFERENCE_PROMPT_KEY, e.currentTarget.value)}
              placeholder="Instructions for what relationships to infer from this connector's data…"
              className="resize-y min-h-[120px] font-mono text-xs"
              rows={6}
            />
            <p className="text-xs text-muted-foreground">
              Optional custom instructions for the inference model. Leave blank to use the default.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
