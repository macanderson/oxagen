// Hands the kernel's answer to the caller without parsing it by the contract.
import { invoke } from "@oxagen/oxagen/kernel";

type Contract = {
  name: string;
  output: { safeParse(value: unknown): { success: boolean } };
};

export async function kernelRead(contract: Contract, input: unknown) {
  const outcome = { ok: true, raw: await invoke(contract.name, input, {}) };
  return outcome.raw;
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
