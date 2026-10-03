// The classifier names invalid_input but leaves invalid_output to the default,
// so an answer the kernel's own output check refused is unclassified.
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
    default:
      return { kind: "unclassified" };
  }
}
