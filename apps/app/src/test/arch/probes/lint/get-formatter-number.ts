import { getFormatter } from "next-intl/server";

export async function figure(): Promise<string> {
  return (await getFormatter()).number(1500);
}
