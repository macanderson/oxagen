import { z } from "zod";
import { Money } from "@/data/contracts/money";

const Amount = z.object({ due: Money });

export const ContractRate = z.object({ ratePerGau: Money });
export const InvoicePage = z.object({
  items: z.array(z.object({ amount: Amount })),
});
export const GauBucket = z.object({ usedGau: z.number(), topup: Amount });
export const PlanCard = z.object({ plan: z.string() });
