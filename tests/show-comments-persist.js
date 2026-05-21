/* CleanFeed "Show comments" persistence (v1.4.14).
 *
 * History:
 *   v1.4.12 — first attempt: persisted STATE.commentsManuallyShown so
 *     applyBlockers() no longer wiped cf-comments-shown on MutationObserver
 *     re-ticks. Shipped but DID NOT FIX the user-reported bug.
 *
 *   v1.4.13 — second attempt: gated the nav-reset path behind a real
 *     canonical-video-identity change (pathname + ?v=), so spurious
 *     yt-navigate-finish and &t= URL changes no longer wiped the reveal.
 *     Shipped but ALSO DID NOT FIX the bug in real Chrome. The test
 *     suite passed because it modeled body.classList via a Set-backed
 *     shim that no external actor could touch — the real failure mode
 *     was external mutation of body's class attribute, which the
 *     MutationObserver in content.js doesn't watch (childList+subtree
 *     only, not attributes).
 *
 *   v1.4.14 — actual fix: bypass the body-class+stylesheet mechanism
 *     for comments visibility. Apply inline `display: block !important`
 *     directly to each comments DOM element via applyCommentsManualReveal().
 *     Inline !important is at the TOP of the CSS cascade — beats every
 *     author stylesheet rule regardless of specificity, source order, or
 *     external body-class wipes. Re-applied on every applyBlockers tick
 *     so YT replacing the ytd-comments element doesn't lose the reveal.
 *     The cf-comments-shown body class is still set/cleared so the
 *     existing rule hiding .cf-show-comments-btn keeps working.
 *
 * This test models:
 *   - The original v1.4.11 DOM-mutation re-run hazard (regression guard).
 *   - The v1.4.12 spurious-nav-reset hazard (regression guard).
 *   - The v1.4.13 external-body-class-wipe hazard (NEW — the one that
 *     v1.4.13 actually broke on in real Chrome).
 *   - The v1.4.14 fix: inline reveal survives body class wipe.
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
    // Simulate an external actor (e.g. YT's framework) wiping body.className.
    _externalClassWipe() { classes.clear(); },
  };
}

// Minimal "DOM" — a list of elements per selector. Each element has a .style
// object that records inline display + !important via setProperty/removeProperty.
function makeDOM(initialElements) {
  // initialElements: { [selector]: [el, el, ...] }
  const byCss = Object.assign({}, initialElements || {});
  // also build a flat list for [data-cf-shown="1"] lookup
  function allEls() {
    const set = new Set();
    for (const sel in byCss) for (const el of byCss[sel]) set.add(el);
    return Array.from(set);
  }
  return {
    querySelectorAll(sel) {
      if (sel === '[data-cf-shown="1"]') {
        return allEls().filter((el) => el.dataset && el.dataset.cfShown === "1");
      }
      return (byCss[sel] || []).slice();
    },
    // Simulate YT replacing the ytd-comments element with a fresh one
    // (loses any inline style + data attribute that was on the old one).
    _replaceElement(sel, newEl) {
      byCss[sel] = [newEl];
    },
  };
}

function makeEl() {
  const style = {
    _props: {},
    _important: {},
    setProperty(name, value, priority) {
      this._props[name] = value;
      this._important[name] = priority === "important";
    },
    removeProperty(name) {
      delete this._props[name];
      delete this._important[name];
    },
    getPropertyValue(name) { return this._props[name] || ""; },
    getPropertyPriority(name) { return this._important[name] ? "important" : ""; },
  };
  const dataset = {};
  return {
    style,
    dataset,
    setAttribute(name, value) {
      if (name === "data-cf-shown") dataset.cfShown = value;
    },
    removeAttribute(name) {
      if (name === "data-cf-shown") delete dataset.cfShown;
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

// ---- v1.4.13 fix — gate nav-reset on canonical video-identity change ----
// Models the failure mode that the user actually hit in real Chrome:
// the body class can be wiped externally between applyBlockers ticks,
// and v1.4.13's MutationObserver doesn't watch body.attributes so the
// wipe goes undetected. Until the next subtree mutation re-triggers
// applyBlockers, the body has cf-block-comments unopposed and the
// comments stay hidden.
function makeV1413(body) {
  const STATE = { commentsManuallyShown: false };
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
  function ytNavigateFinish() { maybeNavReset(); applyBlockers(true, loc.pathname === "/watch"); }
  function urlPollTick()       { if (maybeNavReset()) applyBlockers(true, loc.pathname === "/watch"); }
  return { STATE, loc, applyBlockers, clickShowComments, ytNavigateFinish, urlPollTick };
}

// ---- v1.4.14 fix — inline `display: block !important` on the comments
// elements. Survives body-class wipes because the visibility no longer
// depends on the body class at all.
function makeV1414(body, dom) {
  const STATE = { commentsManuallyShown: false };
  const loc = { pathname: "/watch", search: "?v=ABC123" };
  const SELECTORS = [
    "ytd-comments#comments",
    "#comments.ytd-watch-flexy",
    "ytd-comments-header-renderer",
  ];
  function navIdentity() {
    let v = "";
    try { v = new URLSearchParams(loc.search).get("v") || ""; } catch (_) {}
    return loc.pathname + "?v=" + v;
  }
  let lastNav = navIdentity();
  function applyCommentsManualReveal() {
    for (const sel of SELECTORS) {
      dom.querySelectorAll(sel).forEach((el) => {
        el.style.setProperty("display", "block", "important");
        el.setAttribute("data-cf-shown", "1");
      });
    }
  }
  function clearCommentsManualReveal() {
    dom.querySelectorAll('[data-cf-shown="1"]').forEach((el) => {
      el.style.removeProperty("display");
      el.removeAttribute("data-cf-shown");
    });
  }
  function maybeNavReset() {
    const cur = navIdentity();
    if (cur === lastNav) return false;
    lastNav = cur;
    STATE.commentsManuallyShown = false;
    body.classList.remove("cf-comments-shown");
    clearCommentsManualReveal();
    return true;
  }
  function applyBlockers(commentsActive, onWatch) {
    for (const c of ["cf-block-comments", "cf-paused"]) body.classList.remove(c);
    if (commentsActive) body.classList.add("cf-block-comments");
    if (commentsActive && onWatch) {
      if (STATE.commentsManuallyShown) {
        body.classList.add("cf-comments-shown");
        applyCommentsManualReveal();
      } else {
        body.classList.remove("cf-comments-shown");
        clearCommentsManualReveal();
      }
    } else {
      body.classList.remove("cf-comments-shown");
      clearCommentsManualReveal();
    }
  }
  function clickShowComments() {
    STATE.commentsManuallyShown = true;
    body.classList.add("cf-comments-shown");
    applyCommentsManualReveal();
  }
  function ytNavigateFinish() { maybeNavReset(); applyBlockers(true, loc.pathname === "/watch"); }
  function urlPollTick()       { if (maybeNavReset()) applyBlockers(true, loc.pathname === "/watch"); }
  return { STATE, loc, dom, applyBlockers, clickShowComments, ytNavigateFinish, urlPollTick,
           applyCommentsManualReveal, clearCommentsManualReveal };
}

// ---- v1.4.15 fix — same as v1.4.14 PLUS reset STATE.commentsManuallyShown
// in the else branch of applyBlockers. v1.4.14 cleared the visible reveal
// when the Comments blocker was toggled OFF but left the state flag sticky,
// so toggling the blocker back ON re-applied the inline reveal from the
// pre-toggle-off click. v1.4.13's maybeNavReset already handled the nav
// path; v1.4.15 closes the same-page settings-change path.
function makeV1415(body, dom) {
  const STATE = { commentsManuallyShown: false, commentsBtnAdded: false };
  const loc = { pathname: "/watch", search: "?v=ABC123" };
  const SELECTORS = [
    "ytd-comments#comments",
    "#comments.ytd-watch-flexy",
    "ytd-comments-header-renderer",
  ];
  function navIdentity() {
    let v = "";
    try { v = new URLSearchParams(loc.search).get("v") || ""; } catch (_) {}
    return loc.pathname + "?v=" + v;
  }
  let lastNav = navIdentity();
  function applyCommentsManualReveal() {
    for (const sel of SELECTORS) {
      dom.querySelectorAll(sel).forEach((el) => {
        el.style.setProperty("display", "block", "important");
        el.setAttribute("data-cf-shown", "1");
      });
    }
  }
  function clearCommentsManualReveal() {
    dom.querySelectorAll('[data-cf-shown="1"]').forEach((el) => {
      el.style.removeProperty("display");
      el.removeAttribute("data-cf-shown");
    });
  }
  function maybeNavReset() {
    const cur = navIdentity();
    if (cur === lastNav) return false;
    lastNav = cur;
    STATE.commentsManuallyShown = false;
    STATE.commentsBtnAdded = false;
    body.classList.remove("cf-comments-shown");
    clearCommentsManualReveal();
    return true;
  }
  function addBtn() { STATE.commentsBtnAdded = true; }
  function removeBtn() { STATE.commentsBtnAdded = false; }
  function applyBlockers(commentsActive, onWatch) {
    for (const c of ["cf-block-comments", "cf-paused"]) body.classList.remove(c);
    if (commentsActive) body.classList.add("cf-block-comments");
    if (commentsActive && onWatch) {
      addBtn();
      if (STATE.commentsManuallyShown) {
        body.classList.add("cf-comments-shown");
        applyCommentsManualReveal();
      } else {
        body.classList.remove("cf-comments-shown");
        clearCommentsManualReveal();
      }
    } else {
      removeBtn();
      body.classList.remove("cf-comments-shown");
      clearCommentsManualReveal();
      STATE.commentsManuallyShown = false;   // v1.4.15 — the FIX
    }
  }
  function clickShowComments() {
    STATE.commentsManuallyShown = true;
    body.classList.add("cf-comments-shown");
    applyCommentsManualReveal();
  }
  function ytNavigateFinish() { maybeNavReset(); applyBlockers(true, loc.pathname === "/watch"); }
  function urlPollTick()       { if (maybeNavReset()) applyBlockers(true, loc.pathname === "/watch"); }
  return { STATE, loc, dom, applyBlockers, clickShowComments, ytNavigateFinish, urlPollTick,
           applyCommentsManualReveal, clearCommentsManualReveal };
}

// Helpers to assert "comments are effectively visible" in v1.4.14:
// either inline display:block!important is set on at least one element,
// OR cf-comments-shown is on body AND cf-block-comments is not (no blocker).
function elsHaveInlineReveal(dom) {
  const matches = dom.querySelectorAll('[data-cf-shown="1"]');
  return matches.some((el) =>
    el.style.getPropertyValue("display") === "block" &&
    el.style.getPropertyPriority("display") === "important"
  );
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

// ===== B — v1.4.12 fixed applyBlockers path but NOT nav-spurious path =====
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
  p.loc.search = "?v=ABC123&t=42";
  p.urlPollTick();
  assertEq("E) v1.4.13 — &t= timestamp on same video preserves reveal",
    body.classList.contains("cf-comments-shown"), true);
  p.applyBlockers(true, true);
  assertEq("E) post-tick still revealed", body.classList.contains("cf-comments-shown"), true);
}

// ===== F — v1.4.13 DOES reset when canonical video changes (real nav) =====
{
  const body = makeBody();
  const p = makeV1413(body);
  p.applyBlockers(true, true);
  p.clickShowComments();
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
  p.ytNavigateFinish();
  assertEq("G) yt-navigate-finish without v= change — preserved",
    body.classList.contains("cf-comments-shown"), true);
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
  p.loc.pathname = "/";
  p.loc.search = "";
  p.urlPollTick();
  assertEq("I) pathname change resets STATE",
    p.STATE.commentsManuallyShown, false);
}

// ===== J — REGRESSION SENTINEL: v1.4.13 fails when body class is wiped externally =====
// This is the real-Chrome failure mode the v1.4.13 test suite DIDN'T model.
// YT's framework (or any external actor) modifies body.className in a way
// that drops cf-comments-shown. v1.4.13's MutationObserver only watches
// childList+subtree on body, NOT attribute changes — so the wipe is invisible
// to applyBlockers re-triggers. Between the wipe and the next subtree
// mutation, the body has cf-block-comments unopposed and comments are
// hidden. On an idle user this can persist for many seconds.
{
  const body = makeBody();
  const p = makeV1413(body);
  p.applyBlockers(true, true);
  p.clickShowComments();
  assertEq("J) v1.4.13 — revealed after click",
    body.classList.contains("cf-comments-shown"), true);
  // External actor wipes body.className (no applyBlockers triggered).
  body._externalClassWipe();
  assertEq("J) v1.4.13 — external wipe KILLS reveal until next applyBlockers (the v1.4.13 BUG)",
    body.classList.contains("cf-comments-shown"), false);
  // v1.4.13 STATE is still true, so the next applyBlockers tick re-adds
  // the class — but only IF a subtree mutation actually fires the
  // MutationObserver. On an idle user that may not happen for many
  // seconds, so comments stay hidden in real Chrome.
  assertEq("J) v1.4.13 — STATE remains true (so this WOULD self-heal on next mutation tick)",
    p.STATE.commentsManuallyShown, true);
}

// ===== K — v1.4.14 inline reveal survives external body-class wipe =====
// The fix: visibility is set via inline `display: block !important` on
// each comments element. Body class wipes can't touch the elements' inline
// style.
{
  const body = makeBody();
  const dom = makeDOM({
    "ytd-comments#comments": [makeEl()],
    "ytd-comments-header-renderer": [makeEl()],
  });
  const p = makeV1414(body, dom);
  p.applyBlockers(true, true);
  p.clickShowComments();
  assertEq("K) v1.4.14 — inline reveal set after click", elsHaveInlineReveal(dom), true);
  body._externalClassWipe();
  assertEq("K) v1.4.14 — external body class wipe leaves inline reveal intact",
    elsHaveInlineReveal(dom), true);
  // And applyBlockers re-tick re-adds the body class + re-applies inline.
  p.applyBlockers(true, true);
  assertEq("K) v1.4.14 — next applyBlockers re-applies inline reveal",
    elsHaveInlineReveal(dom), true);
}

// ===== L — v1.4.14 inline reveal survives YT replacing the ytd-comments element =====
// YT may re-render the comments container (subtree mutation). The new element
// has no inline style/dataset. applyBlockers' next tick re-applies because
// STATE.commentsManuallyShown stays true.
{
  const body = makeBody();
  const oldEl = makeEl();
  const dom = makeDOM({ "ytd-comments#comments": [oldEl] });
  const p = makeV1414(body, dom);
  p.applyBlockers(true, true);
  p.clickShowComments();
  assertEq("L) v1.4.14 — old element revealed",
    oldEl.style.getPropertyValue("display"), "block");
  // YT replaces the element with a fresh one — no inline style on the new.
  const newEl = makeEl();
  dom._replaceElement("ytd-comments#comments", newEl);
  assertEq("L) v1.4.14 — new element initially has no inline display",
    newEl.style.getPropertyValue("display"), "");
  // Next applyBlockers tick (MutationObserver fires on the subtree change).
  p.applyBlockers(true, true);
  assertEq("L) v1.4.14 — applyBlockers re-applies inline reveal to the new element",
    newEl.style.getPropertyValue("display"), "block");
  assertEq("L) v1.4.14 — new element's display is !important",
    newEl.style.getPropertyPriority("display"), "important");
}

// ===== M — v1.4.14 inline reveal cleared on real video navigation =====
{
  const body = makeBody();
  const el = makeEl();
  const dom = makeDOM({ "ytd-comments#comments": [el] });
  const p = makeV1414(body, dom);
  p.applyBlockers(true, true);
  p.clickShowComments();
  assertEq("M) v1.4.14 — pre-nav revealed", elsHaveInlineReveal(dom), true);
  p.loc.search = "?v=NEW999";
  p.urlPollTick();
  assertEq("M) v1.4.14 — real nav clears inline reveal", elsHaveInlineReveal(dom), false);
  assertEq("M) v1.4.14 — data-cf-shown attribute removed", el.dataset.cfShown, undefined);
  assertEq("M) v1.4.14 — STATE reset", p.STATE.commentsManuallyShown, false);
}

// ===== N — v1.4.14 inline reveal preserved on spurious yt-navigate-finish =====
{
  const body = makeBody();
  const el = makeEl();
  const dom = makeDOM({ "ytd-comments#comments": [el] });
  const p = makeV1414(body, dom);
  p.applyBlockers(true, true);
  p.clickShowComments();
  p.ytNavigateFinish();        // same v=, no-op
  assertEq("N) v1.4.14 — spurious nav preserves inline reveal",
    elsHaveInlineReveal(dom), true);
  p.loc.search = "?v=ABC123&t=99";
  p.urlPollTick();
  assertEq("N) v1.4.14 — &t= URL change preserves inline reveal",
    elsHaveInlineReveal(dom), true);
}

// ===== O — v1.4.14 inline reveal NOT applied when comments blocker is off =====
{
  const body = makeBody();
  const el = makeEl();
  const dom = makeDOM({ "ytd-comments#comments": [el] });
  const p = makeV1414(body, dom);
  p.applyBlockers(false, true);     // commentsActive = false
  p.clickShowComments();            // user clicks — but blocker is off anyway
  // After applyBlockers re-runs with commentsActive false, reveal should clear
  p.applyBlockers(false, true);
  assertEq("O) v1.4.14 — blocker off → no inline reveal",
    elsHaveInlineReveal(dom), false);
}

// ===== P — v1.4.14 doesn't touch elements YT styles independently =====
// We use data-cf-shown to track only elements we touched. Elements without
// the marker (e.g. YT set display:none inline for its own reasons) are
// untouched by clearCommentsManualReveal.
{
  const body = makeBody();
  const ourEl = makeEl();
  const ytEl = makeEl();
  ytEl.style.setProperty("display", "none", "important");   // YT's own inline
  // ytEl does NOT have data-cf-shown set
  const dom = makeDOM({
    "ytd-comments#comments": [ourEl],
    "ytd-comments-header-renderer": [ytEl],
  });
  const p = makeV1414(body, dom);
  p.applyBlockers(true, true);
  p.clickShowComments();
  // ourEl is revealed via our inline style; ytEl is also tagged + revealed
  // because applyCommentsManualReveal walks all selectors. That's fine —
  // these are our intended targets.
  assertEq("P) ourEl revealed", ourEl.style.getPropertyValue("display"), "block");
  // Now simulate clearing — both should clean up (both were tagged).
  p.loc.search = "?v=DIFFERENT";
  p.urlPollTick();
  assertEq("P) ourEl cleared", ourEl.style.getPropertyValue("display"), "");
  assertEq("P) ytEl cleared", ytEl.style.getPropertyValue("display"), "");
  // Sanity: a NON-comments element that YT styled independently should
  // never be touched by us. We don't have a way to fabricate that in this
  // shim (DOM only knows about comments selectors), but the data-cf-shown
  // gate ensures clearCommentsManualReveal only touches what we tagged.
}

// ===== Q-pre — REGRESSION SENTINEL: v1.4.14 fails the toggle-off → toggle-on flow =====
// User clicks "Show comments" while blocker is on, then toggles the Comments
// blocker OFF in the popup, then toggles it back ON. v1.4.14's else branch
// in applyBlockers cleared the visible reveal but did NOT reset
// STATE.commentsManuallyShown — so when the blocker was toggled back ON the
// true branch re-applied the inline reveal from the pre-toggle-off click.
{
  const body = makeBody();
  const el = makeEl();
  const dom = makeDOM({ "ytd-comments#comments": [el] });
  const p = makeV1414(body, dom);
  p.applyBlockers(true, true);
  p.clickShowComments();
  assertEq("Q-pre) v1.4.14 — click reveals", elsHaveInlineReveal(dom), true);
  // Popup toggles Comments blocker OFF.
  p.applyBlockers(false, true);
  // The visible reveal is cleared (clearCommentsManualReveal ran)…
  assertEq("Q-pre) v1.4.14 — toggle-off clears the inline reveal",
    elsHaveInlineReveal(dom), false);
  // …BUT the state flag is sticky (THE v1.4.14 BUG).
  assertEq("Q-pre) v1.4.14 — toggle-off LEAVES STATE.commentsManuallyShown sticky (THE BUG)",
    p.STATE.commentsManuallyShown, true);
  // So when the user toggles the blocker back ON, the stale flag re-applies
  // the inline reveal — the toggle appears to do nothing.
  p.applyBlockers(true, true);
  assertEq("Q-pre) v1.4.14 — toggle-on STILL reveals (stale state re-applies — THE USER-VISIBLE BUG)",
    elsHaveInlineReveal(dom), true);
}

// ===== Q — v1.4.15 toggle-off + toggle-on cleanly resets the reveal =====
// Repro of the v1.4.14 regression with the v1.4.15 fix applied. The else
// branch now also resets STATE.commentsManuallyShown so toggling the
// Comments blocker back ON behaves as fresh (button visible, comments
// hidden, no inline reveal).
{
  const body = makeBody();
  const el = makeEl();
  const dom = makeDOM({ "ytd-comments#comments": [el] });
  const p = makeV1415(body, dom);

  // 1. Comments blocker ON, on /watch.
  p.applyBlockers(true, true);
  assertEq("Q1) blocker ON — no reveal yet", elsHaveInlineReveal(dom), false);
  assertEq("Q1) restore button injected", p.STATE.commentsBtnAdded, true);

  // 2. User clicks Show comments.
  p.clickShowComments();
  assertEq("Q2) click applies inline reveal", elsHaveInlineReveal(dom), true);
  assertEq("Q2) STATE manualShown=true", p.STATE.commentsManuallyShown, true);

  // 3. User toggles Comments blocker OFF in popup → applyBlockers(false, true).
  p.applyBlockers(false, true);
  assertEq("Q3) toggle-off clears the inline reveal", elsHaveInlineReveal(dom), false);
  assertEq("Q3) toggle-off resets STATE.commentsManuallyShown (THE FIX)",
    p.STATE.commentsManuallyShown, false);
  assertEq("Q3) toggle-off removes restore button", p.STATE.commentsBtnAdded, false);
  assertEq("Q3) cf-comments-shown body class cleared",
    body.classList.contains("cf-comments-shown"), false);
  assertEq("Q3) data-cf-shown attribute cleared from element",
    el.dataset.cfShown, undefined);

  // 4. User toggles Comments blocker back ON → applyBlockers(true, true).
  p.applyBlockers(true, true);
  assertEq("Q4) toggle-on re-blocks — no stale reveal", elsHaveInlineReveal(dom), false);
  assertEq("Q4) STATE still fresh after toggle-on", p.STATE.commentsManuallyShown, false);
  assertEq("Q4) restore button re-injected", p.STATE.commentsBtnAdded, true);
  assertEq("Q4) cf-block-comments re-applied",
    body.classList.contains("cf-block-comments"), true);

  // 5. Fresh click still works.
  p.clickShowComments();
  assertEq("Q5) fresh click re-reveals", elsHaveInlineReveal(dom), true);
  assertEq("Q5) STATE re-set", p.STATE.commentsManuallyShown, true);
}

// ===== Q-nav — v1.4.15 still resets cleanly on real navigation =====
// Sanity that the v1.4.15 toggle-off reset didn't break the v1.4.13 nav
// path. Real video change must still clear reveal + state.
{
  const body = makeBody();
  const el = makeEl();
  const dom = makeDOM({ "ytd-comments#comments": [el] });
  const p = makeV1415(body, dom);
  p.applyBlockers(true, true);
  p.clickShowComments();
  p.loc.search = "?v=NEW";
  p.urlPollTick();
  assertEq("Q-nav) real nav clears reveal", elsHaveInlineReveal(dom), false);
  assertEq("Q-nav) real nav resets STATE", p.STATE.commentsManuallyShown, false);
}

// ===== Q-mut — v1.4.15 still survives external body-class wipe =====
// Sanity that the v1.4.14 J-scenario (external body-class wipe doesn't
// kill the reveal) still passes — inline style on the element is what
// keeps comments visible, not the body class.
{
  const body = makeBody();
  const el = makeEl();
  const dom = makeDOM({ "ytd-comments#comments": [el] });
  const p = makeV1415(body, dom);
  p.applyBlockers(true, true);
  p.clickShowComments();
  body._externalClassWipe();
  assertEq("Q-mut) external body-class wipe doesn't kill inline reveal",
    elsHaveInlineReveal(dom), true);
}

process.stdout.write("\n");
console.log(`SHOW-COMMENTS PERSIST: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
