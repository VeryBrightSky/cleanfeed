/* CleanFeed v1.4.24.9 — the two functional fixes from the full audit.
 *
 * FIX 1 — keyword blocking was silently dead on new-DOM surfaces: the title
 * extraction in applyKeywordBlocks knew only old-DOM ids (#video-title,
 * a#video-title-link, yt-formatted-string#video-title). New-DOM cards
 * (yt-lockup-view-model / ytm-shorts-lockup-view-model-v2) have none of
 * those, so every card was skipped (audit: 0/30 tagged vs 18/19 old-DOM).
 * v1.4.24.9 adds the live-verified new-DOM title paths + a bare h3 fallback.
 *
 * FIX 2 — autoplay disabler race: disableAutoplayIfOn marked a video
 * "handled" after merely FINDING .ytp-autonav-toggle-button, even when
 * aria-checked wasn't "true" yet. The button exists before the player
 * initializes its state, so the premature mark meant we never re-checked
 * when YT flipped autoplay on a moment later (confirmed live: blocker
 * active, toggle stayed on; a manual click flips it). v1.4.24.9 marks
 * handled ONLY after observing "true" and clicking it off.
 *
 * Run with:  node tests/keyword-autoplay-fixes.js
 * Exits non-zero on first failed assertion.
 */
"use strict";

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assertTrue(name, cond) {
  if (cond) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}`); }
}
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}\n    expected: ${e}\n    actual:   ${a}`); }
}

const contentJs = fs.readFileSync(path.join(__dirname, "..", "content", "content.js"), "utf8");

// ==========================================================================
// 1. Keyword title extraction — shipped selector chain
// ==========================================================================
{
  // Old-DOM paths KEPT (both DOMs live).
  assertTrue("keyword: old-DOM #video-title path kept",
    contentJs.includes('"#video-title, a#video-title-link, yt-formatted-string#video-title"'));
  // New-DOM paths ADDED (verified live: regular lockup title anchor class,
  // dashed-class cohort variant, shorts lockup heading class).
  assertTrue("keyword: new-DOM .ytLockupMetadataViewModelTitle added",
    contentJs.includes(".ytLockupMetadataViewModelTitle"));
  assertTrue("keyword: new-DOM dashed-class variant added",
    contentJs.includes(".yt-lockup-metadata-view-model__title"));
  assertTrue("keyword: shorts lockup title class added",
    contentJs.includes(".shortsLockupViewModelHostMetadataTitle"));
  assertTrue("keyword: bare h3 fallback added",
    /card\.querySelector\("h3"\)/.test(contentJs));
  // Order: old-DOM first, then new-DOM classes, then h3 (inside applyKeywordBlocks).
  const kb = contentJs.slice(contentJs.indexOf("function applyKeywordBlocks"),
                             contentJs.indexOf("function", contentJs.indexOf("function applyKeywordBlocks") + 10));
  const iOld = kb.indexOf("#video-title");
  const iNew = kb.indexOf(".ytLockupMetadataViewModelTitle");
  const iH3 = kb.indexOf('querySelector("h3")');
  assertTrue("keyword: extraction order old → new → h3 fallback",
    iOld !== -1 && iNew !== -1 && iH3 !== -1 && iOld < iNew && iNew < iH3);
}

