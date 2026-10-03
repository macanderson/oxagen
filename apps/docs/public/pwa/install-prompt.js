/*
 * The house install prompt: a small card that offers to put the site on the
 * home screen, the first time a person visits on a phone or tablet.
 *
 * One file, no dependencies, no build. Every Oxagen frontend loads this same
 * file; the oxagen monorepo vendors it with tools/scripts/sync-brand-assets.mjs.
 * Edit it here and re-sync, never in a product.
 *
 *   <script src="/install-prompt.js" defer
 *           data-icon="/pwa/icon-192.png"
 *           data-title="Add Oxagen to your home screen"></script>
 *
 * When it shows:
 *   - Android and Chromium: when the browser fires `beforeinstallprompt`, which
 *     it does only for an installable site. The card's button opens the
 *     browser's own install dialog.
 *   - iPhone and iPad Safari: Safari has no install API, so the card says where
 *     the command is: Share, then Add to Home Screen.
 *   - Never on a device with a mouse, never inside the installed app, never
 *     inside a frame, and never once the cookie below is set.
 *
 * The cookie is the only memory. Closing the card, answering the browser's
 * install dialog either way, or installing sets `ox_install_prompt` for a year.
 * Clearing cookies clears it, and the card shows again on the next visit.
 *
 * Every string can be replaced with a data attribute on the script tag, so a
 * product with a message catalogue passes its own translations:
 *   data-title, data-body, data-body-ios, data-install, data-dismiss, data-label
 */
