/* CleanFeed — background.js (Manifest V3 service worker)
 *
 * Responsibilities:
 *   • Initialise ExtensionPay with our extension id ("cleanfeed2342")
 *   • Open the onboarding tab on first install
 *   • Maintain an action-badge that shows the count of active blockers
 *   • Cache the paid flag in chrome.storage.local so popup/content can
 *     read it synchronously (no network round-trip on every popup open)
 *   • Route messages from popup -> active YT tab so live toggling works
 *
 * Service workers are short-lived: any state must come from chrome.storage.
 */
importScripts("lib/extpay.js");

const EXTPAY_ID = "cleanfeed2342";
const extpay = ExtPay(EXTPAY_ID);
extpay.startBackground();

// ----- ExtPay api_key helpers (hoisted to module scope in v1.4.2 so
// that chrome.runtime.onInstalled and chrome.runtime.onStartup can call
// them before any popup ever opens). The implementations mirror the
// SDK's own create_key/get_key (lib/extpay.js:1307-1349) — sync first,
// fall back to local. Earlier these lived inside the onMessage closure;
// the inline message handlers still reference them by the same names. -----
async function _writeExtpayApiKey(apiKey) {
  try {
    await chrome.storage.sync.set({ extensionpay_api_key: apiKey });
  } catch (_) {
    try { await chrome.storage.local.set({ extensionpay_api_key: apiKey }); } catch (_) {}
  }
}
async function _readExtpayApiKey() {
  try {
    const s = await chrome.storage.sync.get(["extensionpay_api_key"]);
    if (s && s.extensionpay_api_key) return String(s.extensionpay_api_key);
  } catch (_) {}
  try {
    const l = await chrome.storage.local.get(["extensionpay_api_key"]);
    if (l && l.extensionpay_api_key) return String(l.extensionpay_api_key);
  } catch (_) {}
  return "";
}
async function _createExtpayApiKey() {
  try {
    const isDev = !(("update_url") in (chrome.runtime.getManifest() || {}));
    const body = isDev ? { development: true } : {};
    const resp = await fetch(
      "https://extensionpay.com/extension/" + encodeURIComponent(EXTPAY_ID) + "/api/new-key",
      {
        method: "POST",
        headers: { "Accept": "application/json", "Content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
      }
    );
    if (!resp.ok) { console.warn("[CleanFeed] /api/new-key HTTP " + resp.status); return ""; }
    const apiKey = await resp.json();
    const key = typeof apiKey === "string" ? apiKey : String(apiKey || "");
    if (key) await _writeExtpayApiKey(key);
    return key;
  } catch (e) {
    console.warn("[CleanFeed] /api/new-key failed:", e);
    return "";
  }
}
async function _ensureExtpayApiKey() {
  let key = await _readExtpayApiKey();
  if (key) return key;
  try { await extpay.getUser(); } catch (_) {}
  key = await _readExtpayApiKey();
  if (key) return key;
  return await _createExtpayApiKey();
}

// v1.4.2 — eagerly mint the ExtPay api_key the moment the extension
// is installed or Chrome starts up, so the first time the user clicks
// "Upgrade — $4.99" the URL already has ?api_key=… in it. Silent on
// failure; the popup's on-demand prefetch + on-click _ensureExtpayApiKey
// still cover any case where this didn't get a chance to run.
async function _eagerlyMintApiKey(reason) {
  try {
    const existing = await _readExtpayApiKey();
    if (existing) {
      console.log("[CleanFeed] api_key already present at " + reason + " — no fetch needed");
      return;
    }
    console.log("[CleanFeed] minting api_key at " + reason);
    const fresh = await _createExtpayApiKey();
    if (fresh) console.log("[CleanFeed] api_key minted at " + reason);
  } catch (e) {
    console.warn("[CleanFeed] eager api_key mint failed:", e);
  }
}
// -------- v1.4.17 — license-key support ---------------------------------
//
// Pro state has TWO sources from v1.4.17 onward:
//   1. ExtPay subscription (existing path) — raw flag stored as `extpayPaid`.
//   2. Single-use lifetime license key redeemed via the Cloudflare Worker
//      at LICENSE_SERVER — stored as `cleanfeed_license = { active, key,
//      key_partial, redeemed_at }`.
//
// The user-visible "is Pro?" check still reads ONE storage key — `paid` —
// which is now a DERIVED value = extpayPaid || cleanfeed_license.active.
// All reader sites (popup.js, content/content.js, options/options.js)
// continue to read `paid` unchanged. recomputePaid() is the single writer.
//
// Migration: v1.4.16 users have `paid` (= ExtPay) but no `extpayPaid`.
// On first call recomputePaid copies `paid` → `extpayPaid` so the
// historical ExtPay state is preserved across the upgrade.
const LICENSE_SERVER = "https://cleanfeed-license.cleanfeed.workers.dev";

// v1.4.21-phase1 — grandfather lock-in. Anyone who EVER held license-key Pro
// or legacy ExtPay one-time-paid status gets cf_grandfathered=true permanently
// the first time we observe them in that state. Once true, never overwritten.
// Subscription users do NOT get grandfathered — when their sub lapses they
// drop to free. Idempotent + race-safe via the same double-read pattern as
// ensureInstallId / ensureCfStats.
async function ensureGrandfather() {
  const d1 = await chrome.storage.local.get(
    ["cf_grandfathered", "extpayPaid", "cleanfeed_license"]
  );
  if (d1.cf_grandfathered === true) return;     // already locked in
  const hasLicense = !!(d1.cleanfeed_license && d1.cleanfeed_license.active);
  const hasLegacyExtpay = d1.extpayPaid === true;
  if (!hasLicense && !hasLegacyExtpay) return;  // not Pro right now
  // Re-check before write under "writer wins" semantics — if another caller
  // (e.g. a parallel storage.onChanged dispatch) wrote between reads, prefer
  // theirs so cf_grandfathered_at doesn't churn.
  const d2 = await chrome.storage.local.get(["cf_grandfathered"]);
  if (d2.cf_grandfathered === true) return;
  // legacy_extpay wins precedence when both signals are present — those
  // users predate the license-key path entirely, so the more specific
  // historical reason is the right one to record.
  const reason = hasLegacyExtpay ? "legacy_extpay" : "license_key";
  await chrome.storage.local.set({
    cf_grandfathered: true,
    cf_grandfathered_at: new Date().toISOString(),
    cf_grandfathered_reason: reason,
  });
}

// v1.4.21-phase2 — unified ExtPay subscription sync. Single entry point
// for every place that needs to translate the raw ExtPay user payload into
// cf_subscription. Replaces the v1.4.17 extpay.onPaid handler that only
// knew about the boolean `paid` flag. Pulls from extpay.getUser() and
// derives the 5-state cf_subscription.status field per the documented
// machine:
//
//   user.paid && !user.subscriptionCancelAt          -> "active"
//   user.paid && user.subscriptionCancelAt           -> "cancellation_pending"
//   user.subscriptionStatus === "past_due"           -> "past_due"
//   user.subscriptionStatus === "canceled"           -> "canceled"
//   else                                             -> "none"
//
// Two defensive behaviors:
//   1. Legacy one-time-paid detection: `paid===true` with NO
//      subscriptionStatus AND NO subscriptionCancelAt means this is a
//      legacy ExtPay buyer (none expected at launch but defensive).
//      Set extpayPaid=true and lock in grandfather. Never auto-grant
//      grandfather for monthly/annual subscribers.
//   2. Network errors NEVER strip Pro. If extpay.getUser() throws, the
//      function exits without touching cf_subscription; last-known state
//      stays put. A paid user must not lose Pro because of a wifi blip.
//
// Test-mode escape hatch: if chrome.storage.local has the key
// `cf_devmode_force_sub_status` (string), it OVERRIDES the derived status
// AFTER the real sync. Production code never writes this key. Documented
// in README under Testing.
async function syncSubscriptionFromExtPay(prefetchedUser) {
  let user = prefetchedUser;
  if (!user) {
    try {
      user = await extpay.getUser();
    } catch (err) {
      console.warn("[CleanFeed] syncSubscriptionFromExtPay failed:", err);
      return;     // last-known cf_subscription preserved as-is
    }
  }
  const next = {
    lastSyncAt: Date.now(),
    plan: user.planNickname || user.plan || null,
    cancelAt: user.subscriptionCancelAt || null,
    status: "none",
  };
  if (user.paid && !user.subscriptionCancelAt) {
    next.status = "active";
  } else if (user.paid && user.subscriptionCancelAt) {
    next.status = "cancellation_pending";
  } else if (user.subscriptionStatus === "past_due") {
    next.status = "past_due";
  } else if (user.subscriptionStatus === "canceled") {
    next.status = "canceled";
  } else {
    next.status = "none";
  }
  // Legacy one-time-paid detection. Defensive: zero legacy buyers expected
  // at v1.4.21 launch (the extension was always subscription-only here)
  // but if any exist we treat them identically to license-key redeemers.
  if (user.paid && !user.subscriptionStatus && !user.subscriptionCancelAt) {
    await chrome.storage.local.set({ extpayPaid: true });
    await ensureGrandfather();
  }
  await chrome.storage.local.set({ cf_subscription: next });
  // Dev-mode override applied AFTER the real sync so production logic
  // always runs first and stale overrides don't silently mask real state.
  const ov = await chrome.storage.local.get(["cf_devmode_force_sub_status"]);
  if (ov.cf_devmode_force_sub_status && typeof ov.cf_devmode_force_sub_status === "string") {
    const forced = Object.assign({}, next, { status: ov.cf_devmode_force_sub_status });
    await chrome.storage.local.set({ cf_subscription: forced });
  }
  await recomputePaid();
}

async function recomputePaid() {
  const data = await chrome.storage.local.get(
    ["paid", "extpayPaid", "cleanfeed_license", "cf_grandfathered", "cf_subscription"]
  );
  // v1.4.21-phase1 — grandfather is the new permanent layer.
  const gf = data.cf_grandfathered === true;
  // v1.4.21-phase1 — subscription is the new revenue layer. past_due is
  // intentionally treated as paid (ExtPay's automatic-retry grace window).
  const sub = data.cf_subscription && data.cf_subscription.status;
  const subActive = (sub === "active" || sub === "cancellation_pending" || sub === "past_due");
  let ext = data.extpayPaid;
  const needMigration = (typeof ext !== "boolean");
  if (needMigration) ext = !!data.paid;        // v1.4.16 → v1.4.17 migration
  const lic = !!(data.cleanfeed_license && data.cleanfeed_license.active);
  const next = gf || subActive || ext || lic;
  const patch = {};
  if (needMigration) patch.extpayPaid = ext;
  if (data.paid !== next) patch.paid = next;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  // Best-effort popup notification — sendMessage with no listeners throws.
  chrome.runtime.sendMessage({ type: "cf:paid-changed", paid: next }).catch(() => {});
  return next;
}

// v1.4.20-beta — idempotent cf_stats seeder. Mirrors ensureInstallId's
// shape (re-check between get and set so concurrent callers don't clobber).
// Called from BOTH onInstalled AND onStartup so the Phase 1 analytics
// instrumentation works even when onInstalled doesn't fire with reason
// === "update" — including the common dev-mode reload-from-unpacked path
// that prompted the v1.4.20-alpha → v1.4.20-beta hotfix.
//
// _migrateForV140 also has a (now-redundant) cf_stats seed; left in place
// as defense in depth for the production "onInstalled.update" path.
async function ensureCfStats() {
  const d = await chrome.storage.local.get(["cf_stats"]);
  if (d.cf_stats && typeof d.cf_stats === "object") return d.cf_stats;
  const seed = { blocked: {}, autoplay_avoided: {}, session_started: Date.now() };
  // Re-check under "writer wins" semantics — if another caller (or the
  // _migrateForV140 path) wrote between our two reads, prefer theirs.
  const d2 = await chrome.storage.local.get(["cf_stats"]);
  if (d2.cf_stats && typeof d2.cf_stats === "object") return d2.cf_stats;
  await chrome.storage.local.set({ cf_stats: seed });
  return seed;
}

// First-run UUID. Idempotent — never overwrites. Race-tolerant via a
// re-check between get and set so two callers (e.g. background + options
// page) can both invoke it without clobbering each other.
async function ensureInstallId() {
  const d = await chrome.storage.local.get(["installId"]);
  if (typeof d.installId === "string" && d.installId.length >= 8) return d.installId;
  let id;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    id = crypto.randomUUID();
  } else {
    const a = new Uint8Array(16); crypto.getRandomValues(a);
    id = Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Re-check under "writer wins" semantics — if another caller wrote
  // between our two reads, prefer theirs.
  const d2 = await chrome.storage.local.get(["installId"]);
  if (typeof d2.installId === "string" && d2.installId.length >= 8) return d2.installId;
  await chrome.storage.local.set({ installId: id });
  return id;
}

// Periodic /verify. Only POSTs when the user actually has an active
// license. NEVER fail-closed on network errors — a paid user must not
// lose Pro because their wifi blipped. The only state transitions that
// flip license.active to false are explicit ok:false responses with a
// concrete reason (revoked / wrong_install / not_found).
async function verifyLicenseIfPresent() {
  const d = await chrome.storage.local.get(["cleanfeed_license", "installId"]);
  const lic = d.cleanfeed_license;
  if (!lic || !lic.active || !lic.key) return;
  if (!d.installId) return;
  try {
    const resp = await fetch(LICENSE_SERVER + "/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: lic.key, install_id: d.installId }),
    });
    if (!resp.ok) return;
    const body = await resp.json();
    if (body && body.ok === true) return;
    if (body && body.ok === false && body.reason) {
      console.warn("[CleanFeed] license invalidated by /verify:", body.reason);
      await chrome.storage.local.set({
        cleanfeed_license: Object.assign({}, lic, {
          active: false,
          deactivated_reason: body.reason,
          deactivated_at: Date.now(),
        }),
      });
      // recomputePaid runs via the storage.onChanged listener below; we
      // also call it directly so popup/badge updates don't wait on it.
      await recomputePaid();
    }
  } catch (_) {
    // network error — silently retry next cycle
  }
}

