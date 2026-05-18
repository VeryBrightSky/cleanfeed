/* CleanFeed "Show comments" persistence (v1.4.13).
 *
 * History:
 *   v1.4.12 — first attempt: persisted STATE.commentsManuallyShown so
 *     applyBlockers() no longer wiped cf-comments-shown on MutationObserver
 *     re-ticks. Shipped but DID NOT FIX the user-reported bug.
 *
 *   v1.4.13 — actual fix: the v1.4.12 reset path (in watchSPANavigation)
 *     fired on EVERY yt-navigate-finish AND on ANY change to location.href.
 *     Both triggers fire for non-video-change events on the same /watch
 *     page (YT-internal page-state transitions; YT auto-adding &t=<timestamp>
 *     when the user clicks a chapter, scrubs the timeline, or clicks a
 *     timestamp in a comment). A spurious fire wiped commentsManuallyShown
 *     and re-hid the comments. v1.4.13 gates the reset behind an actual
 *     canonical-video-identity change (pathname + ?v=).
 *
 * This test models BOTH the original DOM-mutation re-run hazard (kept
 * from v1.4.12) and the v1.4.13 nav-spurious-trigger hazard that the
 * earlier test missed.
 *
 * Run with:  node tests/show-comments-persist.js
 * Exits non-zero on first failed assertion.
 */
"use strict";

