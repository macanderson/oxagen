import { Money } from "@/ui/money";

export function AutoTopup({ micros }: { micros: string }) {
  return <Money value={{ micros, currency: "USD" }}></Money>;
}