// v1.4.21-phase2 — 6-hourly periodic sync of cf_subscription so state
// doesn't drift if the user keeps Chrome open for days without a restart
// triggering onStartup. periodInMinutes:360 = 6h. Idempotent — calling
// chrome.alarms.create with the same name replaces the existing alarm.
function _ensureExtpaySyncAlarm() {
  try {
    chrome.alarms.create("cf-extpay-sync", { periodInMinutes: 360 });
  } catch (_) { /* alarms permission denied — silently no-op */ }
}

chrome.runtime.onInstalled.addListener((details) => {
  _eagerlyMintApiKey("install/update (" + details.reason + ")");
  // v1.4.17 — seed install id + reconcile paid + re-verify license.
  ensureInstallId().catch(() => {});
  // v1.4.20-beta — seed cf_stats here, OUTSIDE the reason==="update" gate
  // of the second onInstalled listener. Real-Chrome bug: that gate misses
  // dev-mode reloads + any onInstalled.reason !== "install"/"update", so
  // v1.4.19→v1.4.20-alpha upgraders saw cf_stats never seeded.
  ensureCfStats().catch(() => {});
  // v1.4.21-phase1 — lock in grandfather status BEFORE recomputePaid so
  // legacy license/extpay holders carry forward as lifetime Pro.
  ensureGrandfather().then(() => recomputePaid()).catch(() => {});
  // v1.4.21-phase2 — pull fresh subscription state on every install /
  // update. Network errors here are silent (sync function handles them).
  syncSubscriptionFromExtPay().catch(() => {});
  _ensureExtpaySyncAlarm();
  verifyLicenseIfPresent().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  _eagerlyMintApiKey("startup");
  // v1.4.17 — same bookkeeping at every browser launch.
  ensureInstallId().catch(() => {});
  // v1.4.20-beta — second-chance cf_stats seed on every browser launch
  // so users whose onInstalled never fired still get the key on next
  // Chrome restart. Idempotent.
  ensureCfStats().catch(() => {});
  // v1.4.21-phase1 — second-chance grandfather lock-in on every browser
  // launch; idempotent no-op once cf_grandfathered=true.
  ensureGrandfather().then(() => recomputePaid()).catch(() => {});
  // v1.4.21-phase2 — pull fresh subscription state on every browser launch.
  syncSubscriptionFromExtPay().catch(() => {});
  _ensureExtpaySyncAlarm();
  verifyLicenseIfPresent().catch(() => {});
});

