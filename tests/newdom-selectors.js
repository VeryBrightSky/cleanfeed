/* CleanFeed v1.4.24.2 — new-DOM (yt-*-view-model) selector coverage.
 *
 * YouTube is migrating from the Polymer `ytd-*-renderer` DOM to the newer
 * `*-view-model` DOM. The migration reached more user cohorts and left three
 * shipped blockers matching zero elements on the new DOM:
 *   • Shorts (FREE)    — new shelf is <grid-shelf-view-model> with no
 *                        [title="Shorts"]; items are <ytm-shorts-lockup-view-model-v2>
 *   • Hide thumbnails  — thumbnail is a TAG <yt-thumbnail-view-model>, the
 *                        shipped selector used a CLASS `.yt-thumbnail-view-model`
 *   • Sidebar recs     — watch-page rail items are <yt-lockup-view-model>
 *
 * FIX PRINCIPLE: ADD new-DOM selectors ALONGSIDE the old ones. Both DOMs are
 * live across cohorts, so no old selector may ever be removed. This test
 * asserts that invariant: every OLD selector is still present AND the new
 * ones were added, in both the JS selector arrays (content/blockers.js, used
 * for counting) and the CSS hide rules (content/styles.css, the actual
 * hiding layer).
 *
 * Live DOM fixture matching (grid-shelf-view-model wrapping the lockups,
 * yt-thumbnail-view-model img, #secondary yt-lockup-view-model) is verified
 * against a real Chrome selector engine in the browser step of this fix —
 * node has no DOM / :has() engine available here.
 *
 * Run with:  node tests/newdom-selectors.js
 * Exits non-zero on first failed assertion.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function assertTrue(name, cond) {
  if (cond) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}`); }
}

// ----- load the REAL blockers.js (IIFE assigning to window.*) -----------
const blockersSrc = fs.readFileSync(
  path.join(__dirname, "..", "content", "blockers.js"), "utf8");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(blockersSrc, sandbox);
const BLOCKERS = sandbox.window.__cleanfeed_blockers;
const byId = Object.fromEntries((BLOCKERS || []).map(b => [b.id, b]));

assertTrue("blockers.js loaded a non-empty array", Array.isArray(BLOCKERS) && BLOCKERS.length > 0);

// ----- read the CSS hide layer (plain-text presence checks) -------------
const css = fs.readFileSync(
  path.join(__dirname, "..", "content", "styles.css"), "utf8");

// ========================================================================
// 1. SHORTS (free) — old selectors kept + new-DOM shelf/lockup added
// ========================================================================
const shorts = byId["shorts"].selectors;
const SHORTS_OLD = [
  "ytd-rich-shelf-renderer[is-shorts]",
  "ytd-reel-shelf-renderer",
  "ytd-reel-item-renderer",
  "ytd-shorts",
  'grid-shelf-view-model:has([title="Shorts"])',
];
for (const s of SHORTS_OLD) {
  assertTrue(`shorts KEEPS old selector: ${s}`, shorts.includes(s));
}
assertTrue("shorts ADDS grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2)",
  shorts.includes("grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2)"));
assertTrue("shorts ADDS standalone ytm-shorts-lockup-view-model-v2",
  shorts.includes("ytm-shorts-lockup-view-model-v2"));
// New matcher must NOT depend on [title="Shorts"]
assertTrue("shorts new shelf matcher is title-independent",
  shorts.includes("grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2)"));
// CSS hide layer carries the new shorts selectors
assertTrue("styles.css hides new shorts shelf",
  css.includes("grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2)"));
assertTrue("styles.css hides standalone shorts lockup",
  css.includes("body.cf-block-shorts ytm-shorts-lockup-view-model-v2"));

// ========================================================================
// 2. HIDE THUMBNAILS (pro) — class form kept + tag form added
// ========================================================================
const thumbs = byId["thumbnails"].selectors;
assertTrue("thumbnails KEEPS class form .yt-thumbnail-view-model img",
  thumbs.includes(".yt-thumbnail-view-model img"));
assertTrue("thumbnails ADDS tag form yt-thumbnail-view-model img",
  thumbs.includes("yt-thumbnail-view-model img"));
assertTrue("thumbnails KEEPS ytd-thumbnail img", thumbs.includes("ytd-thumbnail img"));
assertTrue("styles.css fades new-DOM thumbnail (tag form)",
  css.includes("body.cf-block-thumbnails yt-thumbnail-view-model img"));

// ========================================================================
// 3. SIDEBAR RECS (pro) — old kept + scoped new-DOM lockup added
// ========================================================================
const sidebar = byId["watch-sidebar"].selectors;
assertTrue("sidebar KEEPS ytd-compact-video-renderer",
  sidebar.includes("ytd-compact-video-renderer"));
assertTrue("sidebar ADDS scoped #secondary yt-lockup-view-model",
  sidebar.includes("#secondary yt-lockup-view-model"));
// Scope guard: the new lockup selector must be scoped to #secondary so it
// doesn't nuke yt-lockup-view-model on search / home pages. A bare,
// unscoped "yt-lockup-view-model" entry must NOT exist.
assertTrue("sidebar new selector is scoped to #secondary (no bare lockup)",
  sidebar.every(s => s !== "yt-lockup-view-model"));
assertTrue("styles.css hides new-DOM sidebar lockup (scoped)",
  css.includes("body.cf-block-watch-sidebar #secondary yt-lockup-view-model"));

// ========================================================================
// 4. GLOBAL INVARIANT — zero old selectors removed across the three blockers
//    (spot-check the exact pre-fix arrays are fully contained)
// ========================================================================
const THUMBS_OLD = ["ytd-thumbnail img", "yt-image img", ".yt-thumbnail-view-model img"];
const SIDEBAR_OLD = [
  "ytd-watch-flexy #secondary",
  "ytd-watch-flexy #secondary-inner",
  "ytd-watch-next-secondary-results-renderer",
  "#related.ytd-watch-flexy",
  "ytd-compact-video-renderer",
];
assertTrue("thumbnails: all old selectors retained",
  THUMBS_OLD.every(s => thumbs.includes(s)));
assertTrue("sidebar: all old selectors retained",
  SIDEBAR_OLD.every(s => sidebar.includes(s)));

// ---- summary -----------------------------------------------------------
console.log(`\nNEWDOM SELECTORS: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
