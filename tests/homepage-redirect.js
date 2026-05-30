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
  // v1.5.0 phase 2 — explicit URL bypass.
  const s = loc.search || "";
  if (s.indexOf("cf_bypass=1") >= 0) return false;
  return true;
}

// v1.5.0 phase 2 — mirror of content.js _resolveHomepageDestinationURL.
// Inputs: STATE.cf_homepage_destination. Outputs: target URL string or
// null for malformed (which the caller falls back to /feed/subscriptions).
function _resolveDestURL(d, extId) {
  if (d === "library")  return "/feed/library";
  if (d === "history")  return "/feed/history";
  if (d === "blank")    return "chrome-extension://" + (extId || "EXT") + "/onboarding/blank.html";
  if (d && typeof d === "object") {
    if (d.type === "playlist") {
      const u = String(d.url || "").trim();
      return u || null;
    }
    if (d.type === "channel") {
      const h = String(d.handle || "").trim();
      if (!h) return null;
      if (/^https?:\/\//i.test(h)) return h;
      if (h.charAt(0) === "@") return "/" + h;
      if (h.charAt(0) === "/") return h;
      return "/@" + h;
    }
  }
  return "/feed/subscriptions";
}

function makeMaybeRedirect(STATE) {
  const calls = [];
  function maybeRedirect(loc) {
    if (!STATE.redirectHomeToSubs) return false;
    if (!_isBareHomepage(loc)) return false;
    // v1.5.0 phase 2 — one-shot bypass + destination resolver.
    if (STATE.cf_skip_next_homepage_redirect) {
      STATE.cf_skip_next_homepage_redirect = false;
      return false;
    }
    const target = _resolveDestURL(STATE.cf_homepage_destination || "subscriptions", "EXT")
                || "/feed/subscriptions";
    if (target === "/" || target === "") return false;
    if ((loc.pathname || "").indexOf(target) === 0) return false;
    calls.push(target);
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

// =====================================================================
// v1.5.0 phase 2 — destination resolver tests
// =====================================================================

// ===== 7. Default destination = "subscriptions" (backward-compat) ======
{
  const STATE = { redirectHomeToSubs: true };       // no cf_homepage_destination set
  const { maybeRedirect, calls } = makeMaybeRedirect(STATE);
  assertEq("7) default → /feed/subscriptions",
    maybeRedirect(L("/")), true);
  assertEq("7) /feed/subscriptions was the target",
    calls[calls.length - 1], "/feed/subscriptions");
}

// ===== 8. Explicit destinations route to the right URL =================
{
  const cases = [
    { d: "subscriptions", url: "/feed/subscriptions" },
    { d: "library",       url: "/feed/library" },
    { d: "history",       url: "/feed/history" },
  ];
  for (const c of cases) {
    const STATE = { redirectHomeToSubs: true, cf_homepage_destination: c.d };
    const { maybeRedirect, calls } = makeMaybeRedirect(STATE);
    maybeRedirect(L("/"));
    assertEq(`8.${c.d}) ${c.d} → ${c.url}`, calls[0], c.url);
  }
}

// ===== 9. blank → chrome-extension:// URL ==============================
{
  const STATE = { redirectHomeToSubs: true, cf_homepage_destination: "blank" };
  const { maybeRedirect, calls } = makeMaybeRedirect(STATE);
  maybeRedirect(L("/"));
  assertEq("9a) blank → chrome-extension:// URL prefix",
    calls[0].indexOf("chrome-extension://") === 0, true);
  assertEq("9b) blank → onboarding/blank.html path",
    calls[0].indexOf("/onboarding/blank.html") >= 0, true);
}

// ===== 10. playlist destination — URL passthrough ======================
{
  const STATE = {
    redirectHomeToSubs: true,
    cf_homepage_destination: { type: "playlist", url: "https://www.youtube.com/playlist?list=PLabc123" },
  };
  const { maybeRedirect, calls } = makeMaybeRedirect(STATE);
  maybeRedirect(L("/"));
  assertEq("10a) playlist → exact URL",
    calls[0], "https://www.youtube.com/playlist?list=PLabc123");
}
{
  // Empty playlist URL → fallback to /feed/subscriptions (resolver returns
  // null, maybeRedirect's || guard rescues).
  const STATE = {
    redirectHomeToSubs: true,
    cf_homepage_destination: { type: "playlist", url: "" },
  };
  const { maybeRedirect, calls } = makeMaybeRedirect(STATE);
  maybeRedirect(L("/"));
  assertEq("10b) empty playlist URL → /feed/subscriptions fallback",
    calls[0], "/feed/subscriptions");
}

// ===== 11. channel destination — handle + full-URL forms ===============
{
  // "@somechannel" — bare handle
  const STATE = {
    redirectHomeToSubs: true,
    cf_homepage_destination: { type: "channel", handle: "@somechannel" },
  };
  const { maybeRedirect, calls } = makeMaybeRedirect(STATE);
  maybeRedirect(L("/"));
  assertEq("11a) @somechannel → /@somechannel",
    calls[0], "/@somechannel");
}
{
  // "somechannel" — no leading @
  const STATE = {
    redirectHomeToSubs: true,
    cf_homepage_destination: { type: "channel", handle: "somechannel" },
  };
  const { maybeRedirect, calls } = makeMaybeRedirect(STATE);
  maybeRedirect(L("/"));
  assertEq("11b) somechannel → /@somechannel",
    calls[0], "/@somechannel");
}
{
  // Full URL — passthrough.
  const STATE = {
    redirectHomeToSubs: true,
    cf_homepage_destination: { type: "channel", handle: "https://www.youtube.com/@kurzgesagt" },
  };
  const { maybeRedirect, calls } = makeMaybeRedirect(STATE);
  maybeRedirect(L("/"));
  assertEq("11c) full channel URL → passthrough",
    calls[0], "https://www.youtube.com/@kurzgesagt");
}
{
  // Empty handle → fallback.
  const STATE = {
    redirectHomeToSubs: true,
    cf_homepage_destination: { type: "channel", handle: "" },
  };
  const { maybeRedirect, calls } = makeMaybeRedirect(STATE);
  maybeRedirect(L("/"));
  assertEq("11d) empty channel handle → /feed/subscriptions fallback",
    calls[0], "/feed/subscriptions");
}

// ===== 12. URL query bypass (?cf_bypass=1) =============================
{
  const STATE = { redirectHomeToSubs: true, cf_homepage_destination: "library" };
  const { maybeRedirect, calls } = makeMaybeRedirect(STATE);
  assertEq("12a) ?cf_bypass=1 on bare root → no redirect",
    maybeRedirect(L("/", "?cf_bypass=1")), false);
  assertEq("12b) zero calls", calls.length, 0);
}

// ===== 13. One-shot bypass flag (set by blank.html) ====================
{
  const STATE = {
    redirectHomeToSubs: true,
    cf_homepage_destination: "library",
    cf_skip_next_homepage_redirect: true,
  };
  const { maybeRedirect, calls } = makeMaybeRedirect(STATE);
  assertEq("13a) bypass flag → no redirect on first call",
    maybeRedirect(L("/")), false);
  assertEq("13b) flag cleared after firing",
    STATE.cf_skip_next_homepage_redirect, false);
  // Second call AFTER bypass should redirect normally.
  assertEq("13c) second call → redirect resumes",
    maybeRedirect(L("/")), true);
  assertEq("13d) library destination won",
    calls[0], "/feed/library");
}

// ===== 14. Destination switch mid-session ==============================
// User flips destination from library → channel while on bare root.
{
  const STATE = { redirectHomeToSubs: true, cf_homepage_destination: "library" };
  const { maybeRedirect, calls } = makeMaybeRedirect(STATE);
  maybeRedirect(L("/"));
  STATE.cf_homepage_destination = { type: "channel", handle: "@kurzgesagt" };
  maybeRedirect(L("/"));
  assertEq("14a) first call → library",  calls[0], "/feed/library");
  assertEq("14b) second call → channel", calls[1], "/@kurzgesagt");
}

// ===== 15. Anti-loop: target matches current path -> no redirect =======
{
  const STATE = { redirectHomeToSubs: true, cf_homepage_destination: "library" };
  const { maybeRedirect } = makeMaybeRedirect(STATE);
  // Resolver returns "/feed/library", but loc.pathname IS "/feed/library".
  // Our maybeRedirect short-circuits with the indexOf guard so we don't
  // loop. (Real Chrome would still allow this because _isBareHomepage
  // returns false for non-/ paths — this is a belt-and-suspenders check.)
  assertEq("15) /feed/library + library destination → no redirect",
    maybeRedirect(L("/feed/library")), false);
}

process.stdout.write("\n");
console.log(`HOMEPAGE REDIRECT: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
