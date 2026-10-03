// The classifier names invalid_output but leaves invalid_input to the default,
// so a refused input reads as an outage.
import { invoke } from "@oxagen/oxagen/kernel";

type Contract = {
  name: string;
  output: { safeParse(value: unknown): { success: boolean; data?: unknown } };
};

export async function kernelRead(contract: Contract, input: unknown) {
  const outcome = { ok: true, raw: await invoke(contract.name, input, {}) };
  const output = contract.output.safeParse(outcome.raw);
  if (!output.success) {
    return { ok: false, code: "contract_output_mismatch", status: 502 };
  }
  return { ok: true, value: output.data };
}

function classifyKernelFailure(code: string) {
  switch (code) {
    case "invalid_output":
      return { code: "contract_output_mismatch", status: 502 };
    default:
      return { kind: "unclassified" };
  }
}
