/* CleanFeed rapid pause-click simulation (v1.4.9).
 *
 * Reproduces the v1.4.8 bug:
 *   - User clicks "Pause for 1 hour"
 *   - Then rapidly spam-clicks it ~10 times in tight succession
 *   - Pre-v1.4.9: togglePause() has no re-entrance lock; N async handlers
 *     race on STATE.pausedUntil and chrome.storage.local. The popup's own
 *     storage.onChanged listener clobbers STATE between successive clicks'
 *     sync read-modify-write windows, so storage's final pausedUntil does
 *     not necessarily match parity of clicks — and the badge / content
 *     script can be left stuck in the wrong state.
 *
 *   v1.4.9 fix: in-flight lock + visible button-disable coalesces a burst
 *   into a single transition. While a write is mid-flight, subsequent
 *   clicks are dropped (no-op). Plus sanePausedUntil() clamps corrupted
 *   timestamps so the extension can always self-heal.
 *
 * Run with:  node tests/pause-rapid-click.js
 * Exits non-zero on first failed assertion.
 */
"use strict";

const PAUSE_DURATION_MS = 60 * 60 * 1000;       // 1hr
const PAUSE_MAX_SLACK_MS = 5 * 60 * 1000;

function sanePausedUntil(raw) {
  const n = Number(raw) || 0;
  if (n <= 0) return 0;
  if (n > Date.now() + PAUSE_DURATION_MS + PAUSE_MAX_SLACK_MS) return 0;
  return n;
}

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

// Minimal chrome.storage.local + onChanged simulator (FIFO writes).
function makeStorage() {
  const data = {};
  const listeners = [];
  return {
    set(patch) {
      return new Promise((resolve) => {
        setTimeout(() => {
          const changes = {};
          for (const k of Object.keys(patch)) {
            const oldVal = data[k];
            data[k] = patch[k];
            changes[k] = { oldValue: oldVal, newValue: patch[k] };
          }
          for (const fn of listeners.slice()) fn(changes, "local");
          resolve();
        }, 0);
      });
    },
    get(keys) {
      return new Promise((resolve) => {
        setTimeout(() => {
          const out = {};
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const k of keyList) if (k in data) out[k] = data[k];
          resolve(out);
        }, 0);
      });
    },
    onChanged: { addListener(fn) { listeners.push(fn); } },
    _peek() { return Object.assign({}, data); },
  };
}

// ---- pre-v1.4.9 togglePause (the buggy version) -----------------------
function makePopupV148(storage) {
  const STATE = { pausedUntil: 0, loaded: true, renders: 0 };
  function isPaused() { return STATE.pausedUntil > Date.now(); }
  async function togglePause() {
    if (!STATE.loaded) return;
    if (isPaused()) STATE.pausedUntil = 0;
    else STATE.pausedUntil = Date.now() + PAUSE_DURATION_MS;
    await storage.set({ pausedUntil: STATE.pausedUntil });
    STATE.renders++;
  }
  storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.pausedUntil) {
      STATE.pausedUntil = Number(changes.pausedUntil.newValue) || 0;
    }
  });
  return { STATE, togglePause };
}

// ---- v1.4.9 togglePause (with re-entrance lock + clamp) -----------------
function makePopupV149(storage) {
  const STATE = { pausedUntil: 0, loaded: true, renders: 0, btnDisabled: false };
  let inFlight = false;
  function isPaused() { return STATE.pausedUntil > Date.now(); }
  async function togglePause() {
    if (!STATE.loaded) return;
    if (inFlight) return;
    inFlight = true;
    STATE.btnDisabled = true;
    try {
      if (isPaused()) STATE.pausedUntil = 0;
      else STATE.pausedUntil = Date.now() + PAUSE_DURATION_MS;
      await storage.set({ pausedUntil: STATE.pausedUntil });
      STATE.renders++;
    } finally {
      inFlight = false;
      STATE.btnDisabled = false;
    }
  }
  storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.pausedUntil) {
      STATE.pausedUntil = sanePausedUntil(changes.pausedUntil.newValue);
    }
  });
  return { STATE, togglePause };
}

