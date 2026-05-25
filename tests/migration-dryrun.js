/* CleanFeed migration dry-run.
 *
 * Re-implements the same patch logic as background.js → _migrateForV140()
 * and runs it against 5 simulated user states. No browser, no chrome API.
 *
 * Run with:  node tests/migration-dryrun.js
 *
 * Exits non-zero on first failed assertion.
 */
"use strict";

const NEW_BLOCKER_DEFAULTS = {
  "playables": false,
  "merch-shelf": false,
  "breaking-news": false,
  "mixes-playlists": false,
  // v1.4.19 — three new Pro blockers for the Subscriptions feed.
  "subs-most-relevant": false,
  "subs-members-only": false,
  "subs-watched": false,
};

// Mirror of background.js _migrateForV140 — pure function form.
function migrate(initialStorage) {
  const data = JSON.parse(JSON.stringify(initialStorage));    // deep clone
  const patch = {};
  const s = Object.assign({}, NEW_BLOCKER_DEFAULTS, data.settings || {});
  patch.settings = s;
  if (typeof data.onboardingComplete === "undefined") {
    const hasUserSettings = data.settings &&
      Object.values(data.settings).some((v) => v === true);
    patch.onboardingComplete = !!hasUserSettings;
  }
  if (typeof data.hiddenKeywords === "undefined")     patch.hiddenKeywords = [];
  if (typeof data.usageCount === "undefined")          patch.usageCount = 0;
  if (typeof data.reviewPromptShown === "undefined")   patch.reviewPromptShown = false;
  if (typeof data.perPageEnabled === "undefined")      patch.perPageEnabled = false;
  if (typeof data.perPageSettings === "undefined") {
    patch.perPageSettings = { homepage: {}, watch: {}, subscriptions: {} };
  }
  // v1.4.19 — homepage→subs redirect + per-blocker render modes.
  if (typeof data.redirectHomeToSubs === "undefined") patch.redirectHomeToSubs = false;
  if (typeof data.blockerModes === "undefined" || data.blockerModes === null ||
      typeof data.blockerModes !== "object") {
    patch.blockerModes = {};
  }
  const fl = Object.assign({}, data.focusLock || {});
  if (typeof fl.mode === "undefined") fl.mode = "standard";
  if (typeof fl.pomodoro === "undefined") fl.pomodoro = { focusMin: 25, breakMin: 5, cycles: 4 };
  if (typeof fl.pomodoroState === "undefined") fl.pomodoroState = null;
  patch.focusLock = fl;
  // simulate chrome.storage.local.set(patch) — merge over data
  return Object.assign({}, data, patch);
}

