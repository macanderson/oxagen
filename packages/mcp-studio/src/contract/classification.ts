// classification.ts: the tools.toml classification keys and today's
// ToolClassification, each written from the other.
//
// tools.toml writes the classification in snake case. The code, Cedar's
// context, and agent.tool_versions read ToolClassification in camelCase.
// Both call the list of labels such as `moves_money` `impacts`.
import {
  toolClassificationSchema,
  type ToolClassification,
  type ToolRiskGrade,
} from "@oxagen/oxagen/contracts/tool.classification";
import type { ToolsEntry, ToolsMeasure } from "./tools";

/** The classification keys of one tools.toml entry. */
export type ToolsClassification = Pick<
  ToolsEntry,
  "risk" | "side_effect" | "egress" | "impacts" | "measures" | "data_classes"
>;

/** The risk grade and ToolClassification one tools.toml entry states. Throws when it does not validate. */
export function toCodeClassification(entry: ToolsClassification): {
  risk: ToolRiskGrade;
  classification: ToolClassification;
} {
  const measures: Record<string, unknown> = {};
  for (const [name, measure] of Object.entries(entry.measures ?? {})) {
    measures[name] = {
      path: measure.path,
      type: measure.type,
      ...(measure.currency_path === undefined ? {} : { currencyPath: measure.currency_path }),
      ...(measure.unit === undefined ? {} : { unit: measure.unit }),
    };
  }
  const classification = toolClassificationSchema.parse({
    sideEffect: entry.side_effect,
    egress: entry.egress,
    impacts: [...(entry.impacts ?? [])],
    measures,
    dataClasses: [...(entry.data_classes ?? [])],
  });
  return { risk: entry.risk, classification };
}

/** The tools.toml keys for a risk grade and ToolClassification. Empty lists and maps are left out. */
export function fromCodeClassification(
  risk: ToolRiskGrade,
  classification: ToolClassification,
): ToolsClassification {
  const out: ToolsClassification = {
    risk,
    side_effect: classification.sideEffect,
    egress: classification.egress,
  };
  if (classification.impacts.length > 0) out.impacts = [...classification.impacts];
  const names = Object.keys(classification.measures);
  if (names.length > 0) {
    const measures: Record<string, ToolsMeasure> = {};
    for (const name of names) {
      const measure = classification.measures[name];
      if (measure === undefined) continue;
      measures[name] = {
        path: measure.path,
        type: measure.type,
        ...(measure.currencyPath === undefined ? {} : { currency_path: measure.currencyPath }),
        ...(measure.unit === undefined ? {} : { unit: measure.unit }),
      };
    }
    out.measures = measures;
  }
  if (classification.dataClasses.length > 0) out.data_classes = [...classification.dataClasses];
  return out;
}

/**
 * The MCP annotations the gateway sends for a classification: readOnlyHint
 * for read, destructiveHint for irreversible, and openWorldHint for
 * third_party. The agent sees these, never the server's own hints.
 */
export function effectiveAnnotations(entry: Pick<ToolsEntry, "side_effect" | "egress">): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
} {
  return {
    readOnlyHint: entry.side_effect === "read",
    destructiveHint: entry.side_effect === "irreversible",
    openWorldHint: entry.egress === "third_party",
  };
}
