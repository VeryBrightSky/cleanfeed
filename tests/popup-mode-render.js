/* CleanFeed v1.5.0-fix1 — popup mode-dropdown shipping render test.
 *
 * The v1.5.0-phase2 "thumbnail Grayscale + Hover-only blur" feature was
 * verified via tests/thumbnail-variants.js, but that suite only asserted
 * the storage shape, _effectiveModeFor() coercion, and the static
 * _BLOCKER_MODE_OPTIONS table values. NONE of it confirmed that
 * renderModeDropdown actually emits the right number of <option>
 * elements into the real DOM tree at popup render time.
 *
 * This is the gap that allowed a "popup only shows 3 modes" report to
 * land post-ship without the existing test suite catching it. (The code
 * was correct — jsdom proves 5 options render — but without an actual
 * DOM-level shipping test the report was unfalsifiable from CI.)
 *
 * Shipping-render asserts (all against jsdom-rendered popup.html with
 * the production popup.js):
 *
 *   1. Popup initialises without throwing and renders the blocker grid.
 *   2. Every <select id="mode-{blockerId}"> exists in the DOM for every
 *      blocker that participates in mode dropdowns (i.e., all blockers
 *      except autoplay, which has no DOM target).
 *   3. mode-thumbnails has exactly 5 <option> children with values
 *      ["hide","blur","dim","grayscale","hover-blur"] in that order.
 *   4. Every other mode dropdown has exactly 3 <option> children with
 *      values ["hide","blur","dim"] in that order.
 *   5. The data-options-count attribute matches the live option count
 *      (defensive — closes the door on a future re-render mismatch).
 *
 * Run with:  node tests/popup-mode-render.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}\n    expected: ${e}\n    actual:   ${a}`); }
}
function assertTrue(name, cond) {
  if (cond) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}`); }
}

// jsdom is installed in /tmp/sub-repro/node_modules; resolve via that path.
let JSDOM;
try {
  JSDOM = require("/tmp/sub-repro/node_modules/jsdom").JSDOM;
} catch (_) {
  console.log("POPUP MODE RENDER: jsdom not available, skipping (install via `cd /tmp/sub-repro && npm install jsdom`)");
  console.log("SKIPPED — environment-dependent");
  process.exit(0);
}

const POPUP_DIR = path.join(__dirname, "..", "popup");
const html = fs.readFileSync(path.join(POPUP_DIR, "popup.html"), "utf8");

// Production popup.js — shipped exactly as users get it.
const popupJs = fs.readFileSync(path.join(POPUP_DIR, "popup.js"), "utf8");

function bootPopup({ paid = true, blockerModes = {} } = {}) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "chrome-extension://abc/popup/popup.html",
  });
  const { window } = dom;
  const { document } = window;
  const sent = [];
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) { sent.push(msg); if (typeof cb === "function") setTimeout(() => cb({ ok: true }), 0); },
      getManifest() { return { version: "1.5.0.3" }; },
      getURL(p) { return "chrome-extension://abc/" + p; },
      onMessage: { addListener() {} },
      openOptionsPage() {},
    },
    storage: {
      local: {
        _data: {
          settings: {
            "home-feed": true, "shorts": true,
            "watch-sidebar": true, "end-screen": true, "comments": true,
            "explore": true, "live-chat": true, "autoplay": true,
            "thumbnails": true, "subs-algo": true,
            "playables": true, "merch-shelf": true,
            "breaking-news": true, "mixes-playlists": true,
            "subs-most-relevant": true, "subs-members-only": true, "subs-watched": true,
          },
          paid: paid,
          cf_initialized: true,
          onboardingComplete: true,
          focusLock: { activeUntil: 0 },
          cf_grandfathered: paid,
          cf_grandfathered_reason: paid ? "license_key" : null,
          cleanfeed_license: paid ? { active: true, key: "DEMO" } : null,
          cf_subscription: { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 },
          cf_stats: { blocked: {}, autoplay_avoided: {}, session_started: 0 },
          usageCount: 0,
          reviewPromptShown: true,
          sessionStats: { total: 0, perBlocker: {} },
          timeTracking: {},
          pausedUntil: 0,
          whitelistedChannels: [],
          customCSS: "",
          blockerModes: blockerModes,
          redirectHomeToSubs: false,
          perPageEnabled: false,
          perPageSettings: { homepage: {}, watch: {}, subscriptions: {} },
        },
        get(keys, cb) {
          const out = {};
          const list = Array.isArray(keys) ? keys : (keys ? [keys].flat() : Object.keys(this._data));
          for (const k of list) if (k in this._data) out[k] = this._data[k];
          if (typeof cb === "function") setTimeout(() => cb(out), 0);
          else return Promise.resolve(out);
        },
        set(patch, cb) {
          for (const k of Object.keys(patch)) this._data[k] = patch[k];
          if (typeof cb === "function") setTimeout(cb, 0);
          else return Promise.resolve();
        },
        remove(_, cb) { if (cb) cb(); else return Promise.resolve(); },
      },
      sync: { get(_, cb) { cb({}); }, set(_, cb) { if (cb) cb(); } },
      onChanged: { addListener() {}, removeListener() {} },
    },
    tabs: { query(_, cb) { cb([]); } },
  };
  window.eval(popupJs);
  return { window, document, sent };
}

// Blocker ids in popup.js order. Autoplay has no DOM target (JS handler
// only) so it doesn't get a mode dropdown rendered.
const BLOCKERS_WITH_DROPDOWN = [
  "home-feed", "shorts", "watch-sidebar", "end-screen", "comments",
  "explore", "live-chat", /* "autoplay" — SKIP */ "thumbnails", "subs-algo",
  "playables", "merch-shelf", "breaking-news", "mixes-playlists",
  "subs-most-relevant", "subs-members-only", "subs-watched",
];

