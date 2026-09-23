/* ==========================================================================
   oxagen.sh — shared behaviour
   Nav, drawer, reveal, live figures, the terminal, and the lead forms.
   Vanilla and dependency-free: this file ships to the browser byte-for-byte.
   The site's build (scripts/build.mjs) only assembles pages into dist/; it
   never bundles, transpiles or touches this file.
   ========================================================================== */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  /* ---------- API base. /read/index.html carries its own copy of this, so a
     domain migration is these two lines, not one. ---------- */
  var API_BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? "http://localhost:4000"
    : "https://api.oxagen.sh";
  var CMS_LEADS_URL = API_BASE + "/v1/cms/leads";

  /* Lead posts are bounded, matching /read's postJson(). A connection the API
     accepts but never answers would otherwise leave the submit button
     disabled for good; aborting rejects the promise into each form's catch,
     which re-enables the button and shows the retry message. The timer keeps
     running after the headers arrive so it also bounds a stalled body. */
  var REQUEST_TIMEOUT_MS = 15000;
  function postLead(payload) {
    var controller =
      typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller
      ? setTimeout(function () {
          controller.abort();
        }, REQUEST_TIMEOUT_MS)
      : null;
    return fetch(CMS_LEADS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  /* The API caps trackingCode at 500 characters and rejects the whole lead if
     it is longer, so a campaign URL with a long utm_content would otherwise
     lose the lead rather than the attribution. Truncate here instead. */
  var TRACKING_CODE_MAX = 500;

  function buildTrackingCode() {
    var qs = new URLSearchParams(location.search);
    var keys = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "tc",
      "tracking_code",
    ];
    var parts = [];
    keys.forEach(function (k) {
      var v = qs.get(k);
      if (v) {
        parts.push(k + "=" + v);
      }
    });
    return parts.length
      ? parts.join("&").slice(0, TRACKING_CODE_MAX)
      : undefined;
  }

  /* ---------- theme: the footer's System / Light / Dark control. The head
     script already stamped <html data-theme> before first paint; this keeps
     it current. The choice lives in localStorage under "theme", the same key
     and values next-themes uses on docs.oxagen.sh. "system" follows the OS,
     live, so a change in the OS setting repaints the page without a reload.
     ---------- */
  var THEME_KEY = "theme";
  var THEMES = ["system", "light", "dark"];
  var osLight = window.matchMedia("(prefers-color-scheme: light)");
  var root = document.documentElement;
  /* The latest choice this page knows of: a click here, or another tab's
     change. It outranks storage, so a write the browser refused cannot hand
     back an older value than the control shows. */
  var pageChoice = null;
  /* The browser bar's colour for each theme: the ground on paper and on ink,
     the same values as the theme-color meta tags in the head. */
  var BAR = { light: "#FFFFFF", dark: "#09090B" };

  function readTheme() {
    if (THEMES.indexOf(pageChoice) !== -1) return pageChoice;
    var v = null;
    try {
      v = localStorage.getItem(THEME_KEY);
    } catch (e) {
      /* storage blocked: the page follows the OS until a click */
    }
    return THEMES.indexOf(v) === -1 ? "system" : v;
  }

  /* The choice this page shows. It is held here as well as in storage, so a
     choice still holds for this page view when storage refuses the write:
     the arrow keys step from it and an OS change does not undo it. */
  var current = readTheme();

  function applyTheme(choice) {
    current = choice;
    var resolved =
      choice === "system" ? (osLight.matches ? "light" : "dark") : choice;
    /* No transition runs during the swap, or every hover colour would fade
       across at its own speed. */
    root.classList.add("theme-swap");
    root.setAttribute("data-theme", resolved);
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = resolved;
    /* Each theme-color tag answers one OS preference. A pinned theme sets
       both to its own colour, so the bar matches the page whichever the OS
       prefers; System puts each back to its own. */
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
      var own = /light/.test(m.media) ? BAR.light : BAR.dark;
      m.content = choice === "system" ? own : BAR[resolved];
    });
    void root.offsetWidth;
    root.classList.remove("theme-swap");
    document.querySelectorAll("[data-theme-choice]").forEach(function (b) {
      var on = b.getAttribute("data-theme-choice") === choice;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  document.querySelectorAll("[data-theme-choice]").forEach(function (b) {
    b.addEventListener("click", function () {
      var choice = b.getAttribute("data-theme-choice");
      pageChoice = choice;
      try {
        localStorage.setItem(THEME_KEY, choice);
      } catch (e) {
        /* the choice holds for this page view only, in `current` */
      }
      applyTheme(choice);
    });
  });
  /* Arrow keys move the choice, as they do in any radio group. */
  document.querySelectorAll(".theme-switch").forEach(function (group) {
    group.addEventListener("keydown", function (e) {
      var step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
        e.key
      ];
      if (!step) return;
      e.preventDefault();
      var buttons = group.querySelectorAll("[data-theme-choice]");
      var at = THEMES.indexOf(current);
      var next = buttons[(at + step + buttons.length) % buttons.length];
      next.focus();
      next.click();
    });
  });
  osLight.addEventListener("change", function () {
    if (current === "system") applyTheme("system");
  });
  /* Another tab changed the choice. */
  window.addEventListener("storage", function (e) {
    if (e.key !== THEME_KEY) return;
    pageChoice = e.newValue;
    applyTheme(readTheme());
  });
  applyTheme(current);

  /* ---------- nav: scrolled state ---------- */
  var nav = document.getElementById("nav");
  if (nav) {
    var onScroll = function () {
      nav.classList.toggle("scrolled", window.scrollY > 8);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ---------- nav: mark the page we are on ---------- */
  var here = location.pathname.replace(/\/$/, "") || "/";
  document
    .querySelectorAll(".nav-links a[href], .drawer a[href]")
    .forEach(function (a) {
      var href = a.getAttribute("href") || "";
      if (href.charAt(0) !== "/" || href.indexOf("#") === 0) {
        return;
      }
      var path = href.split("#")[0].replace(/\/$/, "") || "/";
      if (path === here && path !== "/") {
        a.setAttribute("aria-current", "page");
      }
    });

  /* ---------- nav: mobile drawer ---------- */
  var burger = document.getElementById("burger");
  var drawer = document.getElementById("drawer");
  if (burger && drawer) {
    burger.addEventListener("click", function () {
      var next = drawer.getAttribute("data-open") !== "true";
      drawer.setAttribute("data-open", next ? "true" : "false");
      burger.setAttribute("aria-expanded", next ? "true" : "false");
    });
    drawer.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        drawer.setAttribute("data-open", "false");
        burger.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------- reveal on scroll ---------- */
  var revealEls = Array.prototype.slice.call(
    document.querySelectorAll(".reveal"),
  );
  if ("IntersectionObserver" in window && !reduceMotion) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add("in-view");
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    revealEls.forEach(function (el) {
      io.observe(el);
    });
  } else {
    revealEls.forEach(function (el) {
      el.classList.add("in-view");
    });
  }

  /* ---------- live figures: a loop runs only while it is on screen ----------
     <figure class="dg" data-live> ... <span class="dg-loop"></span></figure>
     The CSS pauses every .dg-loop until its host carries .playing, so a figure
     below the fold, or any figure under reduced motion, costs nothing. */
  var liveEls = document.querySelectorAll("[data-live]");
  if (liveEls.length && "IntersectionObserver" in window && !reduceMotion) {
    var liveIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        e.target.classList.toggle("playing", e.isIntersecting);
      });
    });
    Array.prototype.forEach.call(liveEls, function (el) {
      liveIo.observe(el);
    });
  }

  /* ---------- terminal: a multi-line script that types and replays ----------
     <div class="term-body" data-term="#scriptId"></div>
     <script type="application/json" id="scriptId">[[{cls,text},...],...]</script>
     The site has one of these, on the home page. The replay never ends, so it
     only runs while the terminal is on screen. Otherwise it would keep a timer
     firing every few tens of milliseconds for the whole life of the tab. */
  function playTerminal(body) {
    var srcSel = body.getAttribute("data-term");
    var src = srcSel && document.querySelector(srcSel);
    if (!src) {
      return;
    }
    var SCRIPTS;
    try {
      SCRIPTS = JSON.parse(src.textContent);
    } catch (_) {
      return;
    }
    if (!SCRIPTS || !SCRIPTS.length) {
      return;
    }

    function line(cls) {
      var el = document.createElement("div");
      el.className = "term-line " + (cls === "cmd" ? "" : cls);
      body.appendChild(el);
      return el;
    }
    function renderStatic(script) {
      body.innerHTML = "";
      script.forEach(function (row) {
        var el = line(row.cls);
        if (row.cls === "cmd") {
          el.innerHTML =
            '<span class="t-prompt">$ </span><span class="t-cmd"></span>';
          el.querySelector(".t-cmd").textContent = row.text;
        } else {
          el.textContent = row.text;
        }
      });
    }

    if (reduceMotion) {
      renderStatic(SCRIPTS[0]);
      return;
    }

    var si = 0,
      timer = null;

    // Every step of the replay is scheduled through here, so leaving the screen
    // only has to clear one handle to stop the whole chain.
    function wait(fn, ms) {
      timer = setTimeout(fn, ms);
    }

    function play() {
      body.innerHTML = "";
      var script = SCRIPTS[si];
      si = (si + 1) % SCRIPTS.length;

      var cmdLine = line("cmd");
      cmdLine.innerHTML =
        '<span class="t-prompt">$ </span><span class="t-cmd"></span><span class="caret"></span>';
      var cmdSpan = cmdLine.querySelector(".t-cmd");
      var caret = cmdLine.querySelector(".caret");
      var text = script[0].text;
      var ci = 0;

      (function typeTick() {
        if (ci <= text.length) {
          cmdSpan.textContent = text.slice(0, ci);
          ci += 1;
          wait(typeTick, 24 + Math.random() * 38);
          return;
        }
        caret.remove();
        var li = 1;
        (function nextLine() {
          if (li < script.length) {
            var el = line(script[li].cls);
            el.textContent = script[li].text;
            el.style.opacity = "0";
            el.style.transition = "opacity .28s";
            requestAnimationFrame(function () {
              el.style.opacity = "1";
            });
            li += 1;
            wait(nextLine, li <= 2 ? 600 : 420);
            return;
          }
          var done = line("");
          done.innerHTML =
            '<span class="t-prompt">$ </span><span class="caret"></span>';
          wait(play, 4400);
        })();
      })();
    }

    // Scrolling away stops the chain; scrolling back starts the next script
    // from the top, so the terminal is never caught mid-line.
    if ("IntersectionObserver" in window) {
      var running = false;
      new IntersectionObserver(
        function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting && !running) {
              running = true;
              play();
            } else if (!e.isIntersecting && running) {
              running = false;
              clearTimeout(timer);
            }
          });
        },
        { threshold: 0 },
      ).observe(body);
    } else {
      play();
    }
  }
  document.querySelectorAll("[data-term]").forEach(playTerminal);

  /* ---------- lead forms ---------- */
  function setStatus(form, msg, isErr) {
    var status = form.querySelector(".form-status");
    if (!status) {
      return;
    }
    status.innerHTML = msg;
    status.classList.toggle("err", !!isErr);
  }

  function basePayload(form) {
    var fd = new FormData(form);
    var fullName = String(fd.get("name") || "").trim();
    var spaceIdx = fullName.indexOf(" ");
    var firstName = spaceIdx === -1 ? fullName : fullName.slice(0, spaceIdx);
    var lastName = spaceIdx === -1 ? "" : fullName.slice(spaceIdx + 1).trim();
    var payload = {
      firstName: firstName,
      lastName: lastName || firstName,
      email: String(fd.get("email") || "")
        .trim()
        .toLowerCase(),
      source: form.getAttribute("data-source"),
      pagePath: location.pathname + location.search + location.hash,
      website: String(fd.get("website") || ""),
    };
    var trackingCode = buildTrackingCode();
    if (trackingCode) {
      payload.trackingCode = trackingCode;
    }
    var company = String(fd.get("company") || "").trim();
    if (company) {
      payload.company = company;
    }
    var role = String(fd.get("role") || "").trim();
    if (role) {
      payload.jobTitle = role;
    }
    var message = String(fd.get("message") || "").trim();
    if (message) {
      payload.message = message;
    }
    return payload;
  }

  var FAIL =
    'The form did not send. Try again, or email <a href="mailto:success@oxagen.sh">success@oxagen.sh</a>.';

  /* demo / contact forms: the lead lands in cms.leads, no book code minted. */
  function wireForm(form) {
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var btn = form.querySelector('button[type="submit"]');
      if (!form.reportValidity()) {
        return;
      }

      var payload = basePayload(form);
      payload.intent = "demo";

      btn.disabled = true;
      setStatus(form, "Sending…");
      postLead(payload)
        .then(function (res) {
          if (!res.ok) {
            throw new Error("status " + res.status);
          }
          form.reset();
          setStatus(
            form,
            "Thanks. Oxagen has your note and will email you soon.",
          );
          btn.disabled = false;
        })
        .catch(function () {
          btn.disabled = false;
          setStatus(form, FAIL, true);
        });
    });
  }

  /* field-manual gate: success never reveals a link — the server emails one. */
  function wireManualForm(form) {
    var successPanel = document.getElementById("manualSuccess");
    var successMsg = document.getElementById("manualSuccessMsg");

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var btn = form.querySelector('button[type="submit"]');
      if (!form.reportValidity()) {
        return;
      }

      var payload = basePayload(form);
      payload.source = "field-manual";

      btn.disabled = true;
      setStatus(form, "Sending…");
      postLead(payload)
        .then(function (res) {
          return res.json().then(function (data) {
            return { status: res.status, data: data };
          });
        })
        .then(function (r) {
          var data = r.data || {};
          if (
            r.status >= 200 &&
            r.status < 300 &&
            data.ok &&
            data.delivered !== false
          ) {
            form.reset();
            setStatus(form, "");
            form.hidden = true;
            if (successMsg) {
              successMsg.textContent =
                data.message || "The link to the book is in your email.";
            }
            if (successPanel) {
              successPanel.hidden = false;
              successPanel.classList.add("in-view");
              try {
                successPanel.focus();
              } catch (_) {
                /* ignore */
              }
            }
          } else if (r.status >= 200 && r.status < 300 && data.ok) {
            /* The lead is saved but the email failed to send (data.delivered
               === false). Keep the form visible and re-enabled so a retry
               submits again, rather than hiding it behind a success panel
               over a link that never went out. The homepage has no resend
               control, so re-submitting the form is the retry path. */
            btn.disabled = false;
            setStatus(
              form,
              data.message ||
                "Oxagen saved your details, but the email did not send. Submit the form again.",
              true,
            );
          } else {
            btn.disabled = false;
            setStatus(form, FAIL, true);
          }
        })
        .catch(function () {
          btn.disabled = false;
          setStatus(form, FAIL, true);
        });
    });
  }

  var manualForm = document.getElementById("manualForm");
  if (manualForm) {
    wireManualForm(manualForm);
  }
  document
    .querySelectorAll("form.lead-form:not(#manualForm)")
    .forEach(wireForm);
})();
