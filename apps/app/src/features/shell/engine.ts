// How the assistant reads its engine's health. Any failed read is the engine
// being unreachable from where the operator sits, so it renders as "down" with
// the failure named: the assistant never pretends to be ready (plan W9).
import type { Read } from "@/data/not-backed";
import type { AssistantEngine } from "@/data/contracts/shell";

export type EngineView =
  | { state: "up"; model: string; version: string }
  | {
      state: "down";
      reason: "engine";
      httpStatus: number;
      version: string | null;
      lastHealthyAt: string | null;
    }
  | { state: "down"; reason: "read"; code: string; status: number };

export function engineView(read: Read<AssistantEngine>): EngineView {
  if (read.ok) {
    const e = read.value;
    if (e.status === "up")
      return { state: "up", model: e.model, version: e.version };
    return {
      state: "down",
      reason: "engine",
      httpStatus: e.httpStatus,
      version: e.version,
      lastHealthyAt: e.lastHealthyAt,
    };
  }
  switch (read.reason) {
    case "error":
      return {
        state: "down",
        reason: "read",
        code: read.code,
        status: read.status,
      };
    case "denied":
      return { state: "down", reason: "read", code: "denied", status: 403 };
    case "not_backed":
      return {
        state: "down",
        reason: "read",
        code: `not_backed_${read.gap}`,
        status: 501,
      };
  }
}
