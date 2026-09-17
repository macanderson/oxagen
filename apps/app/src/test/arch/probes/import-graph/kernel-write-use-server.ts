"use server";
import { kernelWrite } from "@/server/kernel";

export async function act(): Promise<unknown> {
  return kernelWrite;
}
