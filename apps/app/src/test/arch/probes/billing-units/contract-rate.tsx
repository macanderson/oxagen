import { Money } from "@/ui/money";

export function ContractRateBlock({ micros }: { micros: string }) {
  return <Money value={{ micros, currency: "USD" }} precision="exact" />;
}