let pass = 0, fail = 0;
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; process.stdout.write("."); }
  else {
    fail++;
    console.error(`\n  FAIL ${name}\n    expected: ${e}\n    actual:   ${a}`);
  }
}
function assertTrue(name, cond) {
  if (cond) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}`); }
}

// ----- Scenarios -----

// a) Brand-new install — onInstalled.reason==="install" path handles
// this (full defaults written). Migrate should NOT clobber if it ran
// anyway on a brand-new install.
{
  const before = {};
  const after = migrate(before);
  assertEq("a) brand-new: settings keys count (v1.4.19 adds 3)", Object.keys(after.settings).length, 7);
  assertTrue("a) onboardingComplete=false (empty settings)", after.onboardingComplete === false);
  assertEq("a) hiddenKeywords default", after.hiddenKeywords, []);
  assertEq("a) usageCount default", after.usageCount, 0);
  assertEq("a) perPageEnabled default", after.perPageEnabled, false);
  assertEq("a) perPageSettings default", after.perPageSettings, { homepage: {}, watch: {}, subscriptions: {} });
  assertEq("a) focusLock.mode default", after.focusLock.mode, "standard");
  assertEq("a) focusLock.pomodoro default", after.focusLock.pomodoro, { focusMin: 25, breakMin: 5, cycles: 4 });
  assertEq("a) focusLock.pomodoroState default", after.focusLock.pomodoroState, null);
  // v1.4.19 — new top-level keys seeded with safe defaults.
  assertEq("a) redirectHomeToSubs default", after.redirectHomeToSubs, false);
  assertEq("a) blockerModes default", after.blockerModes, {});
  assertEq("a) subs-most-relevant seeded off", after.settings["subs-most-relevant"], false);
  assertEq("a) subs-members-only seeded off", after.settings["subs-members-only"], false);
  assertEq("a) subs-watched seeded off",      after.settings["subs-watched"], false);
}

// b) Existing v1.3.4 free user with settings configured
{
  const before = {
    paid: false,
    settings: {
      "home-feed": true, "shorts": true,
      "watch-sidebar": false, "end-screen": false,
      "comments": false, "explore": false,
      "live-chat": false, "autoplay": false,
      "thumbnails": false, "subs-algo": false,
    },
    sessionStats: { total: 7, perBlocker: {} },
    pausedUntil: 0,
  };
  const after = migrate(before);
  assertEq("b) home-feed preserved", after.settings["home-feed"], true);
  assertEq("b) shorts preserved",    after.settings["shorts"],    true);
  assertEq("b) playables added off", after.settings["playables"], false);
  assertEq("b) merch-shelf added off", after.settings["merch-shelf"], false);
  assertEq("b) settings now 17 keys (v1.4.19)", Object.keys(after.settings).length, 17);
  assertEq("b) subs-most-relevant added off", after.settings["subs-most-relevant"], false);
  assertEq("b) subs-members-only added off", after.settings["subs-members-only"], false);
  assertEq("b) subs-watched added off",      after.settings["subs-watched"], false);
  assertEq("b) redirectHomeToSubs default false", after.redirectHomeToSubs, false);
  assertEq("b) blockerModes default {}", after.blockerModes, {});
  assertTrue("b) onboardingComplete=true (has truthy)", after.onboardingComplete === true);
  assertEq("b) sessionStats preserved", after.sessionStats, { total: 7, perBlocker: {} });
}

// c) Existing v1.3.4 paid user with Focus Lock configured
{
  const before = {
    paid: true,
    settings: { "home-feed": true, "shorts": true, "comments": true },
    focusLock: { pinSet: true, pinHash: "abcdef", pinSalt: "ghi", activeUntil: 0 },
  };
  const after = migrate(before);
  assertTrue("c) pinHash preserved",       after.focusLock.pinHash === "abcdef");
  assertTrue("c) pinSalt preserved",       after.focusLock.pinSalt === "ghi");
  assertTrue("c) pinSet preserved",        after.focusLock.pinSet  === true);
  assertEq("c) activeUntil preserved", after.focusLock.activeUntil, 0);
  assertEq("c) mode added standard",   after.focusLock.mode, "standard");
  assertEq("c) pomodoroState added null", after.focusLock.pomodoroState, null);
  assertTrue("c) onboardingComplete=true", after.onboardingComplete === true);
}

// d) Existing user mid-Pomodoro at upgrade time (alarm pending)
// — simulates an in-flight Pomodoro session where v1.4.0 was somehow
// configured before this re-migration (unlikely but defensive).
{
  const before = {
    paid: true,
    settings: { "home-feed": true },
    focusLock: {
      pinSet: true, pinHash: "x", pinSalt: "y", activeUntil: Date.now() + 60000,
      mode: "pomodoro",
      pomodoro: { focusMin: 30, breakMin: 7, cycles: 3 },
      pomodoroState: { phase: "focus", cycle: 2, total: 3, until: Date.now() + 60000 },
    },
  };
  const after = migrate(before);
  assertEq("d) pomodoroState preserved", after.focusLock.pomodoroState.phase, "focus");
  assertEq("d) pomodoro config preserved.focusMin", after.focusLock.pomodoro.focusMin, 30);
  assertEq("d) pomodoro config preserved.breakMin", after.focusLock.pomodoro.breakMin, 7);
  assertEq("d) pomodoro config preserved.cycles", after.focusLock.pomodoro.cycles, 3);
  assertTrue("d) activeUntil > 0 preserved", after.focusLock.activeUntil > Date.now());
}

// e) Existing user with perPageEnabled accidentally true but no perPageSettings
{
  const before = {
    paid: true,
    settings: { "home-feed": true, "shorts": true },
    perPageEnabled: true,
    // perPageSettings deliberately absent
  };
  const after = migrate(before);
  assertEq("e) perPageEnabled preserved", after.perPageEnabled, true);
  assertEq("e) perPageSettings filled in",
           after.perPageSettings, { homepage: {}, watch: {}, subscriptions: {} });
}

// ----- summary -----
console.log(`\n\nMIGRATION DRY-RUN: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
