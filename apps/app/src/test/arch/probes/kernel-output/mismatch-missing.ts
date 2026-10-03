// Parses the answer, but a rejected answer comes back as the generic kernel
// failure rather than contract_output_mismatch with status 502.
import { invoke } from "@oxagen/oxagen/kernel";

type Contract = {
  name: string;
  output: { safeParse(value: unknown): { success: boolean; data?: unknown } };
};

export async function kernelRead(contract: Contract, input: unknown) {
  const outcome = { ok: true, raw: await invoke(contract.name, input, {}) };
  const output = contract.output.safeParse(outcome.raw);
  if (!output.success) return { ok: false, code: "kernel_failure", status: 500 };
  return { ok: true, value: output.data };
}

function classifyKernelFailure(code: string) {
  switch (code) {
    case "invalid_input":
      return { kind: "invalid" };
    case "invalid_output":
      return { code: "contract_output_mismatch", status: 502 };
    default:
      return { kind: "unclassified" };
  }
}
