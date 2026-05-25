/* CleanFeed Homepage → Subscriptions redirect (v1.4.19 F2).
 *
 * Free-tier opt-in toggle (default OFF). When ON, content.js redirects
 * youtube.com/ to youtube.com/feed/subscriptions. Critical invariants:
 *   • Only the bare root path triggers the redirect.
 *   • /watch, /results, /channel, /shorts, /@handle, /feed/anything-else
 *     MUST NOT be redirected.
 *   • The toggle being OFF means no redirect regardless of path.
 *   • Tracking-only query parameters (utm_*, gclid, etc.) on the root
 *     still trigger the redirect — it's still the bare homepage.
 *
 * Run with:  node tests/homepage-redirect.js
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

// ----- helpers (mirror content/content.js) ------------------------------
function _isBareHomepage(loc) {
  const p = loc.pathname || "";
  if (p !== "/" && p !== "") return false;
  const h = loc.hash || "";
  if (h && h.length > 1 && h.charAt(1) !== "?") return false;
  return true;
}
function makeMaybeRedirect(STATE) {
  const calls = [];
  function maybeRedirect(loc) {
    if (!STATE.redirectHomeToSubs) return false;
    if (!_isBareHomepage(loc)) return false;
    if ((loc.pathname || "").indexOf("/feed/subscriptions") === 0) return false;
    calls.push("/feed/subscriptions");
    return true;
  }
  return { maybeRedirect, calls };
}

// Helper to build a fake `location` object.
function L(pathname, search = "", hash = "") {
  return { pathname, search, hash };
}

// ===== 1. Toggle OFF — never redirects regardless of path =====
{
  const STATE = { redirectHomeToSubs: false };
  const { maybeRedirect, calls } = makeMaybeRedirect(STATE);
  for (const path of ["/", "/watch", "/results", "/feed/subscriptions"]) {
    assertEq(`OFF + ${path} -> no redirect`, maybeRedirect(L(path)), false);
  }
  assertEq("OFF total calls", calls.length, 0);
}

// ===== 2. Toggle ON — only bare root redirects =====
{
  const STATE = { redirectHomeToSubs: true };
  const { maybeRedirect, calls } = makeMaybeRedirect(STATE);
  assertEq("ON + /          -> redirect", maybeRedirect(L("/")), true);
  assertEq("ON + empty path -> redirect", maybeRedirect(L("")), true);
  assertEq("ON + / + ?utm_source=newsletter -> redirect (tracking params on root)",
    maybeRedirect(L("/", "?utm_source=newsletter")), true);
  assertEq("ON + / + ?gclid=xyz -> redirect (gclid on root)",
    maybeRedirect(L("/", "?gclid=xyz")), true);
  assertEq("ON total redirect count so far = 4", calls.length, 4);
}

// ===== 3. Toggle ON — non-bare paths must NOT redirect =====
{
  const STATE = { redirectHomeToSubs: true };
  const { maybeRedirect } = makeMaybeRedirect(STATE);
  const nonBare = [
    "/watch",
    "/watch?v=dQw4w9WgXcQ",
    "/results",
    "/results?search_query=cats",
    "/channel/UCxyz",
    "/@SomeHandle",
    "/@SomeHandle/videos",
    "/shorts",
    "/shorts/abc123",
    "/feed/subscriptions",
    "/feed/subscriptions?flow=2",
    "/feed/trending",
    "/feed/library",
    "/feed/history",
    "/feed/playlists",
    "/feed/explore",
    "/playlist?list=PLxyz",
    "/account",
    "/account_advanced",
  ];
  for (const path of nonBare) {
    const search = path.indexOf("?") > 0 ? "?" + path.split("?")[1] : "";
    const pure = path.indexOf("?") > 0 ? path.split("?")[0] : path;
    assertEq(`ON + ${path} -> NO redirect`, maybeRedirect(L(pure, search)), false);
  }
}

// ===== 4. Already on /feed/subscriptions — no re-redirect loop =====
{
  const STATE = { redirectHomeToSubs: true };
  const { maybeRedirect } = makeMaybeRedirect(STATE);
  assertEq("ON + /feed/subscriptions -> NO redirect (no loop)",
    maybeRedirect(L("/feed/subscriptions")), false);
}

// ===== 5. Bare root with an in-app hash route -> NOT redirected =====
// YT occasionally uses #/foo for hash routes (legacy embeds). If the hash
// starts with "#/" we treat the URL as non-bare — there's an intent we
// shouldn't override.
{
  const STATE = { redirectHomeToSubs: true };
  const { maybeRedirect } = makeMaybeRedirect(STATE);
  assertEq("ON + / with hash #/foo -> NO redirect",
    maybeRedirect(L("/", "", "#/foo")), false);
  // But #?x= is treated as a tracking-style hash and is still bare-root.
  assertEq("ON + / with hash #? -> redirect (tracking-style hash)",
    maybeRedirect(L("/", "", "#?utm=hash")), true);
}

// ===== 6. Multiple toggle on/off cycles don't leak state =====
{
  const STATE = { redirectHomeToSubs: false };
  const { maybeRedirect, calls } = makeMaybeRedirect(STATE);
  STATE.redirectHomeToSubs = true;
  maybeRedirect(L("/"));
  STATE.redirectHomeToSubs = false;
  maybeRedirect(L("/"));
  STATE.redirectHomeToSubs = true;
  maybeRedirect(L("/"));
  assertEq("3 cycles: 2 redirects fired", calls.length, 2);
}

process.stdout.write("\n");
console.log(`HOMEPAGE REDIRECT: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