/* global module, window */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root && root.document) api.start(root, root.document, root.document.currentScript);
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var COOKIE = "ox_install_prompt";
  var MAX_AGE = 60 * 60 * 24 * 365;
  /** How long Safari waits before the card appears, so it never covers first paint. */
  var IOS_DELAY_MS = 2500;

  var TEXT = {
    title: "Add Oxagen to your home screen",
    body: "Open it like an app, full screen, one tap away.",
    bodyIos: "Tap Share, then Add to Home Screen.",
    install: "Add to home screen",
    dismiss: "Not now",
    label: "Install this site",
  };

  /** True when the cookie that retires the card is set. */
  function dismissed(doc) {
    return (doc.cookie || "").split(";").some(function (part) {
      return part.trim().indexOf(COOKIE + "=") === 0;
    });
  }

  /** Retire the card for a year. `Secure` only where the page itself is. */
  function remember(doc, loc) {
    var secure = loc && loc.protocol === "https:" ? "; Secure" : "";
    doc.cookie = COOKIE + "=dismissed; Max-Age=" + MAX_AGE + "; Path=/; SameSite=Lax" + secure;
  }

  /** True inside the installed app, where offering to install it is noise. */
  function standalone(win) {
    if (win.navigator && win.navigator.standalone === true) return true;
    return !!(win.matchMedia && win.matchMedia("(display-mode: standalone)").matches);
  }

  /** A phone or a tablet: the primary pointer is a finger. */
  function touchDevice(win) {
    return !!(win.matchMedia && win.matchMedia("(pointer: coarse)").matches);
  }

  /**
   * iPhone or iPad Safari. iPadOS reports a Mac user agent, so a Mac that
   * takes touch is an iPad. Chrome, Firefox and Edge on iOS carry CriOS, FxiOS
   * and EdgiOS; since iOS 16.4 they can add to the home screen too, from the
   * same Share menu, so they get the same card.
   */
  function ios(nav) {
    var ua = nav.userAgent || "";
    if (/iPhone|iPad|iPod/.test(ua)) return true;
    return /Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1;
  }

  /**
   * True inside an iframe. A page that frames others (the roadmap site does)
   * loads this script in each frame too, and only the top page may offer.
   */
  function framed(win) {
    try {
      return !!win.top && win.top !== win;
    } catch {
      return true; // a cross-origin top refuses the read: still a frame
    }
  }

  /** Whether this visit may see the card at all, before any browser event. */
  function eligible(win, doc) {
    return !framed(win) && !dismissed(doc) && !standalone(win) && touchDevice(win);
  }

  function text(script) {
    var d = (script && script.dataset) || {};
    var out = {};
    for (var k in TEXT) out[k] = d[k] || TEXT[k];
    return out;
  }

  var SHARE =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';

  /* The house palette: obsidian and white with zinc between. The button is ink,
     not gold: gold is at most one action per screen, and the page under the
     card may already spend it. Gold stays the focus ring. The card follows the page's theme when it states one on <html>
     (class="dark", data-theme="dark"), otherwise the system's. */
  var CSS =
    ":host{all:initial}" +
    ".card{--bg:#FFFFFF;--fg:#09090B;--muted:#52525B;--line:#E4E4E7;--gold:#D4AF37;" +
    "position:fixed;z-index:2147483000;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));" +
    "margin:0 auto;max-width:380px;box-sizing:border-box;display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:start;" +
    "padding:14px;border-radius:14px;border:1px solid var(--line);background:var(--bg);color:var(--fg);" +
    "box-shadow:0 12px 32px rgba(9,9,11,.28);font:var(--ox-a-body, 0.875rem)/1.45 var(--ox-font, Aeonik),ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;" +
    "animation:rise .22s ease-out}" +
    ".card.dark{--bg:#18181B;--fg:#FAFAFA;--muted:#A1A1AA;--line:#27272A}" +
    "@media (prefers-reduced-motion:reduce){.card{animation:none}}" +
    "@keyframes rise{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}" +
    ".icon{width:40px;height:40px;border-radius:9px;display:block}" +
    ".title{margin:0;font-weight:600;font-size:var(--ox-a-body, 0.875rem)}" +
    ".body{margin:2px 0 0;color:var(--muted);font-size:var(--ox-a-body, 0.875rem)}" +
    ".body svg{vertical-align:-3px;margin:0 2px;color:var(--fg)}" +
    ".acts{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}" +
    "button{font:inherit;font-size:var(--ox-a-body, 0.875rem);font-weight:500;cursor:pointer;border-radius:8px;padding:7px 12px;border:1px solid var(--line);background:transparent;color:var(--fg)}" +
    "button.primary{background:var(--fg);border-color:var(--fg);color:var(--bg)}" +
    "button:focus-visible{outline:2px solid var(--gold);outline-offset:2px}" +
    "button.x{border:0;padding:4px;line-height:0;color:var(--muted)}";

  function darkPage(win, doc) {
    var html = doc.documentElement;
    var theme = html.getAttribute("data-theme");
    if (html.classList.contains("dark") || theme === "dark") return true;
    if (html.classList.contains("light") || theme === "light") return false;
    return !!(win.matchMedia && win.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /**
   * Draw the card. `install` is the browser's deferred prompt, or null on
   * Safari. Returns the host element so a caller can take it down.
   */
  function render(win, doc, t, icon, install) {
    var host = doc.createElement("div");
    host.setAttribute("data-ox-install-prompt", "");
    var shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var body = install ? esc(t.body) : esc(t.bodyIos).replace(/Share/, "Share " + SHARE);
    shadow.innerHTML =
      "<style>" + CSS + "</style>" +
      '<div class="card' + (darkPage(win, doc) ? " dark" : "") + '" role="dialog" aria-modal="false" aria-labelledby="ox-ip-t" aria-describedby="ox-ip-b">' +
      (icon ? '<img class="icon" src="' + esc(icon) + '" alt="">' : "<span></span>") +
      '<div><p class="title" id="ox-ip-t">' + esc(t.title) + '</p><p class="body" id="ox-ip-b">' + body + "</p>" +
      (install ? '<div class="acts"><button class="primary" data-act="install">' + esc(t.install) + "</button></div>" : "") +
      "</div>" +
      '<button class="x" data-act="dismiss" aria-label="' + esc(t.dismiss) + '" title="' + esc(t.dismiss) + '">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>' +
      "</div>";
    var close = function () {
      remember(doc, win.location);
      if (host.parentNode) host.parentNode.removeChild(host);
      doc.removeEventListener("keydown", onKey);
    };
    var onKey = function (e) {
      if (e.key === "Escape") close();
    };
    shadow.querySelector('[data-act="dismiss"]').addEventListener("click", close);
    var go = shadow.querySelector('[data-act="install"]');
    if (go) {
      go.addEventListener("click", function () {
        install.prompt();
        // Either answer retires the card: yes installs, no was an answer.
        Promise.resolve(install.userChoice).then(close, close);
      });
    }
    doc.addEventListener("keydown", onKey);
    doc.body.appendChild(host);
    return host;
  }

  /** Wire the card to this page. Safe to call before the body exists. */
  function start(win, doc, script) {
    if (!eligible(win, doc)) return;
    var t = text(script);
    var icon = script && script.dataset ? script.dataset.icon : "";
    var shown = null;
    var show = function (install) {
      if (shown || dismissed(doc) || standalone(win)) return;
      var draw = function () {
        shown = render(win, doc, t, icon, install);
      };
      if (doc.body) draw();
      else doc.addEventListener("DOMContentLoaded", draw);
    };
    win.addEventListener("beforeinstallprompt", function (e) {
      // Hold the browser's own mini-infobar back; the card offers instead.
      e.preventDefault();
      show(e);
    });
    win.addEventListener("appinstalled", function () {
      remember(doc, win.location);
      if (shown && shown.parentNode) shown.parentNode.removeChild(shown);
    });
    if (ios(win.navigator)) {
      win.setTimeout(function () {
        show(null);
      }, IOS_DELAY_MS);
    }
  }

  return {
    COOKIE: COOKIE,
    TEXT: TEXT,
    dismissed: dismissed,
    remember: remember,
    standalone: standalone,
    touchDevice: touchDevice,
    ios: ios,
    framed: framed,
    eligible: eligible,
    render: render,
    start: start,
  };
});
