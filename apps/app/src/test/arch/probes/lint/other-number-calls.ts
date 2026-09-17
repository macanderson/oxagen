import { getFormatter } from "next-intl/server";
import { z } from "zod";

// A zod schema and a date format are not number formatting.
export const Quantity = z.number().int();

export async function when(at: Date): Promise<string> {
  const format = await getFormatter();
  return format.dateTime(at, { dateStyle: "medium" });
}