// v1.4.21-phase2 — unified ExtPay flow. The onPaid listener fires when
// the user returns from a successful Stripe checkout; we route through
// syncSubscriptionFromExtPay so cf_subscription is populated from the
// same code path as periodic + startup syncs. The listener still writes
// paidAt directly (legacy field used by popup's "paid since" copy) — the
// sync function alone wouldn't, since it focuses on cf_subscription.
extpay.onPaid.addListener(async (user) => {
  try {
    await chrome.storage.local.set({
      paidAt: user.paidAt ? user.paidAt.toISOString() : null,
    });
  } catch (_) {}
  // Pass the pre-fetched user so sync doesn't double-fetch over the network.
  await syncSubscriptionFromExtPay(user);
});

// -------- onboarding ----------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    // v1.4.6 — SEED STORAGE FIRST, then set a readiness flag, THEN open
    // the onboarding tab and do any network work. Earlier versions called
    // chrome.tabs.create BEFORE awaiting the defaults write, leaving a
    // window where the popup (if opened immediately) read empty storage,
    // rendered the onboarding view, and the user's preset-pick was then
    // overwritten by this listener's later full-defaults write — forcing
    // the user to close and reopen the popup several times.
    const defaults = {
      settings: {
        "home-feed": true,
        "shorts": true,
        "watch-sidebar": false,
        "end-screen": false,
        "comments": false,
        "explore": false,
        "live-chat": false,
        "autoplay": false,
        "thumbnails": false,
        "subs-algo": false,
        // v1.4.0 — four new blockers, all default OFF
        "playables": false,
        "merch-shelf": false,
        "breaking-news": false,
        "mixes-playlists": false,
        // v1.4.19 — three new Pro blockers for the Subscriptions feed
        "subs-most-relevant": false,
        "subs-members-only": false,
        "subs-watched": false,
      },
      paid: false,
      whitelistedChannels: [],
      customCSS: "",
      sessionStats: { total: 0, perBlocker: {} },
      pausedUntil: 0,
      blockedChannels: [],
      focusLock: {
        pinSet: false, activeUntil: 0, pinHash: "", pinSalt: "",
        mode: "standard",           // "standard" | "pomodoro"
        pomodoro: { focusMin: 25, breakMin: 5, cycles: 4 },
        pomodoroState: null,        // {phase:"focus"|"break", cycle:N, until:ts, total:N}
      },
      timeTracking: {},
      // v1.4.0
      hiddenKeywords: [],           // F1 — Pro keyword blocklist
      onboardingComplete: false,    // F2 — first-install presets
      onboardingChoice: null,
      usageCount: 0,                // F3 — popup-open counter
      reviewPromptShown: false,     // F3 — one-time review banner gate
      perPageEnabled: false,        // F6 — opt-in per-page rules
      perPageSettings: { homepage: {}, watch: {}, subscriptions: {} },
      // v1.4.17 — license-key support. extpayPaid mirrors the ExtPay
      // signal explicitly so the derived `paid` flag has an unambiguous
      // input even if the license storage entry is null/absent.
      extpayPaid: false,
      cleanfeed_license: null,
      // v1.4.19 — Homepage→Subs redirect (F2) + per-blocker render modes (F3).
      redirectHomeToSubs: false,
      blockerModes: {},
      // v1.4.20-alpha — analytics dashboard Phase 1 instrumentation.
      // Schema (also documented in content/content.js _flushStats):
      //   blocked: { "YYYY-MM-DD": { <blocker-id>: <count> } }
      //   autoplay_avoided: { "YYYY-MM-DD": { videos: N, estimated_minutes: M } }
      //   session_started: <ms-epoch>   // first-init timestamp
      // No UI consumes this yet; Phase 2 will read + render.
      cf_stats: { blocked: {}, autoplay_avoided: {}, session_started: Date.now() },
      // v1.4.21-phase1 — subscription model + grandfather. Brand-new
      // installs are NOT grandfathered (they never held legacy paid
      // status). cf_subscription tracks ExtPay subscription state once
      // Phase 2's sync wiring lands. lastSyncAt=0 marks "never synced".
      cf_grandfathered: false,
      cf_grandfathered_at: null,
      cf_grandfathered_reason: null,
      cf_subscription: { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 },
    };
    await chrome.storage.local.set(defaults);
    // Set the readiness flag in a SEPARATE write so popup/content can
    // observe a single, unambiguous "storage is seeded" transition via
    // chrome.storage.onChanged. The popup waits on this flag instead of
    // racing the seed write.
    await chrome.storage.local.set({ cf_initialized: true });
    // mirror a copy to chrome.storage.sync for backup/migration
    chrome.storage.sync.set({
      settings: defaults.settings,
      whitelistedChannels: [],
    }).catch(() => {});
    // Now safe to open the onboarding tab — even if the user clicks the
    // toolbar icon at the same instant, the popup will see cf_initialized.
    chrome.tabs.create({
      url: chrome.runtime.getURL("onboarding/welcome.html"),
    });
  } else if (details.reason === "update") {
    // v1.4.0 migration. Existing users keep their settings; we only
    // ADD the new keys with safe defaults. Onboarding is auto-marked
    // complete for anyone who already has settings (per spec).
    await _migrateForV140();
    // v1.4.6 — mark existing-user storage as initialized too so the
    // popup's readiness check passes without waiting.
    await chrome.storage.local.set({ cf_initialized: true });
  }
  // v1.4.21-phase2 — route through the unified sync. Pre-v1.4.21 this
  // block blanket-set extpayPaid=!!user.paid for every paid user, which
  // permanently sticky'd subscribers into Pro via the `ext` clause in
  // recomputePaid (a canceled subscriber would have stayed paid forever).
  // syncSubscriptionFromExtPay only sets extpayPaid=true in the legacy
  // one-time-buyer branch, and otherwise routes everything through
  // cf_subscription.status — preserving the "lapsed subscriber drops to
  // free" invariant. Network errors are silent inside the sync function.
  await syncSubscriptionFromExtPay();
  updateBadge();
});

