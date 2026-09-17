import { useFormatter } from "next-intl";

export function useFigure(): string {
  const { number } = useFormatter();
  return number(1500);
}
