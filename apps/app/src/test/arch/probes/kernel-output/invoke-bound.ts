// Binds the kernel's answer to a name before the contract parses it, so the
// unparsed value is one return statement away from a caller.
import { invoke } from "@oxagen/oxagen/kernel";

type Contract = {
  name: string;
  output: { safeParse(value: unknown): { success: boolean } };
};

export async function kernelRead(contract: Contract, input: unknown) {
  const value = await invoke(contract.name, input, {});
  return contract.output.safeParse(value);
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
