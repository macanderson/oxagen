// Every enum value a primitive renders has its copy in messages/ui.json, so a
// new value in src/data/contracts cannot ship as a raw message key.
import { describe, expect, it } from "vitest";
import ui from "../../messages/ui.json";
import {
  CostBasis,
  EnforcementTier,
  RecordKind,
  ReplayGrade,
  Risk,
  SideEffect,
  Verdict,
} from "@/data/contracts/common";
import {
  AgentStatus,
  GateDecision,
  PrincipalKind,
  RunStatus,
  ToolCategory,
} from "./vocabulary";

const catalog = ui.ui as unknown as Record<
  string,
  Record<string, { label?: unknown; description?: unknown }>
>;

const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["basis", CostBasis.options],
  ["tier", EnforcementTier.options],
  ["grade", ReplayGrade.options],
  ["verdict", Verdict.options],
  ["status", [...RunStatus.options, ...AgentStatus.options]],
  ["risk", Risk.options],
  ["effect", SideEffect.options],
  ["gate", GateDecision.options],
  ["toolCategory", ToolCategory.options],
  ["recordKind", RecordKind.options],
  ["principalKind", PrincipalKind.options],
];

describe("messages/ui.json", () => {
  it.each(cases)(
    "has a label and description for every %s value",
    (namespace, values) => {
      for (const value of values) {
        const entry = catalog[namespace]?.[value];
        expect(entry, `${namespace}.${value}`).toBeDefined();
        expect(typeof entry?.label, `${namespace}.${value}.label`).toBe(
          "string",
        );
        expect(
          typeof entry?.description,
          `${namespace}.${value}.description`,
        ).toBe("string");
      }
    },
  );
});
