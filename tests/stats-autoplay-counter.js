/* CleanFeed v1.4.20-alpha (Phase 1) — autoplay-counterfactual tracker.
 *
 * On /watch pages, content/content.js captures the FIRST "Up next" sidebar
 * candidate (videoId + duration) plus a snapshot of YT's autoplay-toggle
 * state. When the user navigates AWAY from /watch — to another /watch?v=
 * or to a non-/watch URL or via pagehide — we evaluate:
 *
 *   - no candidate captured        -> skip (sidebar never loaded in time)
 *   - autoplay was OFF at capture  -> skip (per spec)
 *   - user clicked the sidebar     -> skip (active choice, not avoided)
 *   - dest = captured next videoId -> skip (they watched it)
 *   - otherwise                    -> INCREMENT videos+1, minutes+=dur
 *                                     (10-min fallback if duration unknown)
 *
 * Tests:
 *   1. /watch -> /feed/subscriptions with captured candidate + autoplay on
 *      and no sidebar click -> +1 video, +duration minutes.
 *   2. /watch -> /watch?v=<captured-next> -> NO increment (watched it).
 *   3. /watch -> /watch?v=<different> with sidebar click -> NO increment.
 *   4. /watch with YT autoplay OFF at capture -> NO increment regardless.
 *   5. /watch with no candidate captured (sidebar never seen) -> NO increment.
 *   6. Duration parsing handles MM:SS, H:MM:SS, single-number, missing.
 *   7. pagehide on /watch is treated as a destination ≠ captured-next
 *      and increments unless an exclusion applies.
 *   8. Sequential video navigations re-capture per video; old captures
 *      don't leak into new evaluations.
 *   9. Failed duration parse falls back to 10-minute estimate.
 *
 * Run with:  node tests/stats-autoplay-counter.js
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
function assertTrue(name, cond) {
  if (cond) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}`); }
}

// ----- helpers (mirror content/content.js) ------------------------------
function parseDurationToSec(txt) {
  if (!txt) return 0;
  const parts = String(txt).trim().split(":").map((s) => parseInt(s, 10));
  if (parts.some((n) => !isFinite(n) || isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

// Mirror of _evaluateAutoplayAvoided: pure decision function returning
// { increment: bool, minutes: number }.
function evaluateAvoided(state, prevIdentity, newIdentity) {
  if (!prevIdentity || prevIdentity.indexOf("/watch?v=") !== 0) return { increment: false, minutes: 0 };
  const prevVideoId = prevIdentity.slice("/watch?v=".length);
  if (state.watchVideoId !== prevVideoId) return { increment: false, minutes: 0 };
  if (!state.capturedNext) return { increment: false, minutes: 0 };
  if (!state.autoplayWasOn) return { increment: false, minutes: 0 };
  if (state.userClickedSidebar) return { increment: false, minutes: 0 };
  let destVideoId = "";
  if (newIdentity && newIdentity.indexOf("/watch?v=") === 0) {
    destVideoId = newIdentity.slice("/watch?v=".length);
  }
  if (destVideoId && destVideoId === state.capturedNext.videoId) {
    return { increment: false, minutes: 0 };
  }
  const dur = state.capturedNext.duration_sec;
  const mins = dur > 0 ? dur / 60 : 10;
  return { increment: true, minutes: mins };
}

// Make a fresh capture state for a /watch page.
function newState(videoId, opts = {}) {
  return {
    watchVideoId: videoId,
    capturedNext: opts.capturedNext === undefined
      ? { videoId: "NEXT123", duration_sec: 600 }   // default: 10 min sidebar candidate
      : opts.capturedNext,
    autoplayWasOn: opts.autoplayWasOn !== false,    // default ON
    userClickedSidebar: !!opts.userClickedSidebar,
  };
}

// ===== 1. /watch -> /feed/subscriptions: avoided =====
{
  const s = newState("ABC", { capturedNext: { videoId: "NEXT123", duration_sec: 600 } });
  const r = evaluateAvoided(s, "/watch?v=ABC", "/feed/subscriptions?v=");
  assertEq("1) increment fired", r.increment, true);
  assertEq("1) minutes = 10 (600s / 60)", r.minutes, 10);
}

// ===== 2. /watch -> /watch?v=<captured-next>: NOT avoided =====
{
  const s = newState("ABC");
  const r = evaluateAvoided(s, "/watch?v=ABC", "/watch?v=NEXT123");
  assertEq("2) watched the predicted next -> no increment", r.increment, false);
}

// ===== 3. /watch -> /watch?v=<different> with sidebar click: NOT avoided =====
{
  const s = newState("ABC", { userClickedSidebar: true });
  const r = evaluateAvoided(s, "/watch?v=ABC", "/watch?v=OTHER999");
  assertEq("3) user clicked sidebar (any /watch?v= dest) -> no increment", r.increment, false);
}

// ===== 4. /watch with YT autoplay OFF at capture: NOT avoided =====
{
  const s = newState("ABC", { autoplayWasOn: false });
  const r = evaluateAvoided(s, "/watch?v=ABC", "/feed/subscriptions?v=");
  assertEq("4) autoplay was OFF -> no increment regardless of destination", r.increment, false);
}

// ===== 5. No candidate captured (sidebar never visible): NOT avoided =====
{
  const s = newState("ABC", { capturedNext: null });
  const r = evaluateAvoided(s, "/watch?v=ABC", "/feed/subscriptions?v=");
  assertEq("5) no captured next -> no increment", r.increment, false);
}

// ===== 6. Duration parsing =====
assertEq("6a) MM:SS '12:34' -> 754 sec", parseDurationToSec("12:34"), 12 * 60 + 34);
assertEq("6b) H:MM:SS '1:23:45' -> 5025 sec", parseDurationToSec("1:23:45"), 3600 + 23 * 60 + 45);
assertEq("6c) '0:42' -> 42 sec",          parseDurationToSec("0:42"), 42);
assertEq("6d) single '42' -> 42 sec",     parseDurationToSec("42"), 42);
assertEq("6e) empty -> 0",                 parseDurationToSec(""), 0);
assertEq("6f) garbage 'live' -> 0 (not a number)", parseDurationToSec("live"), 0);
assertEq("6g) whitespace ' 5:00 ' -> 300", parseDurationToSec(" 5:00 "), 300);

// ===== 7. pagehide: dest = "" (unknown) is treated as avoided =====
// content.js calls _evaluateAutoplayAvoided(lastNav, "") on pagehide from
// /watch. Empty newIdentity means destVideoId stays "" which never equals
// capturedNext.videoId — so we always increment unless another gate fires.
{
  const s = newState("ABC");
  const r = evaluateAvoided(s, "/watch?v=ABC", "");
  assertEq("7) pagehide from /watch with normal capture -> increment", r.increment, true);
  assertEq("7) minutes = 10", r.minutes, 10);
}
{
  const s = newState("ABC", { userClickedSidebar: true });
  const r = evaluateAvoided(s, "/watch?v=ABC", "");
  assertEq("7) pagehide after sidebar click -> NO increment", r.increment, false);
}

// ===== 8. Sequential video navs — old captures don't leak =====
// Simulate: /watch?v=A captures candidate NEXT_A, user nav to /watch?v=B
// (which is NOT NEXT_A), then nav off to /feed/subs. The first nav should
// increment because B != NEXT_A; the second eval should use the *new*
// capture state (which the caller would have refreshed for video B).
{
  let s = newState("A", { capturedNext: { videoId: "NEXT_A", duration_sec: 300 } });
  const r1 = evaluateAvoided(s, "/watch?v=A", "/watch?v=B");
  assertEq("8) nav A→B (B != NEXT_A) -> increment", r1.increment, true);
  assertEq("8) minutes = 5 (300s / 60)", r1.minutes, 5);
  // _captureAutoplayContext would have reset state for B with its own candidate
  s = newState("B", { capturedNext: { videoId: "NEXT_B", duration_sec: 900 } });
  const r2 = evaluateAvoided(s, "/watch?v=B", "/feed/subscriptions?v=");
  assertEq("8) nav B→subs with fresh capture for B -> increment", r2.increment, true);
  assertEq("8) minutes = 15 (900s / 60)", r2.minutes, 15);
}

// ===== 9. Failed duration parse falls back to 10-minute estimate =====
{
  const s = newState("ABC", { capturedNext: { videoId: "NEXT", duration_sec: 0 } });
  const r = evaluateAvoided(s, "/watch?v=ABC", "/feed/subscriptions?v=");
  assertEq("9) duration_sec=0 -> minutes fallback to 10", r.minutes, 10);
  assertEq("9) still increments",                          r.increment, true);
}

// ===== 10. Prev URL was NOT /watch (defensive): never increments =====
{
  const s = newState("ABC");
  const r = evaluateAvoided(s, "/feed/subscriptions?v=", "/watch?v=ANY");
  assertEq("10) leaving non-/watch page is not an autoplay event", r.increment, false);
}

// ===== 11. Capture videoId mismatch (race): skip rather than misattribute =====
// If a fast nav causes STATE.watchVideoId to be re-pointed to a new video
// before we evaluate the OLD nav, skip — we'd otherwise attribute the OLD
// nav's "avoided" to the NEW video's captured candidate, which is wrong.
{
  const s = newState("BBB");                   // state has been overwritten to B
  s.capturedNext = { videoId: "NEXT_B", duration_sec: 600 };
  const r = evaluateAvoided(s, "/watch?v=AAA", "/feed/subscriptions?v=");
  assertEq("11) state.watchVideoId != prevVideoId -> skip (race guard)",
    r.increment, false);
}

process.stdout.write("\n");
console.log(`STATS AUTOPLAY COUNTER: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
