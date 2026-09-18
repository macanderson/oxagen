import { Money } from "@/ui/money";

export function SummaryTiles({ micros }: { micros: string }) {
  return <Money value={{ micros, currency: "USD" }} precision="exact" />;
}
