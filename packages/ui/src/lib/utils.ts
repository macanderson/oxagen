import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { houseTypeMerge } from "./house-type-merge";

/** tailwind-merge that knows the house type utilities (see house-type-merge.ts). */
const twMerge = extendTailwindMerge(houseTypeMerge);

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
