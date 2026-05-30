/* CleanFeed v1.5.0-fix3 — blocker (id, mode) → CSS rule contract.
 *
 * v1.4.19 added per-blocker render modes (hide / blur / dim). Phase 2
 * extended thumbnails with grayscale + hover-blur. Phase 1 added the
 * health-log instrumentation. None of those changes touched
 * content/styles.css's mode-override rules — but a real-Chrome bug
 * report still landed claiming "Blur / Dim / Grayscale / Hover-only blur
 * produce no visible effect".
 *
 * Root cause (fix3): every mode rule in styles.css used
 * `display: revert !important` to undo the base hide's `display: none`.
 * For autonomous custom elements (<ytd-*-renderer>, <yt-*-renderer>,
 * <grid-shelf-view-model>), the HTML spec defines the user-agent default
 * as `display: inline`. So `revert` set inline → element collapsed
 * (block children of an inline parent don't render) → filter:blur /
 * opacity:0.15 had nothing visible to operate on. fix3 replaces every
 * `display: revert` with `display: block` so the element stays in
 * layout and the mode's filter/opacity is actually visible.
 *
 * This suite is the regression sentinel that locks the contract:
 *
 *   1. For each non-jsHandler blocker × {blur, dim} (and thumbnails +
 *      {grayscale, hover-blur}), styles.css MUST contain a rule selector
 *      matching `body.cf-block-<id>.cf-mode-<id>-<mode>`.
 *   2. The matching rule body MUST NOT contain `display: revert` (the
 *      bug we just fixed).
 *   3. The matching rule body MUST contain `display: block` OR omit
 *      `display:` entirely OR target a CSS property that doesn't conflict
 *      with the base hide (e.g. thumbnails' rule uses `opacity:` since
 *      the base also uses opacity, not display).
 *   4. The mode rule body MUST contain at least one of: `filter:`,
 *      `opacity:`, `display:` — otherwise it's a no-op rule that
 *      provides no visual indication of the mode.
 *   5. _ALL_MODES in content.js MUST include every mode value that
 *      appears in styles.css (so the applyBlockers tear-down loop
 *      cleans up every possible class).
 *
 * Run with:  node tests/blocker-mode-application.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

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

const REPO = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(REPO, "content/styles.css"), "utf8");
const contentJs = fs.readFileSync(path.join(REPO, "content/content.js"), "utf8");
const popupJs = fs.readFileSync(path.join(REPO, "popup/popup.js"), "utf8");

// The 17 blockers (sourced from popup.js BLOCKERS) + their mode allowlists.
// Mirrors _BLOCKER_MODE_OPTIONS in popup.js.
const BLOCKER_MODES = {
  "home-feed":          ["blur", "dim"],
  "shorts":             ["blur", "dim"],
  "watch-sidebar":      ["blur", "dim"],
  "end-screen":         ["blur", "dim"],
  "comments":           ["blur", "dim"],
  "explore":            ["blur", "dim"],
  "live-chat":          ["blur", "dim"],
  "autoplay":           [],            // JS-only; no DOM mode
  "thumbnails":         ["blur", "dim", "grayscale", "hover-blur"],
  "subs-algo":          ["blur", "dim"],
  "playables":          ["blur", "dim"],
  "merch-shelf":        ["blur", "dim"],
  "breaking-news":      ["blur", "dim"],
  "mixes-playlists":    ["blur", "dim"],
  "subs-most-relevant": ["blur", "dim"],
  "subs-members-only":  ["blur", "dim"],
  "subs-watched":       ["blur", "dim"],
};

// ----- helpers -----------------------------------------------------------

// Find every rule body in styles.css whose selector mentions the given
// compound class `body.cf-block-<id>.cf-mode-<id>-<mode>`. Returns an
// array of rule-body strings (text between { and the matching }).
function findRuleBodies(blockerId, mode) {
  const marker = `body.cf-block-${blockerId}.cf-mode-${blockerId}-${mode}`;
  const out = [];
  let from = 0;
  while (true) {
    const idx = css.indexOf(marker, from);
    if (idx < 0) break;
    // Walk forward to find the rule's `{`. The selector list may span
    // multiple lines — scan from `idx` for the next unbalanced `{`.
    let openIdx = css.indexOf("{", idx);
    if (openIdx < 0) break;
    // Walk forward from openIdx to matching `}`.
    let depth = 1;
    let i = openIdx + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    out.push(css.slice(openIdx + 1, i - 1));
    from = i;
  }
  return out;
}

// ===== 1. Every (blocker, mode) has a CSS rule ==========================

let combosChecked = 0;
for (const id of Object.keys(BLOCKER_MODES)) {
  for (const mode of BLOCKER_MODES[id]) {
    const bodies = findRuleBodies(id, mode);
    assertTrue(`1.${id}.${mode}) styles.css contains rule for body.cf-block-${id}.cf-mode-${id}-${mode}`,
      bodies.length > 0);
    combosChecked++;
  }
}
// 16 non-autoplay blockers; thumbnails has 4 modes, the other 15 have 2 each.
assertEq("1.total) checked combos (excluding autoplay/JS-only)",
  combosChecked, 4 + (15 * 2));

// ===== 2. NO mode rule body contains the broken `display: revert` ======
//
// The exact v1.5.0-fix3 regression sentinel. If a future styles.css
// edit reintroduces `display: revert` in any mode override, this fires.

let revertHits = 0;
for (const id of Object.keys(BLOCKER_MODES)) {
  for (const mode of BLOCKER_MODES[id]) {
    const bodies = findRuleBodies(id, mode);
    for (const body of bodies) {
      if (/display:\s*revert/i.test(body)) {
        revertHits++;
        console.error(`\n  FAIL 2.${id}.${mode}) rule body contains "display: revert" (broken — collapses custom elements to invisible):\n    ${body.replace(/\s+/g, " ").trim().slice(0, 120)}`);
        fail++;
      } else {
        pass++; process.stdout.write(".");
      }
    }
  }
}

// ===== 3. Mode rule body MUST contain something that VISIBLY changes ==
//
// At least one of: filter:, opacity:, display: block. A rule body with
// only `pointer-events: none` and no visual change would silently do
// nothing visible to the user.

for (const id of Object.keys(BLOCKER_MODES)) {
  for (const mode of BLOCKER_MODES[id]) {
    const bodies = findRuleBodies(id, mode);
    // At LEAST ONE rule body must have visible effect — other rule bodies
    // for the same (id, mode) compound class are allowed to be hover-clear
    // rules (`filter: none`), ::after disposal, etc.
    const anyVisible = bodies.some((body) => {
      const hasFilter  = /filter:\s*\S/i.test(body);
      const hasOpacity = /opacity:\s*\S/i.test(body);
      const hasDisplay = /display:\s*(block|grid|flex|inline-block)/i.test(body);
      return hasFilter || hasOpacity || hasDisplay;
    });
    assertTrue(`3.${id}.${mode}) at least one rule body has filter / opacity / display (visible effect)`,
      anyVisible);
  }
}

// ===== 4. content.js _ALL_MODES enumerates every mode used in CSS =====
//
// applyBlockers tears down stale mode classes via the _ALL_MODES list.
// If styles.css references a mode that _ALL_MODES doesn't know about,
// switching out of that mode would leave the class on body and the
// CSS rule would keep firing.

const allModesMatch = contentJs.match(/_ALL_MODES\s*=\s*\[([^\]]*)\]/);
assertTrue("4a) _ALL_MODES is defined in content.js",
  !!allModesMatch);
if (allModesMatch) {
  const allModes = allModesMatch[1].match(/"([^"]+)"/g).map((s) => s.replace(/"/g, ""));
  // Collect every mode value that appears in cf-mode-<id>-<mode> in CSS.
  const cssModes = new Set();
  const rx = /cf-mode-[a-z0-9-]+-(hide|blur|dim|grayscale|hover-blur|[a-z0-9-]+)/g;
  let m;
  while ((m = rx.exec(css)) !== null) cssModes.add(m[1]);
  for (const mode of cssModes) {
    assertTrue(`4.${mode}) _ALL_MODES includes "${mode}" (so applyBlockers tear-down cleans it)`,
      allModes.indexOf(mode) >= 0);
  }
}

// ===== 5. Popup _BLOCKER_MODE_OPTIONS matches BLOCKER_MODES table ======
//
// The popup dropdown options MUST be a superset of the modes that
// styles.css supports. If popup offers a mode that styles.css can't
// render, picking it silently does nothing.

const popupTableMatch = popupJs.match(/_BLOCKER_MODE_OPTIONS\s*=\s*\{([\s\S]*?)\n\};/);
assertTrue("5a) _BLOCKER_MODE_OPTIONS is defined in popup.js",
  !!popupTableMatch);
if (popupTableMatch) {
  // Crude parse: for each `<id>: [ {v: "<mode>", ... } ... ]` entry,
  // extract the mode values.
  const tbl = popupTableMatch[1];
  const popupModes = {};
  // Split on top-level keys.
  const entryRx = /([\w_-]+|"[\w_-]+"):\s*\[([\s\S]*?)\],?/g;
  let em;
  while ((em = entryRx.exec(tbl)) !== null) {
    const key = em[1].replace(/"/g, "");
    const modes = (em[2].match(/v:\s*"([^"]+)"/g) || []).map((s) => s.replace(/v:\s*"([^"]+)"/, "$1"));
    popupModes[key] = modes;
  }
  // popupModes._core = ["hide","blur","dim"]
  // popupModes.thumbnails = [...5...]
  // All other blockers use _core (resolved at render time in popup.js).
  assertTrue("5b) popup._core has hide/blur/dim",
    JSON.stringify(popupModes._core) === '["hide","blur","dim"]');
  assertTrue("5c) popup.thumbnails has all 5 modes",
    JSON.stringify(popupModes.thumbnails || []) === '["hide","blur","dim","grayscale","hover-blur"]');
}

// ===== 6. Thumbnails rules use opacity (not display:none) — sanity ====
//
// The thumbnails base rule uses `opacity: 0` to hide. Its mode overrides
// therefore need to set `opacity: 1` (not `display: block`). Verify the
// architecture is consistent.

// At least one body for thumbnails.blur should set opacity:1 + filter:blur
// (undoes base opacity:0 + applies the blur). Other bodies for the same
// compound class may be :hover variants that clear the filter.
const thumbBlurBodies = findRuleBodies("thumbnails", "blur");
assertTrue("6.thumbnails.blur) at least one body sets opacity:1 + filter:blur",
  thumbBlurBodies.some((b) => /opacity:\s*1/.test(b) && /filter:\s*blur/.test(b)));
const thumbGrayscaleBodies = findRuleBodies("thumbnails", "grayscale");
assertTrue("6.thumbnails.grayscale) at least one body sets opacity:1 + filter:grayscale",
  thumbGrayscaleBodies.some((b) => /opacity:\s*1/.test(b) && /filter:\s*grayscale/.test(b)));

// ===== 7. Hide mode requires NO mode-specific rule (base handles it) =
//
// "hide" is the default mode. The base rule (body.cf-block-X without
// cf-mode-X-* tagged on) already sets display:none / opacity:0. There
// SHOULD NOT be a body.cf-block-X.cf-mode-X-hide rule — that would be
// redundant and confusing.

for (const id of Object.keys(BLOCKER_MODES)) {
  const bodies = findRuleBodies(id, "hide");
  assertEq(`7.${id}) no explicit cf-mode-${id}-hide rule (hide is base default)`,
    bodies.length, 0);
}

process.stdout.write("\n");
console.log(`BLOCKER MODE APPLICATION: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
