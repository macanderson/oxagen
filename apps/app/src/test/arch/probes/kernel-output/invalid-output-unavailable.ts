// The classifier names invalid_output, but answers it as a generic outage
// rather than the mismatch the app's own parse answers.
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
    case "invalid_input":
      return { kind: "invalid" };
    case "invalid_output":
      return { kind: "unavailable", code: "kernel_failure", status: 503 };
    default:
      return { kind: "unclassified" };
  }
}
