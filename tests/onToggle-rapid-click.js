/* CleanFeed onToggle rapid-click simulation (v1.4.10).
 *
 * Audit finding 1.1: onToggle had the same shape as the v1.4.9 pause
 * bug — async handler with read → await storage.set → renderBlockers,
 * no re-entrance lock, no input-disable. Rapid checkbox clicks (or fast
 * cross-toggle clicks) fired overlapping handlers; renderBlockers
 * tore down the toggle <input> nodes mid-burst, dropping later clicks.
 *
 * v1.4.10 fix mirrors togglePause: module-level guard flag +
 * inputEl.disabled = true while the write is in flight; a re-entrant
 * call reverts the checkbox UI to the committed STATE and returns.
 *
 * Run with:  node tests/onToggle-rapid-click.js
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

// Minimal chrome.storage.local simulator (FIFO, async).
function makeStorage() {
  const data = {};
  return {
    set(patch) {
      return new Promise((resolve) => {
        setTimeout(() => {
          for (const k of Object.keys(patch)) data[k] = patch[k];
          resolve();
        }, 0);
      });
    },
    _peek() { return Object.assign({}, data); },
  };
}

// Minimal checkbox DOM stand-in.
function makeInput(initialChecked) {
  return { checked: initialChecked, disabled: false, isConnected: true };
}

// ---- pre-v1.4.10 onToggle (buggy: no re-entrance lock) ----------------
function makePopupV149(storage) {
  const STATE = { settings: {}, paid: true, renders: 0, writes: 0 };
  async function persistSettings() {
    STATE.writes++;
    return storage.set({ settings: Object.assign({}, STATE.settings) });
  }
  function renderBlockers() { STATE.renders++; }
  async function onToggle(blocker, inputEl) {
    STATE.settings[blocker.id] = !!inputEl.checked;
    await persistSettings();
    renderBlockers();
  }
  return { STATE, onToggle };
}

// ---- v1.4.10 onToggle (with re-entrance lock + input-disable) ---------
function makePopupV1410(storage) {
  const STATE = { settings: {}, paid: true, renders: 0, writes: 0 };
  let inFlight = false;
  async function persistSettings() {
    STATE.writes++;
    return storage.set({ settings: Object.assign({}, STATE.settings) });
  }
  function renderBlockers() { STATE.renders++; }
  async function onToggle(blocker, inputEl) {
    if (inFlight) {
      inputEl.checked = !!STATE.settings[blocker.id];
      return;
    }
    inFlight = true;
    inputEl.disabled = true;
    try {
      STATE.settings[blocker.id] = !!inputEl.checked;
      await persistSettings();
      renderBlockers();
    } finally {
      inFlight = false;
      if (inputEl.isConnected) inputEl.disabled = false;
    }
  }
  return { STATE, onToggle };
}

// ---- scenarios ----
(async () => {
  // ===== A — v1.4.9 baseline: 10 rapid clicks fire 10 writes =============
  {
    const storage = makeStorage();
    const popup = makePopupV149(storage);
    const blocker = { id: "shorts", tier: "free" };
    const input = makeInput(false);
    for (let i = 0; i < 10; i++) {
      input.checked = !input.checked;
      popup.onToggle(blocker, input);
    }
    await new Promise((r) => setTimeout(r, 50));
    assertEq("A) v1.4.9 — 10 rapid clicks fire 10 storage writes",
             popup.STATE.writes, 10);
  }

  // ===== B — v1.4.10 coalesces same-input rapid clicks to ONE write =====
  {
    const storage = makeStorage();
    const popup = makePopupV1410(storage);
    const blocker = { id: "shorts", tier: "free" };
    const input = makeInput(false);
    // first click flips to true; subsequent rapid clicks would flip the
    // UI further but the lock should drop them and revert .checked.
    for (let i = 0; i < 10; i++) {
      input.checked = !input.checked;
      popup.onToggle(blocker, input);
    }
    await new Promise((r) => setTimeout(r, 50));
    assertEq("B) v1.4.10 — 10 rapid clicks coalesce to 1 storage write",
             popup.STATE.writes, 1);
    // STATE matches first click's intent (true), and the input reverted
    // to STATE on each subsequent re-entrant call.
    assertEq("B) STATE.settings[shorts] = true (first click won)",
             popup.STATE.settings["shorts"], true);
    assertEq("B) input.checked reverted to committed STATE",
             input.checked, true);
  }

  // ===== C — v1.4.10 doesn't lose final state across CROSS-toggle bursts =
  // Click toggle A, then immediately click toggle B during A's write.
  // B's click is dropped (re-entrant), B's input reverts to committed
  // STATE (false). After A completes, a fresh click on B works normally.
  {
    const storage = makeStorage();
    const popup = makePopupV1410(storage);
    const A = { id: "home-feed", tier: "free" };
    const B = { id: "shorts",    tier: "free" };
    const inA = makeInput(false); const inB = makeInput(false);
    inA.checked = true; popup.onToggle(A, inA);            // start A's write
    inB.checked = true; popup.onToggle(B, inB);            // dropped (in flight)
    await new Promise((r) => setTimeout(r, 50));
    assertEq("C) A committed", popup.STATE.settings["home-feed"], true);
    assertEq("C) B dropped during A's in-flight", popup.STATE.settings["shorts"], undefined);
    assertEq("C) B's input reverted to STATE (false)", inB.checked, false);
    // After A settles, a fresh B click should work
    inB.checked = true; popup.onToggle(B, inB);
    await new Promise((r) => setTimeout(r, 50));
    assertEq("C) B now committed after A done", popup.STATE.settings["shorts"], true);
  }

  // ===== D — input.disabled is restored cleanly after the write =========
  // The committed checkbox's input is detached by renderBlockers in the
  // real popup; we model "still connected" here to assert the finally
  // re-enable path runs.
  {
    const storage = makeStorage();
    const popup = makePopupV1410(storage);
    const blocker = { id: "comments", tier: "free" };
    const input = makeInput(false);
    input.checked = true;
    popup.onToggle(blocker, input);
    // Mid-flight: input should be disabled
    assertEq("D) input disabled while write in flight", input.disabled, true);
    await new Promise((r) => setTimeout(r, 50));
    assertEq("D) input re-enabled after finally", input.disabled, false);
  }

  // ===== E — no regression: a single normal click still works ============
  {
    const storage = makeStorage();
    const popup = makePopupV1410(storage);
    const blocker = { id: "autoplay", tier: "pro" };
    const input = makeInput(false);
    input.checked = true;
    await popup.onToggle(blocker, input);
    assertEq("E) single click commits", popup.STATE.settings["autoplay"], true);
    assertEq("E) single click → 1 write", popup.STATE.writes, 1);
    assertEq("E) single click → 1 render", popup.STATE.renders, 1);
  }

  process.stdout.write("\n");
  console.log(`ONTOGGLE RAPID-CLICK: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
})();
