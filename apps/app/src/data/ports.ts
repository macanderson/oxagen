// The typed list of reads a page may make (ARCHITECTURE.md §3.3). Every method
// takes the viewer's ctx and returns a `Read<T>`, and every method has a
// production caller (INV-17). The rev1 ports land with the seams and pages
// that bind them: `shell.context` in WL-11, `pretenant` in WL-12, and the
// Fleet, Run, Organization and Billing ports in WL-34 to WL-38. Until then
// the source is empty: no page reads anything.
export type DataSource = Record<never, never>;
