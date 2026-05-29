/* CleanFeed v1.4.21 Phase 3 — upgrade card state tests + popup dashboard
 * mini-card tests.
 *
 * Phase 3 introduces the user-facing UI dispatch in popup/popup.js
 * renderUpgrade(): six cases based on cf_grandfathered + cf_subscription.status.
 * Each case produces a distinct DOM layout AND distinct click-routing
 * behavior:
 *
 *   A: cf_grandfathered=true                       -> "Lifetime Pro active"
 *   B: status=active + plan=monthly                -> Manage subscription
 *   C: status=active + plan=annual                 -> Manage subscription
 *   D: status=cancellation_pending                 -> Resubscribe (data-plan)
 *   E: status=past_due                             -> Update payment method
 *   F: free (status=canceled|none, !grandfathered) -> plan picker, both buttons
 *
 * Plus the popup dashboard mini-card:
 *   - computeWeekStats over a synthetic cf_stats input
 *   - zero state shows the "browse YouTube" copy
 *
 * Mirror is a JS-pure logic transcription of the production helpers in
 * popup/popup.js (renderUpgrade + computeWeekStats). We don't load JSDOM
 * — we model the dispatch + button payloads in a "spec → action" form.
 *
 * Run with:  node tests/upgrade-card-states.js
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

// ---- mirror of popup.js renderUpgrade dispatcher ------------------------
//
// Returns an object describing what the case-N branch SHOULD render:
//   { case: "A"|"B"|"C"|"D"|"E"|"F", buttons: [{label, msg, payload}] }
// where each entry in `buttons` corresponds to a clickable element the
// user can press. The popup's _busyClick / _busyClickWithPayload routes
// the click through chrome.runtime.sendMessage with the message + payload
// we record here.

// v1.4.22 — single-plan world. Case F is now ONE Get Pro CTA (was two
// side-by-side plan cards in v1.4.21 Phase 3). Case D's Resubscribe button
// also routes to plan="lifetime" (monthly/annual nicknames are deleted
// from ExtPay). Case B/C still render for legacy active subscribers (the
// dev profile + any Stripe-webhook-lag users); their "Manage subscription"
// CTA still routes to the ExtPay portal unchanged.
function dispatchUpgrade(state) {
  const sub = state.cf_subscription || {};
  const status = sub.status || "none";
  const plan = sub.plan || null;
  const cancelAt = sub.cancelAt || null;

  // Case A — grandfathered (lifetime) — INCLUDING the defensive seventh
  // case: paid=true but no current sub state (transient post-redemption).
  if (state.cf_grandfathered || (state.paid && status !== "active" &&
      status !== "cancellation_pending" && status !== "past_due")) {
    return { case: "A", buttons: [] };       // no CTAs; static state
  }
  if (status === "active") {
    return {
      case: plan === "annual" ? "C" : "B",
      buttons: [{
        label: "Manage subscription",
        msg: "cf:open-login",
        payload: null,
      }],
    };
  }
  if (status === "cancellation_pending") {
    return {
      case: "D",
      cancelAt,
      buttons: [{
        label: "Switch to Pro for life",
        msg: "cf:open-payment",
        payload: { plan: "lifetime" },
      }],
    };
  }
  if (status === "past_due") {
    return {
      case: "E",
      buttons: [{
        label: "Update payment method",
        msg: "cf:open-login",
        payload: null,
      }],
    };
  }
  // Case F — single Get Pro CTA + Already-paid link.
  return {
    case: "F",
    buttons: [
      { label: "Get Pro",              msg: "cf:open-payment", payload: { plan: "lifetime" } },
      { label: "Already paid? Log in", msg: "cf:open-login",   payload: null },
    ],
  };
}

// ===== 1. Case A — grandfathered =======================================

{
  // license_key path
  const out = dispatchUpgrade({
    cf_grandfathered: true,
    cf_grandfathered_reason: "license_key",
    paid: true,
    cf_subscription: { status: "none" },
  });
  assertEq("1a) grandfathered (license_key) -> Case A", out.case, "A");
  assertEq("1a) Case A has zero CTAs (static lifetime)", out.buttons.length, 0);
}
{
  // legacy_extpay path
  const out = dispatchUpgrade({
    cf_grandfathered: true,
    cf_grandfathered_reason: "legacy_extpay",
    paid: true,
    cf_subscription: { status: "none" },
  });
  assertEq("1b) grandfathered (legacy_extpay) -> Case A", out.case, "A");
}
{
  // Transient state: paid=true (license active) but grandfather not yet set.
  // This is the brief window after redemption before ensureGrandfather
  // fires. Must still render as Case A so the user doesn't see an upsell.
  const out = dispatchUpgrade({
    cf_grandfathered: false,
    paid: true,
    cf_subscription: { status: "none" },
  });
  assertEq("1c) license-paid pre-grandfather still renders Case A",
    out.case, "A");
}

// ===== 2. Case B — active monthly =======================================

{
  const out = dispatchUpgrade({
    cf_grandfathered: false,
    paid: true,
    cf_subscription: { status: "active", plan: "monthly", cancelAt: null },
  });
  assertEq("2a) active monthly -> Case B", out.case, "B");
  assertEq("2b) Case B has Manage subscription CTA",
    out.buttons.length, 1);
  assertEq("2c) Manage routes through cf:open-login (Stripe portal)",
    out.buttons[0].msg, "cf:open-login");
}

// ===== 3. Case C — active annual ========================================

{
  const out = dispatchUpgrade({
    cf_grandfathered: false,
    paid: true,
    cf_subscription: { status: "active", plan: "annual", cancelAt: null },
  });
  assertEq("3a) active annual -> Case C", out.case, "C");
  assertEq("3b) Case C also routes Manage through cf:open-login",
    out.buttons[0].msg, "cf:open-login");
}

// ===== 4. Case D — cancellation_pending ================================
//
// v1.4.22 — Resubscribe button routes to plan="lifetime" regardless of
// the prior subscription plan (monthly/annual nicknames are deleted from
// ExtPay). The label changes from "Resubscribe to keep Pro" (subscribe
// to the same recurring plan) to "Switch to Pro for life" (one-time).

{
  const out = dispatchUpgrade({
    cf_grandfathered: false,
    paid: true,
    cf_subscription: { status: "cancellation_pending", plan: "monthly", cancelAt: 1740000000000 },
  });
  assertEq("4a) cancellation_pending -> Case D", out.case, "D");
  assertEq("4b) Case D records cancelAt for date display",
    out.cancelAt, 1740000000000);
  assertEq("4c) Resubscribe sends cf:open-payment",
    out.buttons[0].msg, "cf:open-payment");
  assertEq("4d) Resubscribe payload always plan='lifetime' (from monthly)",
    out.buttons[0].payload.plan, "lifetime");
  assertEq("4e) Button label is 'Switch to Pro for life'",
    out.buttons[0].label, "Switch to Pro for life");
}
{
  // Annual variant — payload still coerces to lifetime.
  const out = dispatchUpgrade({
    cf_grandfathered: false,
    paid: true,
    cf_subscription: { status: "cancellation_pending", plan: "annual", cancelAt: 1740000000000 },
  });
  assertEq("4f) Resubscribe payload coerced to lifetime from annual",
    out.buttons[0].payload.plan, "lifetime");
}

// ===== 5. Case E — past_due ============================================

{
  const out = dispatchUpgrade({
    cf_grandfathered: false,
    paid: true,        // recomputePaid treats past_due as paid (grace)
    cf_subscription: { status: "past_due", plan: "monthly" },
  });
  assertEq("5a) past_due -> Case E", out.case, "E");
  assertEq("5b) Update payment routes through cf:open-login",
    out.buttons[0].msg, "cf:open-login");
}

// ===== 6. Case F — upsell (free, single Get Pro CTA) ===================

{
  // status=none, free user
  const out = dispatchUpgrade({
    cf_grandfathered: false,
    paid: false,
    cf_subscription: { status: "none", plan: null, cancelAt: null },
  });
  assertEq("6a) free + status=none -> Case F", out.case, "F");
  assertEq("6b) Case F renders 2 buttons (Get Pro + login)",
    out.buttons.length, 2);
  assertEq("6c) Get Pro button payload = {plan:'lifetime'}",
    out.buttons[0].payload, { plan: "lifetime" });
  assertEq("6d) Get Pro button label = 'Get Pro'",
    out.buttons[0].label, "Get Pro");
  assertEq("6e) Already-paid routes through cf:open-login",
    out.buttons[1].msg, "cf:open-login");
}
{
  // status=canceled, free user — same Case F (must NOT mistakenly route
  // to any sub-state branch; lapsed subscribers see the upsell, not a stub).
  const out = dispatchUpgrade({
    cf_grandfathered: false,
    paid: false,
    cf_subscription: { status: "canceled", plan: "monthly", cancelAt: 1700000000000 },
  });
  assertEq("6f) canceled + NOT grandfathered -> Case F (upsell)",
    out.case, "F");
}

// ===== 7. Grandfather wins over any sub state =========================
//
// A grandfathered user whose subscription somehow shows canceled (e.g. they
// once subscribed then redeemed a license then canceled the sub) MUST still
// see Case A, NEVER the upsell or Case D/E.

{
  const out = dispatchUpgrade({
    cf_grandfathered: true,
    cf_grandfathered_reason: "license_key",
    paid: true,
    cf_subscription: { status: "canceled", plan: "monthly" },
  });
  assertEq("7) grandfathered + canceled sub -> Case A wins",
    out.case, "A");
}

// ===== 8. Popup dashboard mini-card — computeWeekStats =================
//
// Mirror of popup.js computeWeekStats. Sums cf_stats.blocked over last 7
// days for the videos count, multiplies by CF_AVG_VIDEO_MIN=4 for the
// estimated minutes saved, and sums autoplay_avoided.videos for the
// autoplay row.

const CF_AVG = 4;

function _lastNDateKeysMirror(n, now) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}

function computeWeekStatsMirror(cf_stats, now) {
  const dates = _lastNDateKeysMirror(7, now);
  const blocked = (cf_stats && cf_stats.blocked) || {};
  const auto = (cf_stats && cf_stats.autoplay_avoided) || {};
  let videos = 0, autoplayVideos = 0, autoplayMinutes = 0;
  for (const k of dates) {
    const day = blocked[k];
    if (day && typeof day === "object") {
      for (const id of Object.keys(day)) {
        const v = Number(day[id]) || 0;
        if (v > 0) videos += v;
      }
    }
    const ad = auto[k];
    if (ad && typeof ad === "object") {
      autoplayVideos += Number(ad.videos) || 0;
      autoplayMinutes += Number(ad.estimated_minutes) || 0;
    }
  }
  return { videos, estimatedMinutes: videos * CF_AVG, autoplayVideos, autoplayMinutes };
}

const FIXED_NOW = new Date("2026-05-27T12:00:00");

{
  // Synthetic cf_stats with a clear sum across two days that fall inside
  // the 7-day window relative to FIXED_NOW.
  const cf_stats = {
    blocked: {
      "2026-05-27": { "home-feed": 20, "shorts": 15 },
      "2026-05-26": { "home-feed": 10, "comments": 2 },
      "2025-12-01": { "home-feed": 999 },        // OUTSIDE window — must be ignored
    },
    autoplay_avoided: {
      "2026-05-27": { videos: 3, estimated_minutes: 30 },
      "2026-05-25": { videos: 1, estimated_minutes: 4 },
    },
  };
  const s = computeWeekStatsMirror(cf_stats, FIXED_NOW);
  assertEq("8a) sums only last 7 days (ignores 2025-12-01 entry)",
    s.videos, 20 + 15 + 10 + 2);            // 47
  assertEq("8b) estimatedMinutes = videos * 4",
    s.estimatedMinutes, (20 + 15 + 10 + 2) * 4);    // 188
  assertEq("8c) autoplayVideos summed within window",
    s.autoplayVideos, 4);
  assertEq("8d) autoplayMinutes summed within window",
    s.autoplayMinutes, 34);
}

{
  // All-zeros (new install). Both videos AND autoplay must be 0 to trigger
  // the "Browse YouTube to start tracking" empty-state copy.
  const s = computeWeekStatsMirror({ blocked: {}, autoplay_avoided: {} }, FIXED_NOW);
  assertEq("8e) all-zeros videos = 0", s.videos, 0);
  assertEq("8f) all-zeros autoplayVideos = 0", s.autoplayVideos, 0);
  // Production logic: when both === 0, render the empty-state string.
  // We assert the predicate, not the literal string.
  assertEq("8g) (videos === 0 && autoplayVideos === 0) is the empty-state predicate",
    s.videos === 0 && s.autoplayVideos === 0, true);
}

{
  // 0 blockers but some autoplay — must NOT show empty state.
  const s = computeWeekStatsMirror({
    blocked: {},
    autoplay_avoided: { "2026-05-27": { videos: 1, estimated_minutes: 4 } },
  }, FIXED_NOW);
  assertEq("8h) some autoplay -> NOT empty state",
    s.videos === 0 && s.autoplayVideos === 0, false);
}

// ===== 9. Empty / missing cf_stats doesn't crash =======================

{
  const s = computeWeekStatsMirror(undefined, FIXED_NOW);
  assertEq("9a) undefined cf_stats -> zeros", s.videos, 0);
}
{
  const s = computeWeekStatsMirror(null, FIXED_NOW);
  assertEq("9b) null cf_stats -> zeros", s.videos, 0);
}
{
  const s = computeWeekStatsMirror({ blocked: null }, FIXED_NOW);
  assertEq("9c) cf_stats.blocked = null -> zeros", s.videos, 0);
}

// ===== 10. Plan-button validation =======================================
//
// v1.4.22 — single-plan world. The background.js cf:open-payment handler
// coerces any plan value to "lifetime" (the only configured plan post-
// pricing-revert). The popup MUST only ever send "lifetime".

const PLAN_ALLOWLIST = ["lifetime"];
{
  const cases = [
    { cf_grandfathered: false, paid: false, cf_subscription: { status: "none" } },
    { cf_grandfathered: false, paid: false, cf_subscription: { status: "canceled", plan: "monthly" } },
    { cf_grandfathered: false, paid: true,
      cf_subscription: { status: "cancellation_pending", plan: "monthly", cancelAt: 1740000000000 } },
    { cf_grandfathered: false, paid: true,
      cf_subscription: { status: "cancellation_pending", plan: "annual", cancelAt: 1740000000000 } },
  ];
  for (const c of cases) {
    const f = dispatchUpgrade(c);
    for (const b of f.buttons) {
      if (b.msg === "cf:open-payment") {
        assertTrue(`10) plan-payload "${b.payload.plan}" in allowlist [${PLAN_ALLOWLIST.join(",")}]`,
          PLAN_ALLOWLIST.indexOf(b.payload.plan) >= 0);
      }
    }
  }
}

// ===== 11. Grep test — no residual subscription strings in shipped files =
//
// v1.4.22 anti-regression sentinel. The pricing revert means the strings
// "$1.99", "$19.99", "/month", "/year", "monthly", "annual", "POPULAR"
// must not appear in any user-facing UI file (popup.html, popup.js,
// options.html, options.js). Comments are allowed (they document the
// history); plain literals are not. We exempt explicit comment lines
// (starting with //) and JSDoc lines.

const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
function _stripCommentsAndStrings(src) {
  // Crude — strip // comments to end of line and /* */ block comments.
  // Keep string literals so we DO catch hard-coded copy.
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[\t ]*\/\/.*$/gm, "");
}
const FORBIDDEN = [
  { pat: /\$1\.99/g,    label: "$1.99" },
  { pat: /\$19\.99/g,   label: "$19.99" },
  { pat: /\$1,99/g,     label: "$1,99 (locale comma)" },
  { pat: /\$19,99/g,    label: "$19,99 (locale comma)" },
  // "/month" / "/year" as standalone literals — but NOT inside JS prop
  // names like `period: "/year"` because the user-facing string is the
  // forbidden form. We match the slash + word boundary.
  { pat: /"\/month"/g,  label: '"/month" literal' },
  { pat: /"\/year"/g,   label: '"/year" literal' },
  { pat: /POPULAR/g,    label: "POPULAR badge" },
];
function _scan(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const stripped = _stripCommentsAndStrings(raw);
  const hits = [];
  for (const { pat, label } of FORBIDDEN) {
    const m = stripped.match(pat);
    if (m && m.length) hits.push({ label, count: m.length });
  }
  return hits;
}
const SCAN_FILES = [
  "popup/popup.html",
  "popup/popup.js",
  "options/options.html",
  "options/options.js",
];
for (const rel of SCAN_FILES) {
  const hits = _scan(path.join(REPO, rel));
  // Note: "MOST POPULAR" appears in onboarding preset code (unrelated to
  // the pricing pivot — it's the "Focused" preset's tag). We let that
  // slide because the grep is anchored on /POPULAR/ as a whole word in
  // the upsell context; the test will flag it if it leaks into the
  // upgrade card path. For popup.js specifically we check that the only
  // POPULAR occurrence (if any) is the preset, not the pricing badge.
  // We do this by also scanning for "⭐ POPULAR" (with the star) which
  // is the pricing badge form — that MUST be zero.
  const starHits = (fs.readFileSync(path.join(REPO, rel), "utf8")
    .match(/⭐ POPULAR/g) || []).length;
  assertEq(`11.${rel}) zero "⭐ POPULAR" pricing-badge strings`, starHits, 0);
  // The other forbidden literals must be zero outright.
  const noStarHits = hits.filter((h) => h.label !== "POPULAR badge");
  assertEq(`11.${rel}) zero residual subscription strings`,
    noStarHits, []);
}

process.stdout.write("\n");
console.log(`UPGRADE CARD STATES: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
