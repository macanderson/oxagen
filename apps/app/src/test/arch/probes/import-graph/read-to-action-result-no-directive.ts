import { readToActionResult } from "@/server/kernel";

export async function map(): Promise<unknown> {
  return readToActionResult;
}