let pass = 0, fail = 0;
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}\n    expected: ${e}\n    actual:   ${a}`); }
}

// Minimal body.classList + URL shim
function makeBody() {
  const classes = new Set();
  return {
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
  };
}

// ---- pre-v1.4.11 (buggy) — strips cf-comments-shown unconditionally ----
function v1411_applyBlockers(body, commentsActive) {
  for (const c of ["cf-block-comments", "cf-paused"]) body.classList.remove(c);
  body.classList.remove("cf-comments-shown");        // ← the original v1.4.11 bug
  if (commentsActive) body.classList.add("cf-block-comments");
}

// ---- v1.4.12 attempted fix — state survives applyBlockers but NOT nav-spurious ----
function makeV1412(body) {
  const STATE = { commentsManuallyShown: false };
  function applyBlockers(commentsActive, onWatch) {
    for (const c of ["cf-block-comments", "cf-paused"]) body.classList.remove(c);
    if (commentsActive) body.classList.add("cf-block-comments");
    if (commentsActive && onWatch) {
      if (STATE.commentsManuallyShown) body.classList.add("cf-comments-shown");
      else                              body.classList.remove("cf-comments-shown");
    } else {
      body.classList.remove("cf-comments-shown");
    }
  }
  function clickShowComments() {
    STATE.commentsManuallyShown = true;
    body.classList.add("cf-comments-shown");
  }
  // v1.4.12's nav reset fired on EVERY yt-navigate-finish + any URL change.
  function spuriousNavReset_v1412() {
    STATE.commentsManuallyShown = false;
    body.classList.remove("cf-comments-shown");
  }
  return { STATE, applyBlockers, clickShowComments, spuriousNavReset_v1412 };
}

// ---- v1.4.13 fix — gate reset on canonical video-identity change ----
function makeV1413(body) {
  const STATE = { commentsManuallyShown: false };
  // Synthetic "location" — caller mutates this to simulate URL changes.
  const loc = { pathname: "/watch", search: "?v=ABC123" };
  function navIdentity() {
    let v = "";
    try { v = new URLSearchParams(loc.search).get("v") || ""; } catch (_) {}
    return loc.pathname + "?v=" + v;
  }
  let lastNav = navIdentity();
  function maybeNavReset() {
    const cur = navIdentity();
    if (cur === lastNav) return false;
    lastNav = cur;
    STATE.commentsManuallyShown = false;
    body.classList.remove("cf-comments-shown");
    return true;
  }
  function applyBlockers(commentsActive, onWatch) {
    for (const c of ["cf-block-comments", "cf-paused"]) body.classList.remove(c);
    if (commentsActive) body.classList.add("cf-block-comments");
    if (commentsActive && onWatch) {
      if (STATE.commentsManuallyShown) body.classList.add("cf-comments-shown");
      else                              body.classList.remove("cf-comments-shown");
    } else {
      body.classList.remove("cf-comments-shown");
    }
  }
  function clickShowComments() {
    STATE.commentsManuallyShown = true;
    body.classList.add("cf-comments-shown");
  }
  // Two real reset paths in v1.4.13: yt-navigate-finish + URL poll. Both
  // funnel through maybeNavReset() now, so they're effectively one path.
  function ytNavigateFinish()       { maybeNavReset(); applyBlockers(true, loc.pathname === "/watch"); }
  function urlPollTick()             { if (maybeNavReset()) applyBlockers(true, loc.pathname === "/watch"); }
  return { STATE, loc, applyBlockers, clickShowComments, ytNavigateFinish, urlPollTick };
}

// ===== A — v1.4.11 baseline: applyBlockers re-run strips the class =====
{
  const body = makeBody();
  v1411_applyBlockers(body, true);
  body.classList.add("cf-comments-shown");
  assertEq("A) v1.4.11 — comments visible after click",
    body.classList.contains("cf-comments-shown"), true);
  v1411_applyBlockers(body, true);
  assertEq("A) v1.4.11 — re-run strips cf-comments-shown (the v1.4.11 bug)",
    body.classList.contains("cf-comments-shown"), false);
}

// ===== B — v1.4.12 fixed the applyBlockers path but NOT the nav-spurious path =====
{
  const body = makeBody();
  const p = makeV1412(body);
  p.applyBlockers(true, true);
  p.clickShowComments();
  assertEq("B) v1.4.12 — click reveals", body.classList.contains("cf-comments-shown"), true);
  for (let i = 0; i < 10; i++) p.applyBlockers(true, true);
  assertEq("B) v1.4.12 — 10 applyBlockers re-runs preserve reveal",
    body.classList.contains("cf-comments-shown"), true);
  // SPURIOUS yt-navigate-finish on the same video (the v1.4.12 bug)
  p.spuriousNavReset_v1412();
  assertEq("B) v1.4.12 — spurious yt-navigate-finish KILLS reveal (THE v1.4.12 BUG)",
    body.classList.contains("cf-comments-shown"), false);
}

// ===== C — v1.4.13 reveal survives applyBlockers re-runs (regression guard) =====
{
  const body = makeBody();
  const p = makeV1413(body);
  p.applyBlockers(true, true);
  p.clickShowComments();
  for (let i = 0; i < 10; i++) p.applyBlockers(true, true);
  assertEq("C) v1.4.13 — 10 applyBlockers re-runs preserve reveal",
    body.classList.contains("cf-comments-shown"), true);
}

// ===== D — v1.4.13 survives SPURIOUS yt-navigate-finish on same video =====
{
  const body = makeBody();
  const p = makeV1413(body);
  p.applyBlockers(true, true);
  p.clickShowComments();
  // YT fires yt-navigate-finish without the canonical video identity
  // changing (e.g. comments tab init / page-data re-hydration).
  p.ytNavigateFinish();
  assertEq("D) v1.4.13 — spurious yt-navigate-finish preserves reveal",
    body.classList.contains("cf-comments-shown"), true);
  assertEq("D) STATE preserved", p.STATE.commentsManuallyShown, true);
}

// ===== E — v1.4.13 survives URL change that's only a &t= timestamp =====
{
  const body = makeBody();
  const p = makeV1413(body);
  p.applyBlockers(true, true);
  p.clickShowComments();
  // YT adds &t=42 to URL on chapter click — same video, same v= param.
  p.loc.search = "?v=ABC123&t=42";
  p.urlPollTick();
  assertEq("E) v1.4.13 — &t= timestamp on same video preserves reveal",
    body.classList.contains("cf-comments-shown"), true);
  // Subsequent applyBlockers tick (from MutationObserver) also preserves.
  p.applyBlockers(true, true);
  assertEq("E) post-tick still revealed", body.classList.contains("cf-comments-shown"), true);
}

// ===== F — v1.4.13 DOES reset when canonical video changes (real nav) =====
{
  const body = makeBody();
  const p = makeV1413(body);
  p.applyBlockers(true, true);
  p.clickShowComments();
  assertEq("F) revealed pre-nav", body.classList.contains("cf-comments-shown"), true);
  // user clicks a new video — v= param changes
  p.loc.search = "?v=NEW456";
  p.urlPollTick();
  assertEq("F) real nav (v= changed) clears reveal",
    body.classList.contains("cf-comments-shown"), false);
  assertEq("F) STATE reset on real nav", p.STATE.commentsManuallyShown, false);
}

// ===== G — v1.4.13 reset on yt-navigate-finish only when v= changed =====
{
  const body = makeBody();
  const p = makeV1413(body);
  p.applyBlockers(true, true);
  p.clickShowComments();
  // Fake "navigate" but URL doesn't actually change → no-op
  p.ytNavigateFinish();
  assertEq("G) yt-navigate-finish without v= change — preserved",
    body.classList.contains("cf-comments-shown"), true);
  // Now v= changes AND yt-navigate-finish fires — real nav
  p.loc.search = "?v=ANOTHER";
  p.ytNavigateFinish();
  assertEq("G) yt-navigate-finish WITH v= change — reset",
    body.classList.contains("cf-comments-shown"), false);
}

// ===== H — off-watch pages don't gain the class =====
{
  const body = makeBody();
  const p = makeV1413(body);
  p.clickShowComments();
  p.applyBlockers(true, false);
  assertEq("H) off-watch — class removed even when state=true",
    body.classList.contains("cf-comments-shown"), false);
}

// ===== I — pathname change (away from /watch) is treated as nav =====
{
  const body = makeBody();
  const p = makeV1413(body);
  p.applyBlockers(true, true);
  p.clickShowComments();
  // user navigates to homepage — pathname changes from /watch to /
  p.loc.pathname = "/";
  p.loc.search = "";
  p.urlPollTick();
  assertEq("I) pathname change resets STATE",
    p.STATE.commentsManuallyShown, false);
}

process.stdout.write("\n");
console.log(`SHOW-COMMENTS PERSIST: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