// -------- v1.4.0 migration ----------------------------------------------
//
// Add new storage keys with safe defaults if missing. Never overwrite
// existing user values. Onboarding is marked complete for anyone whose
// settings object already has at least one truthy blocker.
async function _migrateForV140() {
  const NEW_BLOCKER_DEFAULTS = {
    "playables": false,
    "merch-shelf": false,
    "breaking-news": false,
    "mixes-playlists": false,
    // v1.4.19 — three new Pro blockers seeded OFF for existing users so
    // the upgrade is invisible. The popup BLOCKERS array exposes them.
    "subs-most-relevant": false,
    "subs-members-only": false,
    "subs-watched": false,
  };
  const data = await chrome.storage.local.get(null);
  const patch = {};
  // settings: merge new blocker keys without clobbering existing values
  const s = Object.assign({}, NEW_BLOCKER_DEFAULTS, data.settings || {});
  patch.settings = s;
  // onboarding — auto-complete for upgraded existing users
  if (typeof data.onboardingComplete === "undefined") {
    const hasUserSettings = data.settings &&
      Object.values(data.settings).some((v) => v === true);
    patch.onboardingComplete = !!hasUserSettings;
  }
  if (typeof data.hiddenKeywords === "undefined") patch.hiddenKeywords = [];
  if (typeof data.usageCount === "undefined") patch.usageCount = 0;
  if (typeof data.reviewPromptShown === "undefined") patch.reviewPromptShown = false;
  if (typeof data.perPageEnabled === "undefined") patch.perPageEnabled = false;
  if (typeof data.perPageSettings === "undefined") {
    patch.perPageSettings = { homepage: {}, watch: {}, subscriptions: {} };
  }
  // v1.4.19 — homepage→subs redirect + per-blocker render modes.
  if (typeof data.redirectHomeToSubs === "undefined") patch.redirectHomeToSubs = false;
  if (typeof data.blockerModes === "undefined" || data.blockerModes === null ||
      typeof data.blockerModes !== "object") {
    patch.blockerModes = {};
  }
  // v1.4.20-alpha — analytics dashboard Phase 1 instrumentation.
  // IDEMPOTENT seed: only write cf_stats if no key exists on this profile.
  // If the user has any prior cf_stats (even a partial one from a previous
  // v1.4.20-alpha install), we do NOT overwrite — Phase 2's reader needs
  // to trust that the daily counters keep accumulating across upgrades.
  if (typeof data.cf_stats === "undefined" || data.cf_stats === null ||
      typeof data.cf_stats !== "object") {
    patch.cf_stats = { blocked: {}, autoplay_avoided: {}, session_started: Date.now() };
  }
  // v1.4.21-phase1 — seed subscription + grandfather defaults for upgrading
  // users. cf_grandfathered stays FALSE here; the actual lock-in to TRUE for
  // qualifying users (active license OR legacy extpayPaid) happens in
  // ensureGrandfather(), called from the lifecycle listeners after migration.
  if (typeof data.cf_grandfathered === "undefined") patch.cf_grandfathered = false;
  if (typeof data.cf_grandfathered_at === "undefined") patch.cf_grandfathered_at = null;
  if (typeof data.cf_grandfathered_reason === "undefined") patch.cf_grandfathered_reason = null;
  if (typeof data.cf_subscription === "undefined" || data.cf_subscription === null ||
      typeof data.cf_subscription !== "object") {
    patch.cf_subscription = { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 };
  }
  // focusLock — preserve existing object, just ensure mode/pomodoro fields exist
  const fl = data.focusLock || {};
  if (typeof fl.mode === "undefined") fl.mode = "standard";
  if (typeof fl.pomodoro === "undefined") fl.pomodoro = { focusMin: 25, breakMin: 5, cycles: 4 };
  if (typeof fl.pomodoroState === "undefined") fl.pomodoroState = null;
  patch.focusLock = fl;
  await chrome.storage.local.set(patch);
}

