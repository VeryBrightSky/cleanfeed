/* CleanFeed "Show comments" persistence (v1.4.12).
 *
 * Audit category-1 finding 1.1: applyBlockers() unconditionally stripped
 * cf-comments-shown on every MutationObserver tick (~100ms after any
 * YouTube DOM mutation), so the user's manual reveal survived only for
 * the time between click and next mutation. v1.4.12 persists the choice
 * in STATE.commentsManuallyShown, resets it only on yt-navigate-finish /
 * URL change.
 *
 * This test re-implements the relevant state transitions in plain JS
 * (mirroring content/content.js v1.4.12) and asserts:
 *   - click sets the state and adds the class
 *   - simulated applyBlockers re-runs preserve the class
 *   - navigation resets the state and clears the class
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

// Minimal body.classList shim
function makeBody() {
  const classes = new Set();
  return {
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
    _peek() { return Array.from(classes).sort(); },
  };
}

// ---- pre-v1.4.11 (buggy) — strips cf-comments-shown unconditionally ----
function v1411_applyBlockers(body, commentsActive) {
  for (const c of ["cf-block-comments", "cf-paused"]) body.classList.remove(c);
  body.classList.remove("cf-comments-shown");        // ← the bug
  if (commentsActive) body.classList.add("cf-block-comments");
}

// ---- v1.4.12 fixed — respects STATE.commentsManuallyShown ----
function makeV1412(body) {
  const STATE = { commentsManuallyShown: false };

  function applyBlockers(commentsActive, onWatch) {
    for (const c of ["cf-block-comments", "cf-paused"]) body.classList.remove(c);
    // v1.4.12 — NO unconditional remove("cf-comments-shown") here.
    if (commentsActive) body.classList.add("cf-block-comments");
    if (commentsActive && onWatch) {
      if (STATE.commentsManuallyShown) {
        body.classList.add("cf-comments-shown");
      } else {
        body.classList.remove("cf-comments-shown");
      }
    } else {
      body.classList.remove("cf-comments-shown");
    }
  }

  function clickShowComments() {
    STATE.commentsManuallyShown = true;
    body.classList.add("cf-comments-shown");
  }

  function onNavigate() {
    STATE.commentsManuallyShown = false;
    body.classList.remove("cf-comments-shown");
  }

  return { STATE, applyBlockers, clickShowComments, onNavigate };
}

// ===== Scenario A — v1.4.11 baseline demonstrates the flicker bug =====
{
  const body = makeBody();
  // initial state: comments blocker active on /watch
  v1411_applyBlockers(body, true);
  // user clicks Show comments
  body.classList.add("cf-comments-shown");
  assertEq("A) v1.4.11 — comments visible after click",
    body.classList.contains("cf-comments-shown"), true);
  // YT DOM mutation triggers applyBlockers re-run within ~100ms
  v1411_applyBlockers(body, true);
  assertEq("A) v1.4.11 — re-run strips cf-comments-shown (THE BUG)",
    body.classList.contains("cf-comments-shown"), false);
}

// ===== Scenario B — v1.4.12 preserves the reveal across re-runs =====
{
  const body = makeBody();
  const p = makeV1412(body);
  p.applyBlockers(true, true);
  assertEq("B) initial — comments hidden", body.classList.contains("cf-comments-shown"), false);
  assertEq("B) initial — cf-block-comments on", body.classList.contains("cf-block-comments"), true);
  // user clicks Show comments
  p.clickShowComments();
  assertEq("B) after click — cf-comments-shown on", body.classList.contains("cf-comments-shown"), true);
  assertEq("B) STATE.commentsManuallyShown = true", p.STATE.commentsManuallyShown, true);
  // simulate 10 rapid applyBlockers re-runs (the MutationObserver storm)
  for (let i = 0; i < 10; i++) p.applyBlockers(true, true);
  assertEq("B) after 10 re-runs — cf-comments-shown STILL on", body.classList.contains("cf-comments-shown"), true);
  assertEq("B) cf-block-comments still active", body.classList.contains("cf-block-comments"), true);
}

// ===== Scenario C — navigation resets the reveal =====
{
  const body = makeBody();
  const p = makeV1412(body);
  p.applyBlockers(true, true);
  p.clickShowComments();
  assertEq("C) revealed pre-nav", body.classList.contains("cf-comments-shown"), true);
  // user clicks a new video — YT fires yt-navigate-finish
  p.onNavigate();
  assertEq("C) navigation cleared the reveal", body.classList.contains("cf-comments-shown"), false);
  assertEq("C) STATE.commentsManuallyShown reset", p.STATE.commentsManuallyShown, false);
  // next applyBlockers after nav respects the reset
  p.applyBlockers(true, true);
  assertEq("C) post-nav applyBlockers keeps comments hidden", body.classList.contains("cf-comments-shown"), false);
}

// ===== Scenario D — comments blocker toggled OFF mid-page-view =====
// User reveals comments, then disables the Comments blocker.
// cf-comments-shown should be removed (since commentsActive=false).
{
  const body = makeBody();
  const p = makeV1412(body);
  p.applyBlockers(true, true);
  p.clickShowComments();
  assertEq("D) revealed", body.classList.contains("cf-comments-shown"), true);
  // user turns OFF comments blocker
  p.applyBlockers(false, true);
  assertEq("D) blocker-off clears cf-comments-shown (no longer relevant)",
    body.classList.contains("cf-comments-shown"), false);
  // and re-enabling without nav re-applies the manual reveal (state still true)
  p.applyBlockers(true, true);
  assertEq("D) blocker re-on respects pre-existing reveal state",
    body.classList.contains("cf-comments-shown"), true);
}

// ===== Scenario E — off-watch pages don't gain the class ======
{
  const body = makeBody();
  const p = makeV1412(body);
  // pretend user revealed on a /watch page, then navigated to home
  p.clickShowComments();
  p.applyBlockers(true, false);  // not on /watch
  assertEq("E) off-watch — cf-comments-shown removed even if state=true",
    body.classList.contains("cf-comments-shown"), false);
}

process.stdout.write("\n");
console.log(`SHOW-COMMENTS PERSIST: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
