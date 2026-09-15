/** A text field from FormData; a missing field or a file reads as the empty string. */
export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
