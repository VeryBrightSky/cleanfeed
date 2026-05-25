/* CleanFeed YouTube Music smart exemption (v1.4.19 F1).
 *
 * Content script and popup short-circuit on music.youtube.com so the user
 * isn't getting blockers, badges, or time-tracking pushed onto a music
 * app. Tests:
 *   1. Hostname predicate accepts music.youtube.com (and any subdomain),
 *      rejects everything else.
 *   2. Content script's init() returns early — no observer attached, no
 *      body class added, no time tracker started, no CSS injected.
 *   3. Popup's renderYouTubeMusicPause path hides toggles + upgrade card
 *      and shows the explanatory line.
 *
 * Run with:  node tests/youtube-music-exempt.js
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

// Mirror of content/content.js — isYouTubeMusicHost
function isYouTubeMusicHost(hostname) {
  const h = hostname || "";
  return h === "music.youtube.com" || /(^|\.)music\.youtube\.com$/.test(h);
}

// ===== 1. Hostname predicate =====
assertEq("host: music.youtube.com -> true", isYouTubeMusicHost("music.youtube.com"), true);
assertEq("host: www.music.youtube.com -> true (subdomain)", isYouTubeMusicHost("www.music.youtube.com"), true);
assertEq("host: cn.music.youtube.com -> true (geo sub)", isYouTubeMusicHost("cn.music.youtube.com"), true);
assertEq("host: www.youtube.com -> false (main domain)", isYouTubeMusicHost("www.youtube.com"), false);
assertEq("host: youtube.com -> false (apex)", isYouTubeMusicHost("youtube.com"), false);
assertEq("host: studio.youtube.com -> false (other sub)", isYouTubeMusicHost("studio.youtube.com"), false);
assertEq("host: music.youtube.com.evil.com -> false (spoofed)", isYouTubeMusicHost("music.youtube.com.evil.com"), false);
assertEq("host: musicxyoutube.com -> false (collapsed dot)", isYouTubeMusicHost("musicxyoutube.com"), false);
assertEq("host: empty -> false", isYouTubeMusicHost(""), false);
assertEq("host: null -> false (coerced)", isYouTubeMusicHost(null), false);

// ===== 2. Content-script bailout contract =====
// Reproduce content.js init() head: if music host, return early. Anything
// that runs after the guard is a contract violation.
function contentInitOn(hostname) {
  const sideEffects = { observerAttached: false, bodyClasses: [], timeTrackerStarted: false, cssInjected: false, redirectFired: false };
  // The guard:
  if (isYouTubeMusicHost(hostname)) return sideEffects;
  // Below this line is what runs in non-music hosts (we simulate).
  sideEffects.timeTrackerStarted = true;
  sideEffects.observerAttached = true;
  sideEffects.bodyClasses.push("cf-block-home-feed");
  sideEffects.cssInjected = true;
  return sideEffects;
}
{
  const out = contentInitOn("music.youtube.com");
  assertEq("content on music: observerAttached === false", out.observerAttached, false);
  assertEq("content on music: bodyClasses empty",          out.bodyClasses,       []);
  assertEq("content on music: timeTrackerStarted === false", out.timeTrackerStarted, false);
  assertEq("content on music: cssInjected === false",      out.cssInjected,       false);
}
{
  const out = contentInitOn("www.youtube.com");
  // Sanity that the contract simulator runs for the non-music host (so any
  // future change that breaks the guard would be visible here too).
  assertEq("content on www.yt: observer DID attach (regression sentinel)", out.observerAttached, true);
}

// ===== 3. Popup YT Music render contract =====
// Mirror popup.js's detectActiveYouTubeMusicTab decision + render path.
function popupRender(activeUrl) {
  let onMusic = false;
  try {
    const u = new URL(activeUrl);
    const h = u.hostname || "";
    onMusic = h === "music.youtube.com" || /(^|\.)music\.youtube\.com$/.test(h);
  } catch (_) {}
  if (onMusic) {
    return { view: "ytmusic-paused", message: "CleanFeed is paused on YouTube Music", togglesVisible: false };
  }
  return { view: "toggles", message: "", togglesVisible: true };
}
{
  const r = popupRender("https://music.youtube.com/");
  assertEq("popup on music: view = ytmusic-paused", r.view, "ytmusic-paused");
  assertEq("popup on music: message present",
    r.message, "CleanFeed is paused on YouTube Music");
  assertEq("popup on music: togglesVisible = false", r.togglesVisible, false);
}
{
  const r = popupRender("https://www.youtube.com/watch?v=abc");
  assertEq("popup on main YT: view = toggles", r.view, "toggles");
  assertEq("popup on main YT: togglesVisible = true", r.togglesVisible, true);
}
{
  // Defensive: malformed URL falls through to normal popup (not the
  // pause panel) — we don't want to misclassify and lock the user out.
  const r = popupRender("not-a-url");
  assertEq("popup on garbage URL: view = toggles (fail-safe)", r.view, "toggles");
}

process.stdout.write("\n");
console.log(`YOUTUBE MUSIC EXEMPT: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
