# #3697 update prompt

Captured 2026-09-25 on branch `fix/desktop-updater-fonts-entitlements`.

`update-prompt.png` is the desktop UI served by `vite` and opened in headless
Chromium at 600 by 760. The desktop app itself was not launched, because this
machine runs a live enrollment. A stub `window.__TAURI_INTERNALS__` answered
two calls: `desktop_state` with version 2.1.1, and `plugin:updater|check` with
version 2.2.0. The next poll read the state, the update watch started, read
the stubbed feed, and showed the prompt. The masthead shows Install beside
"v2.2.0 available". The red banner is left from the page load before the
stub was in place.

Nothing was installed or relaunched: the stub has no download command, and
the watch never asks for one.

Not verified here: an installed, signed app left open while a release
publishes to `desktop-latest`. That needs a signed build and a feed entry.
