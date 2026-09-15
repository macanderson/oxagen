import messages from "./messages/en.json";

export function Fallback() {
  const copy = messages.panel;
  return <p title={messages.app.name}>{copy.title}</p>;
}
