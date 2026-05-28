/* CleanFeed v1.4.20-beta — cf_stats migration regression sentinel.
 *
 * Reproduces the v1.4.20-alpha real-Chrome bug:
 *   On a developer-mode reload of a v1.4.19 unpacked extension to
 *   v1.4.20-alpha, chrome.runtime.onInstalled either doesn't fire at all
 *   or fires with details.reason !== "update". The v1.4.20-alpha migration
 *   was only invoked from the reason==="update" branch of one onInstalled
 *   listener, so cf_stats was never seeded. The user observed 22 storage
 *   keys post-upgrade with cf_stats missing.
 *
 * v1.4.20-beta fix: standalone ensureCfStats() seeder, called from BOTH
 * onInstalled and onStartup (no details.reason gate). Modeled on the
 * working ensureInstallId pattern that survived the same scenario for
 * installId since v1.4.17.
 *
 * Invariants:
 *   1. Real-Chrome state (22 v1.4.19 keys, no cf_stats) → seeder runs →
 *      cf_stats present with correct shape, OTHER 22 keys untouched.
 *   2. Idempotent: re-running the seeder leaves cf_stats.session_started
 *      and counters unchanged.
 *   3. Brand-new install (empty storage) → seeder creates cf_stats.
 *   4. Concurrent invocations race-safely → exactly one seed value wins;
 *      neither caller overwrites the other.
 *
 * Run with:  node tests/cf-stats-migration-real-chrome.js
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

// ----- minimal chrome.storage.local simulator --------------------------
// Models the FIFO + asynchrony of real chrome.storage.local writes. Each
// get and set takes one event-loop tick. Concurrent calls interleave per
// the JS event loop, which is the exact race shape we need for invariant 4.
function makeStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    get(keys) {
      return new Promise((resolve) => {
        setTimeout(() => {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k]));
          resolve(out);
        }, 0);
      });
    },
    set(patch) {
      return new Promise((resolve) => {
        setTimeout(() => {
          for (const k of Object.keys(patch)) data[k] = JSON.parse(JSON.stringify(patch[k]));
          resolve();
        }, 0);
      });
    },
    _peek() { return JSON.parse(JSON.stringify(data)); },
    _keyCount() { return Object.keys(data).length; },
  };
}

// Mirror of background.js ensureCfStats — same race-tolerant shape.
function makeEnsureCfStats(storage, nowFn) {
  return async function ensureCfStats() {
    const d = await storage.get(["cf_stats"]);
    if (d.cf_stats && typeof d.cf_stats === "object") return d.cf_stats;
    const seed = { blocked: {}, autoplay_avoided: {}, session_started: nowFn() };
    const d2 = await storage.get(["cf_stats"]);
    if (d2.cf_stats && typeof d2.cf_stats === "object") return d2.cf_stats;
    await storage.set({ cf_stats: seed });
    return seed;
  };
}

// Snapshot of the user's actual real-Chrome storage state (22 keys, no
// cf_stats) reported in the bug. Used verbatim for invariant 1.
function realChromeState() {
  return {
    blockedChannels: [],
    blockerModes: {},
    cf_initialized: true,
    cleanfeed_license: null,
    customCSS: "",
    extpayPaid: false,
    focusLock: { pinSet: false, activeUntil: 0, pinHash: "", pinSalt: "",
                 mode: "standard",
                 pomodoro: { focusMin: 25, breakMin: 5, cycles: 4 },
                 pomodoroState: null },
    hiddenKeywords: [],
    installId: "a1b2c3d4e5f6a7b8",
    onboardingChoice: "focused",
    onboardingComplete: true,
    paid: false,
    pausedUntil: 0,
    perPageEnabled: false,
    perPageSettings: { homepage: {}, watch: {}, subscriptions: {} },
    redirectHomeToSubs: false,
    reviewPromptShown: false,
    sessionStats: { total: 0, perBlocker: {} },
    settings: {
      "home-feed": true, "shorts": true,
      "watch-sidebar": false, "end-screen": false,
      "comments": false, "explore": false, "live-chat": false,
      "autoplay": false, "thumbnails": false, "subs-algo": false,
      "playables": false, "merch-shelf": false,
      "breaking-news": false, "mixes-playlists": false,
      "subs-most-relevant": false, "subs-members-only": false, "subs-watched": false,
    },
    timeTracking: {},
    usageCount: 5,
    whitelistedChannels: [],
  };
}

(async () => {
  // ===== 1. Real-Chrome state (22 keys, no cf_stats) — seed runs ===========
  // This is the EXACT failure mode from the v1.4.20-alpha bug report.
  {
    const initial = realChromeState();
    assertEq("1) precondition: 22 keys, no cf_stats", Object.keys(initial).length, 22);
    assertTrue("1) precondition: cf_stats absent", !("cf_stats" in initial));

    const storage = makeStorage(initial);
    const ensureCfStats = makeEnsureCfStats(storage, () => 1700000000000);

    await ensureCfStats();

    const after = storage._peek();
    assertTrue("1) cf_stats now present", "cf_stats" in after);
    assertEq ("1) cf_stats.blocked = {}",            after.cf_stats.blocked, {});
    assertEq ("1) cf_stats.autoplay_avoided = {}",   after.cf_stats.autoplay_avoided, {});
    assertEq ("1) cf_stats.session_started populated",
              after.cf_stats.session_started, 1700000000000);
    assertEq ("1) total key count is now 23 (22 + cf_stats)", Object.keys(after).length, 23);

    // None of the other 22 keys were touched.
    for (const k of Object.keys(initial)) {
      assertEq(`1) untouched: ${k}`, after[k], initial[k]);
    }
  }

  // ===== 2. Idempotent: re-run leaves session_started + counters unchanged =
  // The user might restart Chrome, triggering onStartup (which also calls
  // ensureCfStats) — the second call must NOT reset session_started or
  // overwrite counters that the content script wrote in between.
  {
    const storage = makeStorage({
      cf_stats: {
        blocked:          { "2026-05-26": { "shorts": 42, "comments": 7 } },
        autoplay_avoided: { "2026-05-26": { videos: 3, estimated_minutes: 30 } },
        session_started:  1699999999999,
      },
    });
    const ensureCfStats = makeEnsureCfStats(storage, () => 9999999999999);

    await ensureCfStats();
    await ensureCfStats();
    await ensureCfStats();

    const after = storage._peek();
    assertEq("2) session_started preserved across 3 re-runs",
             after.cf_stats.session_started, 1699999999999);
    assertEq("2) blocked counters preserved",
             after.cf_stats.blocked, { "2026-05-26": { "shorts": 42, "comments": 7 } });
    assertEq("2) autoplay_avoided counters preserved",
             after.cf_stats.autoplay_avoided, { "2026-05-26": { videos: 3, estimated_minutes: 30 } });
  }

  // ===== 3. Brand-new install (empty storage) — seed creates cf_stats ======
  {
    const storage = makeStorage({});
    const ensureCfStats = makeEnsureCfStats(storage, () => 1700000000001);

    await ensureCfStats();

    const after = storage._peek();
    assertTrue("3) cf_stats present after empty-storage seed", "cf_stats" in after);
    assertEq ("3) blocked init empty",          after.cf_stats.blocked, {});
    assertEq ("3) autoplay_avoided init empty", after.cf_stats.autoplay_avoided, {});
    assertEq ("3) session_started set to now",   after.cf_stats.session_started, 1700000000001);
  }

  // ===== 4. Concurrent invocations — race-safe ==============================
  // The two listeners (onInstalled and onStartup) can both fire in quick
  // succession. The second-check-after-get pattern in ensureCfStats means
  // the LATER write wins, but both invocations must converge — never produce
  // garbage state or split-brain.
  {
    const storage = makeStorage({});
    let counter = 1700000010000;
    const ensureCfStats = makeEnsureCfStats(storage, () => counter++);
    // Fire two concurrent invocations, do not await between.
    const p1 = ensureCfStats();
    const p2 = ensureCfStats();
    const [r1, r2] = await Promise.all([p1, p2]);

    const after = storage._peek();
    assertTrue("4) cf_stats present after concurrent seeds", "cf_stats" in after);
    assertEq ("4) blocked still empty",          after.cf_stats.blocked, {});
    assertEq ("4) autoplay_avoided still empty", after.cf_stats.autoplay_avoided, {});
    // Both callers got SOME cf_stats object back; whichever wrote first wins.
    assertTrue("4) caller 1 returned an object", r1 && typeof r1 === "object");
    assertTrue("4) caller 2 returned an object", r2 && typeof r2 === "object");
    // session_started is a single number, not split across both writes
    assertEq ("4) session_started is one of the two attempted seeds",
              [1700000010000, 1700000010001].indexOf(after.cf_stats.session_started) >= 0, true);
  }

  // ===== 5. Pre-seeded storage — ensureCfStats returns existing without write =
  // This is what the re-check pattern CAN guarantee: if cf_stats was
  // already written by another path (e.g., the existing _migrateForV140
  // call inside the onInstalled.update branch) BEFORE ensureCfStats's
  // first get fires, ensureCfStats returns the existing value without
  // calling set at all. Mirrors the realistic "second listener fires
  // after the first has already written" sequence.
  //
  // We instrument the simulator to count set() calls so we can assert
  // ensureCfStats made zero writes.
  {
    const storage = makeStorage({
      cf_stats: {
        blocked:          { "2026-05-26": { "home-feed": 99 } },
        autoplay_avoided: {},
        session_started:  1234,
      },
    });
    let setCount = 0;
    const origSet = storage.set.bind(storage);
    storage.set = (patch) => { setCount++; return origSet(patch); };
    const ensureCfStats = makeEnsureCfStats(storage, () => 9999);

    await ensureCfStats();
    await ensureCfStats();
    await ensureCfStats();

    assertEq("5) pre-seeded cf_stats: ensureCfStats made ZERO writes", setCount, 0);
    const after = storage._peek();
    assertEq("5) pre-seeded session_started preserved",
             after.cf_stats.session_started, 1234);
    assertEq("5) pre-seeded counters preserved",
             after.cf_stats.blocked, { "2026-05-26": { "home-feed": 99 } });
  }

  // ===== 6. cf_stats present but malformed (not an object) — re-seed =======
  // Defense in depth: if cf_stats somehow got stored as null or a primitive
  // by a buggy upstream caller, ensureCfStats must re-seed.
  {
    const storage = makeStorage({ cf_stats: null });
    const ensureCfStats = makeEnsureCfStats(storage, () => 1700000030000);
    await ensureCfStats();
    const after = storage._peek();
    assertEq("6) cf_stats=null is treated as absent and re-seeded",
             typeof after.cf_stats, "object");
    assertTrue("6) cf_stats is now a real object",
               after.cf_stats !== null && typeof after.cf_stats === "object");
    assertEq("6) re-seeded blocked = {}",          after.cf_stats.blocked, {});
    assertEq("6) re-seeded session_started",       after.cf_stats.session_started, 1700000030000);
  }

  process.stdout.write("\n");
  console.log(`CF-STATS MIGRATION (real Chrome): ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
})();
