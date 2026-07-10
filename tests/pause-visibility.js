/* CleanFeed v1.4.24.5 — paused-state visibility.
 *
 * A paused CleanFeed used to be visually identical to a broken one.
 * v1.4.24.5 makes the state unmissable: popup banner, warn toolbar badge,
 * on-page pill — plus stale-pause cleanup so an expired pausedUntil never
 * lingers in storage, and a guarantee that install/update never pauses.
 *
 * Sections:
 *   1. readAndCleanPausedUntil model — mirrors background.js exactly
 *   2. Writers audit — the ONLY non-zero pausedUntil writer is the popup
 *      pause button (togglePause); install/update/reset paths never pause
 *   3. Shipped-string checks — banner / badge / pill / alarm wiring present
 *   4. Banner + resume models — visible iff paused, countdown text, resume
 *      clears storage
 *
 * Run with:  node tests/pause-visibility.js
 * Exits non-zero on first failed assertion.
 */
"use strict";

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assertTrue(name, cond) {
  if (cond) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}`); }
}
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}\n    expected: ${e}\n    actual:   ${a}`); }
}

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const bg = read("background.js");
const popupJs = read("popup/popup.js");
const popupHtml = read("popup/popup.html");
const popupCss = read("popup/popup.css");
const contentJs = read("content/content.js");
const stylesCss = read("content/styles.css");
const optionsJs = read("options/options.js");

// ==========================================================================
// 1. readAndCleanPausedUntil model (mirrors background.js)
// ==========================================================================
function makeStorage(initial) {
  const store = Object.assign({}, initial);
  return {
    store,
    removed: [],
    async get(keys) {
      const out = {};
      for (const k of keys) if (k in store) out[k] = store[k];
      return out;
    },
    async remove(key) { this.removed.push(key); delete store[key]; },
  };
}
async function readAndCleanPausedUntil(storage) {
  let data;
  try { data = await storage.get(["pausedUntil"]); } catch (_) { return 0; }
  const raw = Number(data.pausedUntil) || 0;
  const corrupt = raw > Date.now() + 60 * 60 * 1000 + 5 * 60 * 1000;
  if (raw > 0 && (corrupt || raw <= Date.now())) {
    try { await storage.remove("pausedUntil"); } catch (_) {}
    return 0;
  }
  return raw > Date.now() ? raw : 0;
}

