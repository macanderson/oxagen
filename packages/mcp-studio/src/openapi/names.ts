// names.ts: the tool key import suggests for each operation.
//
// The key comes from x-oxagen-tool.name when the operation sets one, else
// from the operationId in snake case, else from the method and the path's
// fixed segments: DELETE /pets/{petId} is delete_pets.
import { TOOL_KEY_MAX, toolKeySchema } from "../contract/primitives";

/** listPetPhotos is list_pet_photos, and HTTPStatus is http_status. */
export function snakeCase(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** A valid tool key from any text, or undefined when nothing usable is left. */
export function toolKeyFrom(text: string): string | undefined {
  let key = snakeCase(text);
  if (key === "") return undefined;
  if (/^[0-9]/.test(key)) key = `op_${key}`;
  key = key.slice(0, TOOL_KEY_MAX).replace(/_+$/, "");
  return toolKeySchema.safeParse(key).success ? key : undefined;
}

/** The key for an operation with no operationId: the method and the path's fixed segments. */
export function fallbackName(method: string, path: string): string {
  const fixed = path.split("/").filter((segment) => segment !== "" && !/^\{[^}]*\}$/.test(segment));
  return toolKeyFrom([method, ...fixed].join(" ")) ?? method.toLowerCase();
}

/** The keys taken so far. A second operation that wants a taken key gets _2, then _3. */
export class NameSet {
  private readonly used = new Set<string>();

  claim(base: string): string {
    let name = base;
    for (let n = 2; this.used.has(name); n += 1) {
      const suffix = `_${n}`;
      name = `${base.slice(0, TOOL_KEY_MAX - suffix.length).replace(/_+$/, "")}${suffix}`;
    }
    this.used.add(name);
    return name;
  }
}
