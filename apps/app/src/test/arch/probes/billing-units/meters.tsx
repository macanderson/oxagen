import { Money } from "@/ui/money";

export function Meters({ micros }: { micros: string }) {
  return <Money value={{ micros, currency: "USD" }} />;
}
