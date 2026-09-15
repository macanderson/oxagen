// Probe for unrecorded.test.ts: a computed section, which INV-18 refuses.
export default function Page({ key }: { key: "agents" | "tools" }) {
  const section = key;
  return <NotRecorded section={section} />;
}
