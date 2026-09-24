// A real jsdom window standing in for the OAuth popup (#4132): an iframe's
// window, so `window.open` can return it with its own type. Its `close` is a
// spy. Navigation is `navigatePopup` from @/ui/navigation, which a test mocks,
// because jsdom does not navigate a window.
import { vi } from "vitest";

export function stubPopup() {
  const frame = document.createElement("iframe");
  frame.title = "OAuth sign-in";
  document.body.append(frame);
  const win = frame.contentWindow;
  if (win === null) throw new Error("no popup window");
  const close = vi.spyOn(win, "close").mockImplementation(() => undefined);
  const open = vi.spyOn(window, "open").mockReturnValue(win);
  return {
    win,
    close,
    open,
    remove: () => {
      frame.remove();
    },
  };
}
