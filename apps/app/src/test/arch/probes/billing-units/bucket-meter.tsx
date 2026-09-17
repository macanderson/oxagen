import { Money } from "@/ui/money";

export function BucketMeter({ micros }: { micros: string }) {
  return <Money value={{ micros, currency: "USD" }} />;
}
