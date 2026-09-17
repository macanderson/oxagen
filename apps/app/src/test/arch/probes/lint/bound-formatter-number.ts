import { getFormatter } from "next-intl/server";

export async function figure(): Promise<string> {
  const format = await getFormatter();
  return format.number(1500);
}