// -------- Pomodoro alarm handler (F4) -----------------------------------
//
// Phase 1: focus — blockers force-on (handled by content.js via focusLock
//   activeUntil & mode === "pomodoro"). At alarm fire, switch to break.
// Phase 2: break — blockers off; user browses freely. At alarm fire,
//   if cycles remain → next focus; else clear state, fire completion.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // v1.4.21-phase2 — 6-hourly subscription sync so cf_subscription doesn't
  // drift if the user keeps Chrome open for days without a restart. Network
  // errors here are silent (handled inside syncSubscriptionFromExtPay).
  if (alarm.name === "cf-extpay-sync") {
    syncSubscriptionFromExtPay().catch(() => {});
    return;
  }
  if (alarm.name !== "cf-pomodoro") return;
  const data = await chrome.storage.local.get(["focusLock"]);
  const fl = data.focusLock || {};
  const state = fl.pomodoroState;
  if (!state) return;
  const cfg = fl.pomodoro || { focusMin: 25, breakMin: 5, cycles: 4 };

  if (state.phase === "focus") {
    // -> break
    const breakUntil = Date.now() + Math.max(1, cfg.breakMin) * 60 * 1000;
    fl.pomodoroState = { phase: "break", cycle: state.cycle, total: state.total, until: breakUntil };
    fl.activeUntil = 0;     // unlock blockers during break
    await chrome.storage.local.set({ focusLock: fl });
    chrome.alarms.create("cf-pomodoro", { when: breakUntil });
    try {
      chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
        title: "Focus complete — break time",
        message: `Cycle ${state.cycle} of ${state.total} done. ${cfg.breakMin} min break.`,
      });
    } catch (_) {}
  } else if (state.phase === "break") {
    if (state.cycle >= state.total) {
      // Final cycle done — clear everything
      fl.pomodoroState = null;
      fl.activeUntil = 0;
      await chrome.storage.local.set({
        focusLock: fl,
        lastPomodoroComplete: Date.now(),
      });
      try { chrome.alarms.clear("cf-pomodoro"); } catch (_) {}
      try {
        chrome.notifications.create({
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
          title: "Pomodoro complete",
          message: `${state.total} cycles done. Nice work.`,
        });
      } catch (_) {}
    } else {
      // next focus
      const focusMs = Math.max(1, cfg.focusMin) * 60 * 1000;
      const until = Date.now() + focusMs;
      fl.pomodoroState = { phase: "focus", cycle: state.cycle + 1, total: state.total, until };
      fl.activeUntil = until;
      await chrome.storage.local.set({ focusLock: fl });
      chrome.alarms.create("cf-pomodoro", { when: until });
      try {
        chrome.notifications.create({
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
          title: "Break over — back to focus",
          message: `Cycle ${state.cycle + 1} of ${state.total}. ${cfg.focusMin} min focus.`,
        });
      } catch (_) {}
    }
  }
  updateBadge();
});

