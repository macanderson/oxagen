/* ==========================================================================
   oxagen.sh — shared behaviour
   Nav, dropdown, drawer, reveal, copy, the typewriters, and the lead forms.
   Vanilla and dependency-free: the site has no build step.
   ========================================================================== */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  /* ---------- API base. Domain migration = change this one line. ---------- */
  var API_BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? "http://localhost:4000"
    : "https://api.oxagen.sh";
  var CMS_LEADS_URL = API_BASE + "/v1/cms/leads";

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
    return parts.length ? parts.join("&") : undefined;
  }

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
    .querySelectorAll(".nav-links a[href], .drop-menu a[href], .drawer a[href]")
    .forEach(function (a) {
      var href = a.getAttribute("href") || "";
      if (href.charAt(0) !== "/" || href.indexOf("#") === 0) {
        return;
      }
      var path = href.split("#")[0].replace(/\/$/, "") || "/";
      if (path === here && path !== "/") {
        a.setAttribute("aria-current", "page");
        var menu = a.closest(".drop-menu");
        if (menu) {
          var btn = menu.parentNode.querySelector(".drop-btn");
          if (btn) {
            btn.setAttribute("data-current", "true");
          }
        }
      }
    });

  /* ---------- nav: products dropdown ---------- */
  document.querySelectorAll(".drop").forEach(function (drop) {
    var btn = drop.querySelector(".drop-btn");
    var closeTimer = null;
    if (!btn) {
      return;
    }

    function open(state) {
      drop.setAttribute("data-open", state ? "true" : "false");
      btn.setAttribute("aria-expanded", state ? "true" : "false");
    }
    function scheduleClose() {
      closeTimer = setTimeout(function () {
        open(false);
      }, 160);
    }
    function cancelClose() {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
    }

    drop.addEventListener("mouseenter", function () {
      cancelClose();
      open(true);
    });
    drop.addEventListener("mouseleave", scheduleClose);
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      open(drop.getAttribute("data-open") !== "true");
    });
    // Only a focus landing *inside the menu* opens it — focusing the button
    // itself must not, or Escape's `btn.focus()` would reopen what it closed.
    drop.addEventListener("focusin", function (e) {
      if (!e.target.closest(".drop-menu")) {
        return;
      }
      cancelClose();
      open(true);
    });
    drop.addEventListener("focusout", function (e) {
      if (!drop.contains(e.relatedTarget)) {
        open(false);
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && drop.getAttribute("data-open") === "true") {
        open(false);
        btn.focus();
      }
    });
    document.addEventListener("click", function (e) {
      if (!drop.contains(e.target)) {
        open(false);
      }
    });
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

  /* ---------- ticker: duplicate the track for a seamless loop ---------- */
  document.querySelectorAll(".ticker-track").forEach(function (track) {
    track.innerHTML += track.innerHTML;
  });

  /* ---------- typewriter: one line, cycling through phrases ----------
     <span class="typed" data-typewriter="first|second"></span><span class="caret"></span>
     Types, holds, backspaces, moves on. Only runs while on screen, so a page
     of these costs nothing below the fold. */
  function cycleType(el) {
    var phrases = (el.getAttribute("data-typewriter") || "")
      .split("|")
      .filter(Boolean);
    if (!phrases.length) {
      return;
    }
    if (reduceMotion) {
      el.textContent = phrases[0];
      return;
    }

    var pi = 0,
      ci = 0,
      deleting = false,
      live = false,
      timer = null;

    function tick() {
      if (!live) {
        return;
      }
      var text = phrases[pi];
      if (!deleting) {
        ci += 1;
        el.textContent = text.slice(0, ci);
        if (ci >= text.length) {
          deleting = true;
          timer = setTimeout(tick, phrases.length > 1 ? 2600 : 1e9);
          return;
        }
        timer = setTimeout(tick, 34 + Math.random() * 46);
        return;
      }
      ci -= 1;
      el.textContent = text.slice(0, ci);
      if (ci <= 0) {
        deleting = false;
        pi = (pi + 1) % phrases.length;
        timer = setTimeout(tick, 420);
        return;
      }
      timer = setTimeout(tick, 16);
    }

    // Observe the PARENT, at threshold 0. An empty target has a zero-area box,
    // and a zero-area box never reaches a non-zero threshold — so observing the
    // span itself left every typewriter waiting for an intersection that could
    // not happen until it already had text.
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(
        function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting && !live) {
              live = true;
              tick();
            } else if (!e.isIntersecting) {
              live = false;
              clearTimeout(timer);
            }
          });
        },
        { threshold: 0 },
      ).observe(el.parentElement || el);
    } else {
      live = true;
      tick();
    }
  }
  document.querySelectorAll("[data-typewriter]").forEach(cycleType);

  /* ---------- terminal: a multi-line script that types and replays ----------
     <div class="term-body" data-term="#scriptId"></div>
     <script type="application/json" id="scriptId">[[{cls,text},...],...]</script> */
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

    var si = 0;
    (function play() {
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
          setTimeout(typeTick, 24 + Math.random() * 38);
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
            setTimeout(nextLine, li <= 2 ? 600 : 420);
            return;
          }
          var done = line("");
          done.innerHTML =
            '<span class="t-prompt">$ </span><span class="caret"></span>';
          setTimeout(play, 4400);
        })();
      })();
    })();
  }
  document.querySelectorAll("[data-term]").forEach(playTerminal);

  /* ---------- counters: a number that climbs into place ---------- */
  document.querySelectorAll("[data-count]").forEach(function (el) {
    var target = parseFloat(el.getAttribute("data-count"));
    var decimals = (el.getAttribute("data-decimals") || "0") | 0;
    if (isNaN(target)) {
      return;
    }
    if (reduceMotion || !("IntersectionObserver" in window)) {
      el.textContent = target.toFixed(decimals);
      return;
    }
    var started = false;
    new IntersectionObserver(
      function (entries, obs) {
        entries.forEach(function (e) {
          if (!e.isIntersecting || started) {
            return;
          }
          started = true;
          obs.disconnect();
          var t0 = performance.now(),
            dur = 1100;
          (function step(now) {
            var p = Math.min(1, (now - t0) / dur);
            var eased = 1 - Math.pow(1 - p, 3);
            el.textContent = (target * eased).toFixed(decimals);
            if (p < 1) {
              requestAnimationFrame(step);
            }
          })(t0);
        });
      },
      { threshold: 0.4 },
    ).observe(el);
  });

  /* ---------- deck: the tab strip, same shape as the one in the TUI ----------
     <div data-tabs>
       <div role="tablist"><button role="tab" aria-controls="panelId">…</button></div>
       <div role="tabpanel" id="panelId">…</div>
     </div>
     Arrow keys move, Home/End jump, and one panel is visible at a time. */
  document.querySelectorAll("[data-tabs]").forEach(function (deck) {
    var tabs = Array.prototype.slice.call(
      deck.querySelectorAll('[role="tab"]'),
    );
    if (!tabs.length) {
      return;
    }

    function select(idx, focus) {
      tabs.forEach(function (tab, i) {
        var on = i === idx;
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(tab.getAttribute("aria-controls"));
        if (panel) {
          panel.hidden = !on;
        }
      });
      if (focus) {
        tabs[idx].focus();
      }
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () {
        select(i);
      });
      tab.addEventListener("keydown", function (e) {
        var next = null;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          next = (i + 1) % tabs.length;
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          next = (i - 1 + tabs.length) % tabs.length;
        } else if (e.key === "Home") {
          next = 0;
        } else if (e.key === "End") {
          next = tabs.length - 1;
        }
        if (next !== null) {
          e.preventDefault();
          select(next, true);
        }
      });
    });

    var initial = tabs.findIndex(function (t) {
      return t.getAttribute("aria-selected") === "true";
    });
    select(initial === -1 ? 0 : initial);
  });

  /* ---------- copy buttons ---------- */
  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var txt = btn.getAttribute("data-copy") || "";
      var label = btn.querySelector("span");
      var done = function () {
        label.textContent = "Copied";
        setTimeout(function () {
          label.textContent = "Copy";
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done, done);
      } else {
        done();
      }
    });
  });

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
    'Something went wrong. Try again, or email <a href="mailto:success@oxagen.ai">success@oxagen.ai</a>.';

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
      fetch(CMS_LEADS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          if (!res.ok && res.status !== 204) {
            throw new Error("status " + res.status);
          }
          form.reset();
          setStatus(form, "Thanks — we got it. We'll be in touch shortly. ✓");
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
      fetch(CMS_LEADS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          return res.json().then(function (data) {
            return { status: res.status, data: data };
          });
        })
        .then(function (r) {
          var data = r.data || {};
          if (r.status >= 200 && r.status < 300 && data.ok) {
            form.reset();
            setStatus(form, "");
            form.hidden = true;
            if (successMsg) {
              successMsg.textContent =
                data.message ||
                "The link to the book has been sent to your email.";
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
