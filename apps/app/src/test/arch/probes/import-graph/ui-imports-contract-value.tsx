import { CostBasis } from "@/data/contracts/common";

export function Probe(): string[] {
  return [...CostBasis.options];
}
