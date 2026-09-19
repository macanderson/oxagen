import { storage } from "@oxagen/storage";

export function adapter(): unknown {
  return storage();
}
