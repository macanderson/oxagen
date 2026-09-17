import { kernelRead } from "@/server/kernel";

export async function read(): Promise<unknown> {
  return kernelRead;
}