// -------- badge counter -------------------------------------------------

async function updateBadge() {
  const data = await chrome.storage.local.get(["settings", "paid", "pausedUntil", "focusLock"]);
  const settings = data.settings || {};
  const paid = !!data.paid;
  // v1.4.9 — clamp pausedUntil to (now + 1hr + 5min slack). A corrupted
  // far-future timestamp must not pin the badge into the paused glyph.
  let pausedUntil = Number(data.pausedUntil) || 0;
  if (pausedUntil > Date.now() + 60 * 60 * 1000 + 5 * 60 * 1000) pausedUntil = 0;
  const focusLock = data.focusLock || {};
  const focusActive = Number(focusLock.activeUntil || 0) > Date.now();

  // Focus Lock wins over everything visually.
  if (focusActive && paid) {
    try {
      await chrome.action.setBadgeText({ text: "🔒" });
      await chrome.action.setBadgeBackgroundColor({ color: "#C64A5B" });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
      }
    } catch (_) {}
    const ms = Math.max(1000, Number(focusLock.activeUntil) - Date.now() + 50);
    if (ms < 365 * 24 * 60 * 60 * 1000) setTimeout(updateBadge, ms);
    return;
  }

  // While paused, the badge shows a pause glyph and goes dim.
  if (pausedUntil > Date.now()) {
    try {
      await chrome.action.setBadgeText({ text: "⏸" });
      await chrome.action.setBadgeBackgroundColor({ color: "#5E6C7E" });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
      }
    } catch (_) {}
    // Schedule another update when the pause expires so the badge resets.
    const ms = Math.max(1000, pausedUntil - Date.now() + 50);
    setTimeout(updateBadge, ms);
    return;
  }

  // count active blockers, respecting free-tier limits
  const ids = Object.keys(settings).filter((id) => settings[id]);
  let count = ids.length;
  if (!paid) {
    // v1.4.11 — canonical free-tier ids. Must stay in sync with
    // content/blockers.js (tier: "free"). Pre-v1.4.11 this list held only
    // the two original v1.0 free blockers; the v1.4.0 additions (merch-shelf,
    // breaking-news) were silently excluded so a free user enabling them
    // saw badge count 0 instead of 2.
    const FREE_IDS = ["home-feed", "shorts", "merch-shelf", "breaking-news"];
    count = ids.filter((id) => FREE_IDS.includes(id)).length;
    count = Math.min(count, 2);
  }
  const text = count > 0 ? String(count) : "";
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: "#3CC8C8" });
    if (chrome.action.setBadgeTextColor) {
      // available in newer Chrome
      await chrome.action.setBadgeTextColor({ color: "#0B1828" });
    }
  } catch (_) { /* ignore */ }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings || changes.paid || changes.pausedUntil || changes.focusLock) updateBadge();
  // v1.4.17 — license redemption (or revocation) flips an input to
  // recomputePaid(). The listener only fires on cleanfeed_license /
  // extpayPaid changes (NOT on the resulting `paid` change) so we don't
  // recurse — recomputePaid writes `paid` and may write `extpayPaid`
  // exactly once for migration; the migration write is idempotent.
  if (changes.cleanfeed_license || changes.extpayPaid) {
    // v1.4.21-phase1 — newly-redeemed license keys (via options.js) and
    // legacy extpayPaid flips both feed grandfather lock-in. ensureGrandfather
    // is idempotent, so re-firing on every storage event is safe; it only
    // writes the first time qualifying state appears. Order: grandfather
    // first, then recompute so the derived `paid` flag observes it.
    ensureGrandfather().then(() => recomputePaid()).catch(() => {});
  }
});

// -------- message routing -----------------------------------------------

// -------- time tracker aggregator ---------------------------------------
//
// Keep an in-memory accumulator and flush to storage every ~5s. We cap the
// stored object to the last 30 days to keep storage small.
const _ttAccum = { date: "", ms: 0, flushHandle: 0 };