(async () => {
  // ===== 1. Popup initialises + renders all expected dropdowns ==========

  const { document } = bootPopup();
  // Wait for async init() to finish.
  await new Promise((r) => setTimeout(r, 300));
  await new Promise((r) => setTimeout(r, 100));

  for (const id of BLOCKERS_WITH_DROPDOWN) {
    const sel = document.getElementById("mode-" + id);
    assertTrue(`1.${id}) <select id="mode-${id}"> exists in DOM`, !!sel);
    if (sel) {
      assertEq(`1.${id}) is a <select> element`,
        sel.tagName, "SELECT");
    }
  }

  // ===== 2. mode-thumbnails has EXACTLY 5 options in canonical order ====
  //
  // The exact regression sentinel for the v1.5.0-fix1 bug report
  // ("only Hide / Blur / Dim, Grayscale + Hover-only blur MISSING").
  // If this assertion ever fires, the user-reported observation IS real
  // and the renderModeDropdown lookup against _BLOCKER_MODE_OPTIONS has
  // broken.

  const thumbs = document.getElementById("mode-thumbnails");
  assertTrue("2a) mode-thumbnails select present", !!thumbs);
  if (thumbs) {
    assertEq("2b) mode-thumbnails has exactly 5 <option> elements",
      thumbs.options.length, 5);
    const values = [];
    for (let i = 0; i < thumbs.options.length; i++) {
      values.push(thumbs.options[i].value);
    }
    assertEq("2c) mode-thumbnails option order: hide, blur, dim, grayscale, hover-blur",
      values, ["hide", "blur", "dim", "grayscale", "hover-blur"]);
    // The Phase 2 spec lists the labels too — assert them so a future
    // i18n bump that breaks labels gets caught.
    const labels = [];
    for (let i = 0; i < thumbs.options.length; i++) {
      labels.push(thumbs.options[i].textContent);
    }
    assertEq("2d) mode-thumbnails option labels",
      labels, ["Hide", "Blur", "Dim", "Grayscale", "Hover-only blur"]);
    // v1.5.0-fix1 — defensive attribute that confirms count without
    // opening the dropdown.
    assertEq("2e) data-options-count attribute matches live option count",
      thumbs.getAttribute("data-options-count"), "5");
    assertEq("2f) aria-label mentions 5 options",
      thumbs.getAttribute("aria-label"), "Thumbnail render mode (5 options)");
  }

  // ===== 3. Every OTHER blocker dropdown has EXACTLY 3 options ==========
  //
  // Regression sentinel against grayscale/hover-blur leaking into other
  // blockers. If this fires, the conditional in renderModeDropdown
  // broke (or _BLOCKER_MODE_OPTIONS got extra keys).

  for (const id of BLOCKERS_WITH_DROPDOWN) {
    if (id === "thumbnails") continue;
    const sel = document.getElementById("mode-" + id);
    if (!sel) continue;
    assertEq(`3.${id}) ${id} has exactly 3 options (no thumbnail leakage)`,
      sel.options.length, 3);
    const values = [];
    for (let i = 0; i < sel.options.length; i++) values.push(sel.options[i].value);
    assertEq(`3.${id}) ${id} option order: hide, blur, dim`,
      values, ["hide", "blur", "dim"]);
    assertEq(`3.${id}) ${id} data-options-count = "3"`,
      sel.getAttribute("data-options-count"), "3");
  }

  // ===== 4. blockerModes pre-selection survives the render ==============
  //
  // If the user already had a non-hide mode for thumbnails (say "blur"
  // from v1.4.19), the dropdown should boot with that option selected.
  // For grayscale / hover-blur the same selection logic must work.

  for (const cur of ["blur", "dim", "grayscale", "hover-blur"]) {
    const { document: doc2 } = bootPopup({
      paid: true,
      blockerModes: { thumbnails: cur },
    });
    await new Promise((r) => setTimeout(r, 300));
    await new Promise((r) => setTimeout(r, 100));
    const sel = doc2.getElementById("mode-thumbnails");
    if (sel) {
      assertEq(`4.${cur}) initial selected option = ${cur}`,
        sel.value, cur);
    }
  }

  // ===== 5. Locked (free user, Pro blocker) — dropdown still has 5 ======
  //
  // Pro blocker locked for a free user disables the select but DOESN'T
  // truncate the option list. The user just can't change the value
  // until they unlock Pro.

  const { document: docFree } = bootPopup({ paid: false });
  await new Promise((r) => setTimeout(r, 300));
  await new Promise((r) => setTimeout(r, 100));
  const lockedSel = docFree.getElementById("mode-thumbnails");
  assertTrue("5a) locked mode-thumbnails still rendered", !!lockedSel);
  if (lockedSel) {
    assertEq("5b) locked mode-thumbnails: 5 options preserved",
      lockedSel.options.length, 5);
    assertEq("5c) locked mode-thumbnails: disabled=true",
      lockedSel.disabled, true);
  }

  process.stdout.write("\n");
  console.log(`POPUP MODE RENDER: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\n  ERR:", e.message, e.stack && e.stack.split("\n").slice(0, 5).join("\n"));
  process.exit(1);
});
