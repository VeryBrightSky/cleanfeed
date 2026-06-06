/* CleanFeed v1.4.23 — uninstall feedback URL sentinel.
 *
 * v1.4.23 calls chrome.runtime.setUninstallURL pointing to a Google Form
 * with the manifest version and the user's locale as query params. The
 * call lives inside chrome.runtime.onInstalled so it's set on install
 * and re-set on every update — setUninstallURL is idempotent and
 * persists across service-worker restarts.
 *
 * This suite is purely structural — it asserts the literal strings + URL
 * fragments are present in the shipped background.js. The runtime
 * correctness (form actually opens on uninstall, version + locale arrive
 * as the user actually uninstalls) is a real-Chrome manual check.
 *
 * Invariants asserted:
 *   1. background.js contains the literal string "setUninstallURL".
 *   2. The form URL "https://forms.gle/qngTc41kCvNSZCCX7" is in source.
 *   3. The URL construction includes "?v=" and "&locale=" so both
 *      query params reach the form.
 *   4. The call is wrapped in a try/catch (so a malformed locale or
 *      missing chrome.i18n never breaks the SW boot).
 *   5. The call is inside chrome.runtime.onInstalled (idempotent across
 *      installs and updates; not called on every SW restart).
 *
 * Run with:  node tests/uninstall-url.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assertTrue(name, cond) {
  if (cond) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}`); }
}

const REPO = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(REPO, "background.js"), "utf8");

// ===== 1. literal "setUninstallURL" present ==============================

assertTrue("1) background.js contains literal setUninstallURL",
  src.indexOf("setUninstallURL") >= 0);

// ===== 2. Google Form URL present ========================================

assertTrue("2) background.js references forms.gle/qngTc41kCvNSZCCX7",
  src.indexOf("forms.gle/qngTc41kCvNSZCCX7") >= 0);

// ===== 3. Query params present (?v=  AND  &locale=) ======================

assertTrue("3a) URL construction includes ?v= query param",
  src.indexOf("?v=") >= 0);
assertTrue("3b) URL construction includes &locale= query param",
  src.indexOf("&locale=") >= 0);

// ===== 4. setUninstallURL is wrapped in try/catch ========================
//
// Find the position of the actual API call (qualified form
// `chrome.runtime.setUninstallURL`) — NOT the literal string
// "setUninstallURL" which would also match a doc comment that explains
// the call. Then walk backwards for `try {` and forwards for `} catch`.

{
  const callMarker = "chrome.runtime.setUninstallURL";
  const idx = src.indexOf(callMarker);
  assertTrue("4.precondition) chrome.runtime.setUninstallURL call is present",
    idx >= 0);
  // Window: up to 200 chars before and 400 chars after.
  const before = src.slice(Math.max(0, idx - 200), idx);
  const after = src.slice(idx, idx + 400);
  assertTrue("4a) try { precedes the call (within 200-char window)",
    /try\s*\{/.test(before));
  assertTrue("4b) } catch follows the call (within 400-char window)",
    /\}\s*catch/.test(after));
}

// ===== 5. setUninstallURL is inside chrome.runtime.onInstalled ==========
//
// Confirm the call sits inside an onInstalled listener (not on
// module-level so it doesn't fire on every SW restart). We scan for the
// nearest chrome.runtime.onInstalled.addListener before the call.

{
  const callMarker = "chrome.runtime.setUninstallURL";
  const idx = src.indexOf(callMarker);
  const before = src.slice(0, idx);
  // The most recent chrome.runtime.onInstalled.addListener before idx
  // should be enclosing it.
  const lastOnInstalledIdx = before.lastIndexOf("chrome.runtime.onInstalled.addListener");
  assertTrue("5a) call appears inside an onInstalled listener (preceded by onInstalled.addListener)",
    lastOnInstalledIdx >= 0);
  // And the API is called exactly once (idempotent + simple to audit).
  const allCallHits = (src.match(/chrome\.runtime\.setUninstallURL\s*\(/g) || []).length;
  assertTrue("5b) chrome.runtime.setUninstallURL is called exactly once (idempotent)",
    allCallHits === 1);
}

// ===== 6. URL form is /forms.gle/<id>?v=<v>&locale=<loc> ===============
//
// Sanity-check the assembled URL shape with a focused regex.

assertTrue("6) assembled URL has shape: forms.gle/<id> + ?v= + &locale=",
  /forms\.gle\/qngTc41kCvNSZCCX7[^"']*\?v=[^"']*&locale=/.test(src) ||
  /forms\.gle\/qngTc41kCvNSZCCX7[\s\S]{0,400}\?v=[\s\S]{0,200}&locale=/.test(src));

process.stdout.write("\n");
console.log(`UNINSTALL URL: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