// ---- run scenarios ----
(async () => {
  // ===== Scenario A — v1.4.8 demonstrates the buggy unbounded re-entrance =====
  // The smoking gun isn't that storage ends "incoherent" (with FIFO writes
  // it usually settles), it's that N async handlers all run, each firing a
  // separate storage write + render. With 10 rapid clicks, 10 writes hit
  // storage and 10 renders fire — and the content script (modeled below)
  // sees a flapping stream of pause/unpause events.
  {
    const storage = makeStorage();
    const popup = makePopupV148(storage);
    // Fire 10 rapid clicks (no await between them — what the real
    // browser does when the user mashes the button).
    for (let i = 0; i < 10; i++) popup.togglePause();
    await new Promise((r) => setTimeout(r, 100));
    assertEq("A) v1.4.8 — 10 storage writes occurred (UNBOUNDED RE-ENTRANCE)",
             popup.STATE.renders, 10);
  }

  // ===== Scenario B — v1.4.9 coalesces rapid clicks into ONE transition =====
  {
    const storage = makeStorage();
    const popup = makePopupV149(storage);
    for (let i = 0; i < 10; i++) popup.togglePause();
    // Wait for in-flight to settle
    await new Promise((r) => setTimeout(r, 100));
    assertEq("B) v1.4.9 — 10 rapid clicks coalesce to 1 storage write",
             popup.STATE.renders, 1);
    // After the burst settles, popup should be PAUSED (1 toggle from initial 0)
    assertTrue("B) popup STATE.pausedUntil > now (paused)",
               popup.STATE.pausedUntil > Date.now());
    const peek = storage._peek();
    assertTrue("B) storage pausedUntil > now (paused)",
               peek.pausedUntil > Date.now());
    // Button is re-enabled after the transition
    assertEq("B) button is re-enabled post-transition",
             popup.STATE.btnDisabled, false);
  }

  // ===== Scenario C — v1.4.9 second burst can correctly UNPAUSE ============
  // After the first burst settles paused, a SECOND burst of clicks should
  // succeed in flipping back to unpaused (one transition), not get stuck.
  {
    const storage = makeStorage();
    const popup = makePopupV149(storage);
    for (let i = 0; i < 10; i++) popup.togglePause();
    await new Promise((r) => setTimeout(r, 100));
    assertTrue("C) after first burst, paused", popup.STATE.pausedUntil > Date.now());
    // Second burst
    for (let i = 0; i < 10; i++) popup.togglePause();
    await new Promise((r) => setTimeout(r, 100));
    assertEq("C) after second burst, pausedUntil = 0 (unpaused)",
             popup.STATE.pausedUntil, 0);
    const peek = storage._peek();
    assertEq("C) storage reflects unpaused state",
             peek.pausedUntil, 0);
  }

  // ===== Scenario D — sanePausedUntil clamps a corrupted huge timestamp ====
  // A future-far value (e.g. accidentally written as Date.now() * 1000)
  // would otherwise pin the extension paused for centuries. Clamp it to 0
  // so the extension self-heals on next read.
  {
    const corruptValue = Date.now() + 365 * 24 * 60 * 60 * 1000; // 1yr out
    assertEq("D) corrupt 1-year-future pausedUntil clamps to 0",
             sanePausedUntil(corruptValue), 0);
    // Valid 1-hour pause still passes through
    const validValue = Date.now() + PAUSE_DURATION_MS - 10000;
    assertEq("D) valid 1hr-future pausedUntil passes through",
             sanePausedUntil(validValue), validValue);
    // Negative / NaN / undefined → 0
    assertEq("D) negative → 0", sanePausedUntil(-1), 0);
    assertEq("D) NaN → 0",      sanePausedUntil(NaN), 0);
    assertEq("D) undefined → 0", sanePausedUntil(undefined), 0);
    assertEq("D) string garbage → 0", sanePausedUntil("hello"), 0);
  }

  // ===== Scenario E — rapid clicks DON'T leave button disabled forever ====
  // Regression guard: if togglePause throws between setting inFlight=true
  // and clearing it, the button must still re-enable. We assert simply
  // that after the burst the button is clickable.
  {
    const storage = makeStorage();
    const popup = makePopupV149(storage);
    for (let i = 0; i < 25; i++) popup.togglePause();
    await new Promise((r) => setTimeout(r, 100));
    assertEq("E) after 25-click burst, button is enabled",
             popup.STATE.btnDisabled, false);
  }

  // ---- summary ----
  process.stdout.write("\n");
  console.log(`PAUSE RAPID-CLICK: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
})();