// ----- 1b. extraction model (mirrors the shipped chain) --------------------
// A mock card exposes querySelector over a map of selector-ish keys.
function mockCard(elems) {
  return {
    querySelector(sel) {
      // split the comma list, return the first present key
      const parts = sel.split(",").map((s) => s.trim());
      for (const p of parts) if (elems[p]) return elems[p];
      return null;
    },
  };
}
function extractTitle(card) {
  const tEl =
    card.querySelector("#video-title, a#video-title-link, yt-formatted-string#video-title") ||
    card.querySelector(
      ".ytLockupMetadataViewModelTitle, .yt-lockup-metadata-view-model__title," +
      " .shortsLockupViewModelHostMetadataTitle"
    ) ||
    card.querySelector("h3");
  if (!tEl) return null;
  return ((tEl.getAttribute && tEl.getAttribute("title")) || tEl.textContent || "").toLowerCase();
}
function el(text, titleAttr) {
  return { textContent: text, getAttribute: (k) => (k === "title" ? (titleAttr || null) : null) };
}
{
  // Old-DOM card: #video-title with title attribute (search results).
  assertEq("model: old-DOM card title via #video-title[title]",
    extractTitle(mockCard({ "#video-title": el("ignored text", "Artemis III Recap") })),
    "artemis iii recap");
  // New-DOM regular lockup: camelCase title anchor, text only (no title attr).
  assertEq("model: new-DOM lockup title via .ytLockupMetadataViewModelTitle",
    extractTitle(mockCard({ ".ytLockupMetadataViewModelTitle": el("Artemis III Announcement Recap") })),
    "artemis iii announcement recap");
  // New-DOM dashed-class cohort variant.
  assertEq("model: dashed-class cohort variant",
    extractTitle(mockCard({ ".yt-lockup-metadata-view-model__title": el("Some Video") })),
    "some video");
  // Shorts lockup: heading class.
  assertEq("model: shorts lockup title",
    extractTitle(mockCard({ ".shortsLockupViewModelHostMetadataTitle": el("Relive Artemis II") })),
    "relive artemis ii");
  // Unknown future card: h3 fallback.
  assertEq("model: unknown card falls back to h3",
    extractTitle(mockCard({ "h3": el("Future DOM Title") })),
    "future dom title");
  // Old-DOM wins over new-DOM when both present (a rich-item wrapping a
  // legacy renderer) — same element either way, order is deterministic.
  assertEq("model: old-DOM path tried first",
    extractTitle(mockCard({
      "#video-title": el("Old Title"),
      ".ytLockupMetadataViewModelTitle": el("New Title"),
    })),
    "old title");
  // Card with no title anywhere → null (skipped, never hidden).
  assertEq("model: titleless card skipped", extractTitle(mockCard({})), null);
}

// ==========================================================================
// 2. Autoplay disabler races (two of them — see disableAutoplayIfOn)
// ==========================================================================
{
  const fn = contentJs.slice(contentJs.indexOf("function disableAutoplayIfOn"),
                             contentJs.indexOf("function applyCustomCSS"));
  // (a) no premature handled-mark: nothing is marked handled on a bare
  // button sighting; the not-"true" branch only marks when WE clicked.
  assertTrue("autoplay: not-true branch marks handled only after our own click",
    /checked !== "true"\) \{[\s\S]{0,400}autoplayLastClick\.videoId === videoId[\s\S]{0,120}autoplayHandledForVideo = videoId/.test(fn));
  // (b) click-verification: after clicking, handled only on a verified flip.
  assertTrue("autoplay: verified-flip gate after click",
    /btn\.click\(\);[\s\S]{0,600}getAttribute\("aria-checked"\) !== "true"\) \{\s*\n\s*STATE\.autoplayHandledForVideo = videoId/.test(fn));
  // (c) retry cooldown so an async flip can settle without double-click flap.
  assertTrue("autoplay: 1.5s retry cooldown present",
    fn.includes("Date.now() - STATE.autoplayLastClick.at < 1500"));
  assertTrue("autoplay: click still wrapped in try/catch",
    /try \{\s*btn\.click\(\);\s*\} catch/.test(fn));
  assertTrue("autoplay: STATE.autoplayLastClick declared",
    contentJs.includes("autoplayLastClick: null"));
}