(async () => {
  // expired pause → cleared from storage, returns 0 (badge falls back to count)
  {
    const s = makeStorage({ pausedUntil: Date.now() - 5000 });
    const v = await readAndCleanPausedUntil(s);
    assertEq("1) expired pausedUntil returns 0", v, 0);
    assertEq("1) expired pausedUntil REMOVED from storage", s.removed, ["pausedUntil"]);
    assertTrue("1) key no longer in storage", !("pausedUntil" in s.store));
  }
  // future pause → kept, returned as-is (banner + badge render from it)
  {
    const until = Date.now() + 42 * 60 * 1000;
    const s = makeStorage({ pausedUntil: until });
    const v = await readAndCleanPausedUntil(s);
    assertEq("1) live pausedUntil passes through", v, until);
    assertEq("1) live pausedUntil NOT removed", s.removed, []);
  }
  // corrupt far-future → cleared (v1.4.9 clamp, now also removes the key)
  {
    const s = makeStorage({ pausedUntil: Date.now() + 365 * 24 * 60 * 60 * 1000 });
    const v = await readAndCleanPausedUntil(s);
    assertEq("1) corrupt far-future pausedUntil returns 0", v, 0);
    assertEq("1) corrupt pausedUntil REMOVED from storage", s.removed, ["pausedUntil"]);
  }
  // absent / zero → 0, no remove call (no churn, no onChanged loop)
  {
    const s = makeStorage({});
    assertEq("1) absent pausedUntil returns 0", await readAndCleanPausedUntil(s), 0);
    assertEq("1) absent pausedUntil triggers no remove", s.removed, []);
  }
  {
    const s = makeStorage({ pausedUntil: 0 });
    assertEq("1) zero pausedUntil returns 0", await readAndCleanPausedUntil(s), 0);
    assertEq("1) zero pausedUntil triggers no remove", s.removed, []);
  }
  // re-entry after removal (the onChanged → updateBadge second pass): no loop
  {
    const s = makeStorage({ pausedUntil: Date.now() - 1 });
    await readAndCleanPausedUntil(s);
    await readAndCleanPausedUntil(s);
    assertEq("1) second pass after removal is a no-op (no loop)", s.removed, ["pausedUntil"]);
  }

  // ========================================================================
  // 2. Writers audit — who can set a NON-ZERO pausedUntil?
  // ========================================================================
  {
    // The only expression anywhere that produces a non-zero pause value:
    assertTrue("2) popup togglePause is the sole non-zero writer expression",
      popupJs.includes("STATE.pausedUntil = Date.now() + PAUSE_DURATION_MS"));
    // ...and it is written to storage only via the pause-button handler.
    const nonZeroWriters = (popupJs.match(/pausedUntil = Date\.now\(\)/g) || []).length;
    assertEq("2) exactly ONE non-zero pausedUntil assignment in popup.js", nonZeroWriters, 1);
    // No other shipped file ever constructs a future pausedUntil.
    for (const [name, src] of [["background.js", bg], ["content.js", contentJs], ["options.js", optionsJs]]) {
      assertTrue(`2) ${name} never writes a non-zero pausedUntil`,
        !/pausedUntil\s*[:=]\s*Date\.now\(\)\s*\+/.test(src));
    }
    // Install seed writes 0 (unpaused), and install/update explicitly remove
    // any leftover key — a fresh install or an update can never start paused.
    assertTrue("2) install seed contains pausedUntil: 0",
      bg.includes("pausedUntil: 0,"));
    assertTrue("2) onInstalled removes pausedUntil on install AND update",
      /details\.reason === "install" \|\| details\.reason === "update"/.test(bg) &&
      bg.includes('chrome.storage.local.remove("pausedUntil")'));
    // Options "Reset All" writes 0 — resets never pause either.
    assertTrue("2) options resetAll resets pausedUntil to 0",
      optionsJs.includes("pausedUntil: 0,"));
  }

  // ========================================================================
  // 3. Shipped-string checks — banner / badge / pill / alarm wiring
  // ========================================================================
  {
    // Popup banner: top of body, hidden by default, exact copy, resume button.
    const bodyIdx = popupHtml.indexOf("<body");
    const bannerIdx = popupHtml.indexOf('id="cf-paused-banner"');
    const headerIdx = popupHtml.indexOf('class="cf-header"');
    assertTrue("3) banner section present in popup.html", bannerIdx !== -1);
    assertTrue("3) banner sits ABOVE the header (top of popup)",
      bodyIdx < bannerIdx && bannerIdx < headerIdx);
    assertTrue("3) banner is hidden by default (absent when not paused)",
      /id="cf-paused-banner"[^>]*\bhidden\b/.test(popupHtml));
    assertTrue("3) banner headline copy exact",
      popupHtml.includes("⏸ CleanFeed is paused — nothing is being blocked"));
    assertTrue("3) banner has a Resume now button",
      popupHtml.includes('id="cf-resume-now"') && popupHtml.includes("Resume now"));
    assertTrue("3) banner styled with --warn low-opacity bg + 1px --warn border",
      popupCss.includes("rgba(255, 122, 138, 0.12)") &&
      popupCss.includes("border: 1px solid var(--warn)"));

    // Popup JS: banner renderer + countdown + resume wiring.
    assertTrue("3) renderPauseBanner defined", popupJs.includes("function renderPauseBanner()"));
    assertTrue("3) countdown copy 'Resumes in N min'", popupJs.includes("Resumes in ${Math.ceil(ms / 60000)} min"));
    assertTrue("3) banner updated by the 1s pause tick",
      /renderPauseBanner\(\);\s*\}, 1000\)/.test(popupJs));
    assertTrue("3) resumeNow clears storage pausedUntil",
      popupJs.includes("chrome.storage.local.set({ pausedUntil: 0 })"));
    assertTrue("3) resumeNow reloads YouTube tabs",
      popupJs.includes("chrome.tabs.reload(t.id)"));
    assertTrue("3) resume button click wired",
      popupJs.includes('$("cf-resume-now").addEventListener("click", resumeNow)'));

    // Background: cleaning accessor, warn badge, expiry alarm on all triggers.
    assertTrue("3) readAndCleanPausedUntil defined in background.js",
      bg.includes("async function readAndCleanPausedUntil()"));
    assertTrue("3) updateBadge routes reads through the cleaning accessor",
      bg.includes("const pausedUntil = await readAndCleanPausedUntil()"));
    assertTrue("3) paused badge glyph kept", bg.includes('setBadgeText({ text: "⏸" })'));
    assertTrue("3) paused badge uses the warn color (was dim gray)",
      bg.includes('"#FF7A8A"') && !bg.includes('"#5E6C7E"'));
    assertTrue("3) cf-pause-expiry alarm created at pause set",
      bg.includes('chrome.alarms.create("cf-pause-expiry"'));
    assertTrue("3) cf-pause-expiry alarm cleared at unpause",
      bg.includes('chrome.alarms.clear("cf-pause-expiry")'));
    assertTrue("3) onAlarm handles cf-pause-expiry (cleanup + badge reset)",
      bg.includes('alarm.name === "cf-pause-expiry"'));
    assertTrue("3) storage.onChanged syncs the expiry alarm",
      bg.includes("_syncPauseExpiryAlarm(changes.pausedUntil.newValue)"));
    assertTrue("3) onStartup sweeps stale pause",
      /onStartup[\s\S]{0,400}readAndCleanPausedUntil/.test(bg));

    // Content pill: created only while paused, session-guarded, dismissible.
    assertTrue("3) maybeShowPausePill defined", contentJs.includes("function maybeShowPausePill()"));
    assertTrue("3) pill bails when not paused", /maybeShowPausePill\(\) \{\s*\n\s*if \(!isPaused\(\)\) return;/.test(contentJs));
    assertTrue("3) pill once-per-pause-session via sessionStorage keyed on timestamp",
      contentJs.includes('"cf-pause-pill-" + STATE.pausedUntil'));
    assertTrue("3) pill copy", contentJs.includes('"CleanFeed is paused"'));
    assertTrue("3) pill dismiss button present", contentJs.includes("cf-pause-pill-close"));
    assertTrue("3) pill auto-fades after 5s", /cf-pause-pill-fade[\s\S]{0,120}\}, 5000\)/.test(contentJs));
    assertTrue("3) pill styles shipped (fixed bottom-right)",
      stylesCss.includes(".cf-pause-pill {") &&
      /\.cf-pause-pill \{[^}]*position: fixed/.test(stylesCss) &&
      /\.cf-pause-pill \{[^}]*bottom: 16px/.test(stylesCss));
    assertTrue("3) pill fade class shipped", stylesCss.includes(".cf-pause-pill-fade"));
    // Content re-applies blockers when pausedUntil changes (resume → unhide-
    // free page even without the reload).
    assertTrue("3) content re-applies blockers on pausedUntil change",
      /changes\.pausedUntil[\s\S]{0,200}applyBlockers\(\)/.test(contentJs));
  }

  // ========================================================================
  // 4. Banner + resume behavioural models
  // ========================================================================
  {
    // Mirror of popup renderPauseBanner + resumeNow semantics.
    function bannerModel(pausedUntil, now) {
      if (!(pausedUntil > now)) return { hidden: true, text: "" };
      const ms = pausedUntil - now;
      const text = ms >= 60 * 1000
        ? `Resumes in ${Math.ceil(ms / 60000)} min`
        : `Resumes in ${Math.max(1, Math.ceil(ms / 1000))}s`;
      return { hidden: false, text };
    }
    const now = 1_000_000_000_000;
    assertEq("4) not paused → banner hidden", bannerModel(0, now).hidden, true);
    assertEq("4) expired → banner hidden", bannerModel(now - 1, now).hidden, true);
    const b60 = bannerModel(now + 60 * 60 * 1000, now);
    assertEq("4) fresh 1h pause → 'Resumes in 60 min'", b60, { hidden: false, text: "Resumes in 60 min" });
    assertEq("4) 12.5 min left rounds up to 13 min",
      bannerModel(now + 12.5 * 60 * 1000, now).text, "Resumes in 13 min");
    assertEq("4) 45s left switches to seconds",
      bannerModel(now + 45 * 1000, now).text, "Resumes in 45s");

    // Resume model: storage cleared, banner hides, badge branch falls through.
    const s = makeStorage({ pausedUntil: now + 30 * 60 * 1000 });
    s.store.pausedUntil = 0;                       // resumeNow writes 0
    const after = await readAndCleanPausedUntil(s);
    assertEq("4) after resume, pause read is 0 (badge → count branch)", after, 0);
    assertEq("4) after resume, banner hidden", bannerModel(after, now).hidden, true);
  }

  console.log(`\nPAUSE VISIBILITY: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
