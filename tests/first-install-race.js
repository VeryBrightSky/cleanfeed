/* CleanFeed first-install race simulation (v1.4.6).
 *
 * Reproduces the race the popup hits on a brand-new install:
 *   - chrome.storage.local starts EMPTY
 *   - chrome.runtime.onInstalled fires; background's defaults `set` is
 *     queued (resolves asynchronously)
 *   - User opens the popup; popup-init runs BEFORE that set resolves
 *
 * Pre-v1.4.6 behaviour: popup read empty storage, rendered the onboarding
 * preset view, user's preset pick was overwritten by onInstalled's later
 * full-defaults write, requiring 2-3 popup close/reopen cycles before
 * onboardingComplete stuck.
 *
 * v1.4.6 fix: popup awaits `waitForInitialized()` which listens for
 * `cf_initialized: true` (set in a separate write at the end of seeding)
 * or a non-empty `settings` change. The wait resolves before loadState,
 * so the popup never renders against empty storage on first install.
 *
 * This test simulates the ordering in plain JS (no chrome API) and
 * asserts the popup ends in a "ready" state without any
 * close/reopen cycle.
 *
 * Run with:  node tests/first-install-race.js
 * Exits non-zero on first failed assertion.
 */
"use strict";

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

// ---- minimal chrome.storage.local + onChanged simulator ----
function makeStorage() {
  const data = {};
  const listeners = [];
  return {
    get(keys, cb) {
      const out = {};
      const keyList = Array.isArray(keys) ? keys : (keys ? [keys] : Object.keys(data));
      for (const k of keyList) if (k in data) out[k] = data[k];
      // simulate async dispatch
      setTimeout(() => cb(out), 0);
    },
    set(patch, cb) {
      const changes = {};
      // schedule async resolution so we can interleave ordering
      setTimeout(() => {
        for (const k of Object.keys(patch)) {
          const oldVal = data[k];
          data[k] = patch[k];
          changes[k] = { oldValue: oldVal, newValue: patch[k] };
        }
        for (const fn of listeners.slice()) fn(changes, "local");
        if (cb) cb();
      }, 0);
    },
    onChanged: {
      addListener(fn) { listeners.push(fn); },
      removeListener(fn) {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
    _peek() { return Object.assign({}, data); },
  };
}

// ---- simulate background.js v1.4.6 onInstalled "install" path ----
function simulateOnInstalledV146(storage) {
  // Mirrors background.js:114-179 (the install branch).
  const defaults = {
    settings: {
      "home-feed": true, "shorts": true,
      "watch-sidebar": false, "end-screen": false,
      "comments": false, "explore": false, "live-chat": false,
      "autoplay": false, "thumbnails": false, "subs-algo": false,
      "playables": false, "merch-shelf": false,
      "breaking-news": false, "mixes-playlists": false,
      // v1.4.19 — three new Pro blockers seeded OFF.
      "subs-most-relevant": false, "subs-members-only": false, "subs-watched": false,
    },
    paid: false,
    whitelistedChannels: [],
    customCSS: "",
    sessionStats: { total: 0, perBlocker: {} },
    pausedUntil: 0,
    blockedChannels: [],
    focusLock: { pinSet:false, activeUntil:0, mode:"standard",
                 pomodoro:{focusMin:25,breakMin:5,cycles:4}, pomodoroState:null },
    timeTracking: {},
    hiddenKeywords: [],
    onboardingComplete: false,
    onboardingChoice: null,
    usageCount: 0,
    reviewPromptShown: false,
    perPageEnabled: false,
    perPageSettings: { homepage: {}, watch: {}, subscriptions: {} },
  };
  return new Promise((resolve) => {
    storage.set(defaults, () => {
      storage.set({ cf_initialized: true }, () => resolve());
    });
  });
}

// ---- minimal popup-init replica (v1.4.6) ----
//
// Reproduces the relevant slice of popup/popup.js:
//   - waitForInitialized() — listens for cf_initialized or non-empty settings
//   - loadState() — reads STATE from storage
//   - if (!onboardingComplete) renderOnboarding() else renderToggles()
//   - storage.onChanged handler that self-recovers onboardingComplete=true
function makePopupV146(storage) {
  const STATE = { settings:{}, onboardingComplete:false, loaded:false,
                  view:"none" /* "none" | "onboarding" | "toggles" */ };
  function isInitialized(d) {
    if (d && d.cf_initialized === true) return true;
    if (d && d.settings && typeof d.settings === "object" &&
        Object.keys(d.settings).length > 0) return true;
    return false;
  }
  function waitForInitialized() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        storage.onChanged.removeListener(onChange);
        clearTimeout(safety);
        resolve();
      };
      function onChange(changes, area) {
        if (area !== "local") return;
        if (changes.cf_initialized && changes.cf_initialized.newValue === true) {
          finish();
          return;
        }
        if (changes.settings && changes.settings.newValue &&
            Object.keys(changes.settings.newValue).length > 0) {
          finish();
        }
      }
      storage.onChanged.addListener(onChange);
      storage.get(["cf_initialized", "settings"], (data) => {
        if (isInitialized(data)) finish();
      });
      const safety = setTimeout(finish, 3000);
    });
  }
  function loadState() {
    return new Promise((resolve) => {
      storage.get(["settings", "onboardingComplete"], (data) => {
        STATE.settings = data.settings || {};
        STATE.onboardingComplete = !!data.onboardingComplete;
        resolve();
      });
    });
  }
  function render() {
    STATE.view = STATE.onboardingComplete ? "toggles" : "onboarding";
  }
  // Mirror popup.js's onChanged handler for onboardingComplete
  storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.onboardingComplete) {
      const newVal = !!changes.onboardingComplete.newValue;
      if (newVal && !STATE.onboardingComplete) {
        STATE.onboardingComplete = true;
        STATE.view = "toggles";
      }
    }
  });
  async function init() {
    await waitForInitialized();
    await loadState();
    render();
    STATE.loaded = true;
  }
  return { STATE, init };
}