// ----- 2b. state machine model (mirrors the fixed logic exactly) -----------
function makePlayer() {
  const state = { autoplayHandledForVideo: "", autoplayLastClick: null, clicks: 0 };
  let btn = null;          // { checked: "true"|"false"|null }
  let handlerBound = true; // false = YT hasn't bound its click handler yet
  let now = 1000000;
  return {
    state,
    setButton(checked) { btn = { checked }; },
    setHandlerBound(v) { handlerBound = v; },
    advance(ms) { now += ms; },
    _click() { state.clicks++; if (handlerBound) btn.checked = btn.checked === "true" ? "false" : "true"; },
    tick(videoId) {
      // mirror of the SHIPPED disableAutoplayIfOn (v1.4.24.9)
      if (videoId && state.autoplayHandledForVideo === videoId) return;
      if (!btn) return;
      const checked = btn.checked;
      if (checked !== "true") {
        if (videoId && state.autoplayLastClick &&
            state.autoplayLastClick.videoId === videoId) {
          state.autoplayHandledForVideo = videoId;
        }
        return;
      }
      if (videoId && state.autoplayLastClick &&
          state.autoplayLastClick.videoId === videoId &&
          now - state.autoplayLastClick.at < 1500) {
        return;
      }
      this._click();
      if (videoId) state.autoplayLastClick = { videoId, at: now };
      if (videoId && btn.checked !== "true") {
        state.autoplayHandledForVideo = videoId;
      }
    },
  };
}
{
  // RACE (a) — pre-.9 failure: button exists before state init.
  const p = makePlayer();
  p.tick("vid1");
  assertEq("race-a: no button → not handled", p.state.autoplayHandledForVideo, "");
  p.setButton(null);
  p.tick("vid1");
  assertEq("race-a: uninitialized button → NOT handled", p.state.autoplayHandledForVideo, "");
  p.setButton("true");            // YT flips autoplay on later
  p.tick("vid1");
  assertEq("race-a: later true → clicked off", p.state.clicks, 1);
  assertEq("race-a: verified flip → handled", p.state.autoplayHandledForVideo, "vid1");
  p.setButton("true");            // user manually re-enables mid-video
  p.tick("vid1");
  assertEq("race-a: manual re-enable respected", p.state.clicks, 1);
}
{
  // RACE (b) — the live-traced failure: aria="true" but YT's click handler
  // not yet bound; the click is a silent no-op. Must NOT mark handled;
  // must retry after the cooldown and succeed once the handler binds.
  const p = makePlayer();
  p.setButton("true");
  p.setHandlerBound(false);       // player shell rendered, JS not bound
  p.tick("vid1");                 // clicks into the void
  assertEq("race-b: unbound click issued", p.state.clicks, 1);
  assertEq("race-b: NOT marked handled (flip unverified)", p.state.autoplayHandledForVideo, "");
  p.advance(200); p.tick("vid1"); // within cooldown → no double-fire
  assertEq("race-b: cooldown blocks immediate retry", p.state.clicks, 1);
  p.setHandlerBound(true);        // player becomes interactive
  p.advance(2000); p.tick("vid1");
  assertEq("race-b: post-cooldown retry clicks again", p.state.clicks, 2);
  assertEq("race-b: flip verified now → handled", p.state.autoplayHandledForVideo, "vid1");
}
{
  // Async flip: click lands but aria updates on a later tick.
  const p = makePlayer();
  p.setButton("true");
  p.setHandlerBound(false);       // simulate: click issued, no sync flip
  p.tick("vid1");
  assertEq("async: click 1 issued, unverified", p.state.autoplayHandledForVideo, "");
  // YT applies the flip asynchronously (not via our model's sync path):
  p.setButton("false");
  p.advance(2000); p.tick("vid1");
  assertEq("async: later off-tick + our lastClick → handled", p.state.autoplayHandledForVideo, "vid1");
  assertEq("async: no extra click", p.state.clicks, 1);
}
{
  // New video resets the whole gate.
  const p = makePlayer();
  p.setButton("true");
  p.tick("vidA");
  assertEq("multi: vidA flipped + handled", p.state.autoplayHandledForVideo, "vidA");
  p.setButton("true");            // next video starts with autoplay on
  p.advance(5000); p.tick("vidB");
  assertEq("multi: vidB gets its own flip", p.state.clicks, 2);
  assertEq("multi: handled follows vidB", p.state.autoplayHandledForVideo, "vidB");
}

console.log(`\nKEYWORD+AUTOPLAY FIXES: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