function _todayLocalDateKey() {
  const d = new Date();
  // YYYY-MM-DD in the user's local timezone
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function _flushTimeTracker() {
  if (_ttAccum.ms <= 0 || !_ttAccum.date) return;
  const seconds = Math.floor(_ttAccum.ms / 1000);
  if (seconds <= 0) return;
  _ttAccum.ms -= seconds * 1000;
  const data = await chrome.storage.local.get(["timeTracking"]);
  const tt = data.timeTracking || {};
  tt[_ttAccum.date] = (tt[_ttAccum.date] || 0) + seconds;
  // prune to last 30 days
  const keep = new Set();
  const now = new Date();
  for (let i = 0; i < 30; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    keep.add(`${y}-${m}-${day}`);
  }
  for (const k of Object.keys(tt)) {
    if (!keep.has(k)) delete tt[k];
  }
  await chrome.storage.local.set({ timeTracking: tt });
}

function _recordTime(ms) {
  const date = _todayLocalDateKey();
  if (_ttAccum.date && _ttAccum.date !== date) {
    // day rolled over — flush old day first
    _flushTimeTracker();
  }
  _ttAccum.date = date;
  _ttAccum.ms += Math.max(0, Math.min(ms, 15000));
  if (!_ttAccum.flushHandle) {
    _ttAccum.flushHandle = setTimeout(() => {
      _ttAccum.flushHandle = 0;
      _flushTimeTracker();
    }, 5000);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  // v1.4.3 — popup pings this synchronously the moment it opens to keep the
  // MV3 service worker awake during render. Just acknowledge — no side effects.
  if (msg.type === "cf:wake") {
    sendResponse({ ok: true });
    return true;
  }

  // Time tracker tick from content.js
  if (msg.type === "cf:track-time") {
    _recordTime(Number(msg.ms) || 0);
    sendResponse({ ok: true });
    return true;
  }

  // F4 — start a Pomodoro session. Requires Pro + a valid PIN already
  // set; we trust the caller (options page) to have checked both.
  if (msg.type === "cf:pomodoro-start") {
    (async () => {
      const data = await chrome.storage.local.get(["focusLock"]);
      const fl = data.focusLock || {};
      const cfg = Object.assign(
        { focusMin: 25, breakMin: 5, cycles: 4 },
        fl.pomodoro || {},
        msg.config || {}
      );
      cfg.focusMin = Math.max(15, Math.min(60, Math.round(cfg.focusMin)));
      cfg.breakMin = Math.max(3,  Math.min(15, Math.round(cfg.breakMin)));
      cfg.cycles   = Math.max(1,  Math.min(8,  Math.round(cfg.cycles)));
      const focusMs = cfg.focusMin * 60 * 1000;
      const until = Date.now() + focusMs;
      fl.mode = "pomodoro";
      fl.pomodoro = cfg;
      fl.pomodoroState = { phase: "focus", cycle: 1, total: cfg.cycles, until };
      fl.activeUntil = until;
      await chrome.storage.local.set({ focusLock: fl });
      try { chrome.alarms.clear("cf-pomodoro"); } catch (_) {}
      chrome.alarms.create("cf-pomodoro", { when: until });
      sendResponse({ ok: true, until });
      updateBadge();
    })();
    return true;
  }

  // F4 — graceful cancel (clear alarm, reset Pomodoro state, leave PIN).
  if (msg.type === "cf:pomodoro-cancel") {
    (async () => {
      try { chrome.alarms.clear("cf-pomodoro"); } catch (_) {}
      const data = await chrome.storage.local.get(["focusLock"]);
      const fl = data.focusLock || {};
      fl.pomodoroState = null;
      fl.activeUntil = 0;
      await chrome.storage.local.set({ focusLock: fl });
      sendResponse({ ok: true });
      updateBadge();
    })();
    return true;
  }

  // Popup wants the latest paid status without paying for the round-trip
  if (msg.type === "cf:get-paid") {
    chrome.storage.local.get(["paid", "paidAt"]).then((data) => {
      sendResponse({ paid: !!data.paid, paidAt: data.paidAt || null });
    });
    return true;
  }

  // Popup wants a fresh license check (force network)
  if (msg.type === "cf:refresh-paid") {
    extpay.getUser().then((user) => {
      sendResponse({ paid: !!user.paid });
    }).catch(() => {
      sendResponse({ paid: false, error: "network" });
    });
    return true;
  }

  // ---- ExtPay routing (every API call goes through here, never from
  // popup/options/content — avoids the CORS error the old custom
  // SDK hit when called from extension pages).
  // v1.3.4: ensure ExtPay's api_key exists in storage BEFORE opening
  // the tab. v1.3.3 correctly avoided the SDK's bounds-error popup by
  // building the URL ourselves and tab-opening it, but it also bypassed
  // the only code path that ever creates the api_key (which lives only
  // inside the SDK's open_payment_page / open_login_page — getUser
  // does not create it on a missing key, confirmed at
  // lib/extpay.js:1355-1362).
  //
  // We replicate the SDK's create_key() logic inline: POST to
  // /api/new-key, get a JSON string back, write it to BOTH storage
  // areas the SDK reads from. lib/extpay.js itself is untouched.

  // v1.4.2 — api_key helpers hoisted to module scope (see top of file).
  // The handlers below still reference them by the same names.

  // v1.4.2 — warm the ExtPay api_key while the popup is open so the
  // moment the user clicks Upgrade / I-already-paid the tab opens
  // instantly. Fire-and-forget from popup.js; we still respond so the
  // sender knows whether it was cached or freshly fetched.
  if (msg.type === "cf:prefetch-apikey") {
    (async () => {
      try {
        const existing = await _readExtpayApiKey();
        if (existing) {
          sendResponse({ ok: true, cached: true });
          return;
        }
        const created = await _createExtpayApiKey();
        sendResponse({ ok: !!created, cached: false });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (msg.type === "cf:open-payment" || msg.type === "cf:open-payment-page") {
    (async () => {
      const apiKey = await _ensureExtpayApiKey();
      // v1.4.21-phase3 — multi-plan support. ExtPay's openPaymentPage(nick)
      // routes to /choose-plan/<nick>; we accept the nickname via msg.plan
      // and validate against the two configured nicknames so a popup bug
      // can't open arbitrary plan URLs. If msg.plan is absent we fall back
      // to /choose-plan (ExtPay's plan-picker screen) — matches the SDK's
      // openPaymentPage() called with no args.
      const plan = (msg && typeof msg.plan === "string") ? msg.plan : "";
      const validPlan = (plan === "monthly" || plan === "annual") ? plan : "";
      let url;
      if (apiKey) {
        url = validPlan
          ? `https://extensionpay.com/extension/cleanfeed2342/choose-plan/${validPlan}?api_key=${encodeURIComponent(apiKey)}`
          : `https://extensionpay.com/extension/cleanfeed2342/choose-plan?api_key=${encodeURIComponent(apiKey)}`;
      } else {
        url = `https://extensionpay.com/extension/cleanfeed2342?back=choose-plan`;
      }
      try {
        await chrome.tabs.create({ url, active: true });
        sendResponse({ ok: true, hasApiKey: !!apiKey, plan: validPlan || null });
      } catch (err) {
        console.error("[CleanFeed] Failed to open payment tab:", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (
    msg.type === "cf:open-login" ||
    msg.type === "cf:open-extpay-login" ||
    msg.type === "cf:open-login-page"
  ) {
    (async () => {
      const apiKey = await _ensureExtpayApiKey();
      // Matches SDK's open_login_page:
      //   ${EXTENSION_URL}/reactivate?api_key=...&back=choose-plan&v2
      const url = apiKey
        ? `https://extensionpay.com/extension/cleanfeed2342/reactivate?api_key=${encodeURIComponent(apiKey)}&back=choose-plan&v2`
        : `https://extensionpay.com/extension/cleanfeed2342/reactivate?back=choose-plan`;
      try {
        await chrome.tabs.create({ url, active: true });
        sendResponse({ ok: true, hasApiKey: !!apiKey });
      } catch (err) {
        console.error("[CleanFeed] Failed to open login tab:", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }
  // Spec'd handler — return the full ExtPay user record.
  // v1.4.21-phase2 — route through syncSubscriptionFromExtPay so popup
  // refreshes update cf_subscription via the same path as periodic +
  // startup syncs. We pass the pre-fetched user to avoid a duplicate
  // network round-trip.
  if (msg.type === "cf:get-user") {
    (async () => {
      try {
        const user = await extpay.getUser();
        try {
          await chrome.storage.local.set({
            paidAt: user.paidAt ? user.paidAt.toISOString() : null,
          });
        } catch (_) {}
        await syncSubscriptionFromExtPay(user);
        sendResponse(user);
      } catch (_) {
        sendResponse({ paid: false, error: "network" });
      }
    })();
    return true;
  }
  // After user returns from magic-link, popup asks us to force-refresh.
  if (msg.type === "cf:force-refresh-paid") {
    extpay.getUser().then((user) => {
      sendResponse({ paid: !!user.paid });
    }).catch(() => sendResponse({ paid: false, error: "network" }));
    return true;
  }

  // Popup pushed a settings change: forward to all youtube tabs
  if (msg.type === "cf:push-settings") {
    chrome.tabs.query({ url: "*://*.youtube.com/*" }, (tabs) => {
      for (const t of tabs) {
        chrome.tabs.sendMessage(t.id, {
          type: "cf:settings-changed",
          settings: msg.settings || {},
          paid: msg.paid,
          whitelistedChannels: msg.whitelistedChannels,
          customCSS: msg.customCSS,
          // v1.4.9 — forward pausedUntil. Content scripts previously had to
          // wait for chrome.storage.onChanged to learn pause state, which
          // under rapid pause-click bursts could arrive out-of-order with
          // the message broadcast. Forwarding inline keeps content STATE
          // and storage in lock-step on every push.
          pausedUntil: typeof msg.pausedUntil === "number" ? msg.pausedUntil : undefined,
        }).catch(() => { /* tab may be closing */ });
      }
      sendResponse({ ok: true, tabs: tabs.length });
    });
    updateBadge();
    return true;
  }
});

// -------- context menu: "Block this channel" (PRO) ----------------------
//
// chrome.contextMenus is registered on YouTube domains only. When the user
// right-clicks anywhere and picks our menu item, we forward the click to
// the active tab's content script — which locates the nearest video card
// and extracts the channel handle/name to add to the blocklist.
//
// We don't gate the menu visibility by paid status (Chrome menus don't
// support dynamic per-page conditions easily). The handler in content.js
// checks `paid` and shows a "Pro feature" toast if the user isn't unlocked.
function _registerContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: "cf-block-channel",
        title: "Block this channel with CleanFeed",
        contexts: ["link", "page", "image", "video"],
        documentUrlPatterns: [
          "*://*.youtube.com/*",
          "*://music.youtube.com/*",
        ],
      });
    });
  } catch (_) { /* contextMenus permission may be denied — silently ignore */ }
}
_registerContextMenu();
chrome.runtime.onInstalled.addListener(_registerContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "cf-block-channel") return;
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, {
    type: "cf:block-channel-at",
    linkUrl: info.linkUrl || "",
    pageUrl: info.pageUrl || "",
  }).catch(() => {});
});

// -------- initial badge after SW startup --------------------------------
updateBadge();