// User picks the "Focused" preset — writes settings + onboardingComplete:true
function userPicksPreset(storage) {
  return new Promise((resolve) => {
    storage.set({
      settings: { "home-feed": true, "shorts": true, "end-screen": false, "autoplay": false },
      onboardingComplete: true,
      onboardingChoice: "focused",
    }, resolve);
  });
}

// ---- run scenarios ----
(async () => {
  // ====== Scenario A — v1.4.6 fix, popup opens BEFORE seed write resolves ======
  {
    const storage = makeStorage();
    // Background fires onInstalled — DO NOT await it; this leaves the
    // defaults write in flight when the popup-init starts.
    const installP = simulateOnInstalledV146(storage);
    const popup = makePopupV146(storage);
    // Popup-init starts immediately, racing the install write.
    await popup.init();
    await installP; // let background finish
    // Allow any trailing storage.onChanged callbacks to fire
    await new Promise((r) => setTimeout(r, 5));
    assertTrue("A) popup is loaded",            popup.STATE.loaded === true);
    assertEq ("A) settings populated (v1.4.19 = 17)", Object.keys(popup.STATE.settings).length, 17);
    assertEq ("A) view is NOT dead/blank",      popup.STATE.view !== "none", true);
    // After waitForInitialized, cf_initialized has landed and so has
    // onboardingComplete:false. Popup correctly shows onboarding view
    // (not toggles) — but it is RESPONSIVE, not blank.
    assertEq ("A) view is onboarding (ready)",  popup.STATE.view, "onboarding");
    // Storage in the canonical "fully seeded" state
    const peek = storage._peek();
    assertEq ("A) cf_initialized = true",       peek.cf_initialized, true);
  }

  // ====== Scenario B — v1.4.6 fix, user picks preset under contention ======
  // The whole point: even if user-picks-preset races with the in-flight
  // defaults write, the popup never reads empty storage (waitForInitialized
  // ensures defaults landed first), so onPresetChosen's onboardingComplete=true
  // doesn't get clobbered.
  {
    const storage = makeStorage();
    const installP = simulateOnInstalledV146(storage);
    const popup = makePopupV146(storage);
    await popup.init();
    // popup is ready; user picks "Focused"
    await userPicksPreset(storage);
    await installP;
    await new Promise((r) => setTimeout(r, 5));
    const peek = storage._peek();
    assertEq ("B) onboardingComplete sticks at true", peek.onboardingComplete, true);
    assertEq ("B) onboardingChoice persisted",        peek.onboardingChoice, "focused");
    assertEq ("B) popup view = toggles (self-recovered)", popup.STATE.view, "toggles");
  }

  // ====== Scenario C — popup-onChanged self-recovers from clobber ======
  // Even if some hostile late write flipped onboardingComplete back to
  // false, the popup's storage.onChanged handler should restore
  // STATE.onboardingComplete=true the moment storage flips back to true.
  {
    const storage = makeStorage();
    await simulateOnInstalledV146(storage);
    const popup = makePopupV146(storage);
    await popup.init();
    // simulate user picking preset → storage flips onboardingComplete
    await new Promise((resolve) => {
      storage.set({ onboardingComplete: true }, resolve);
    });
    await new Promise((r) => setTimeout(r, 5));
    assertEq ("C) popup self-recovers to toggles view", popup.STATE.view, "toggles");
    assertEq ("C) STATE.onboardingComplete = true",     popup.STATE.onboardingComplete, true);
  }

  // ====== Scenario D — existing user upgrading (already-populated settings) ======
  // waitForInitialized must NOT hang waiting for cf_initialized that an
  // existing-user upgrade hasn't written yet. Populated `settings` should
  // short-circuit the readiness check.
  {
    const storage = makeStorage();
    // Pre-seed as if v1.4.5 was already installed
    await new Promise((resolve) => storage.set({
      settings: { "home-feed": true, "shorts": true, "watch-sidebar": false },
      onboardingComplete: true,
    }, resolve));
    const popup = makePopupV146(storage);
    const t0 = Date.now();
    await popup.init();
    const elapsed = Date.now() - t0;
    assertTrue("D) existing-user init resolves promptly (<200ms)", elapsed < 200);
    assertEq ("D) popup view = toggles",      popup.STATE.view, "toggles");
    assertEq ("D) loaded = true",             popup.STATE.loaded, true);
  }

  console.log(`\n\nFIRST-INSTALL RACE: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
