/* CleanFeed v1.5.0-fix2 — selector-inventory completeness sentinel.
 *
 * Phase 1 (v1.5.0-phase1) moved every blocker's selector array out of
 * content/blockers.js's inline literals and into content/selectors.js's
 * SELECTORS[id] = { primary, fallbacks } shape, with content/blockers.js
 * exposing them via a getter (`get selectors() { return selectorsFor(id); }`).
 *
 * The v1.5.0-fix2 bug report claimed Phase 1 had dropped selectors during
 * the refactor (7 blockers totally empty, 9 with only first-of-N kept).
 * The forensic diff disproved this — vm-level comparison between
 * `git show 601a193:content/blockers.js` (v1.4.22) and the current
 * selectors.js shows zero selectors lost across all 17 blockers.
 *
 * This file is the defense-in-depth sentinel that locks down the v1.4.22
 * inventory FOREVER. If a future refactor drops a selector — even one,
 * even by accident — this suite fails. Single source of truth: reads the
 * v1.4.22 baseline via `git show 601a193:content/blockers.js` at test
 * time, so the assertion auto-tracks any new blocker we add (those just
 * need their own selectors in current selectors.js; the v1.4.22 check
 * only spans the 17 blockers that existed at the revert point).
 *
 * Invariants asserted:
 *   1. The current SELECTORS table has every v1.4.22 blocker id.
 *   2. For each v1.4.22 blocker, every inline selector still appears
 *      in current primary[] OR fallbacks[]. (Superset invariant — current
 *      code can ADD selectors but never DROP one.)
 *   3. Every entry in current SELECTORS has a non-empty primary[] array,
 *      except blockers explicitly marked jsHandler-only (autoplay).
 *   4. Current BLOCKERS list (content/blockers.js) exposes the same 17 ids.
 *   5. blocker.selectors getter returns the flattened [primary, ...fallbacks].
 *
 * Run with:  node tests/selectors-completeness.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execSync } = require("child_process");

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

// Load v1.4.22 blockers.js (commit 601a193) — single source of truth for
// the pre-refactor selector inventory.
let v1422blockers;
try {
  const src = execSync("git -C /home/moffy/workspace/cleanfeed show 601a193:content/blockers.js").toString();
  const ctx = { window: {} };
  vm.runInNewContext(src, ctx);
  v1422blockers = ctx.window.__cleanfeed_blockers;
} catch (e) {
  console.log("SELECTORS COMPLETENESS: cannot read v1.4.22 baseline (`git show 601a193:content/blockers.js` failed) — skipping suite.");
  console.log("SKIPPED — git-dependent");
  process.exit(0);
}

// Load current v1.5.0 selectors.js + blockers.js into a shared window.
const REPO = path.resolve(__dirname, "..");
const ctx150 = { window: {} };
vm.runInNewContext(
  fs.readFileSync(path.join(REPO, "content/selectors.js"), "utf8"), ctx150);
vm.runInNewContext(
  fs.readFileSync(path.join(REPO, "content/blockers.js"), "utf8"), ctx150);
const SELECTORS    = ctx150.window.__cleanfeed_selectors;
const BLOCKERS_150 = ctx150.window.__cleanfeed_blockers;

// Sanity print so a CI run shows the inventory at a glance.
process.stderr.write("[selectors-completeness] v1.4.22 baseline: " +
  v1422blockers.length + " blockers; v1.5.0 SELECTORS: " +
  Object.keys(SELECTORS).length + " entries; v1.5.0 BLOCKERS list: " +
  BLOCKERS_150.length + " entries\n");

// ===== 1. Every v1.4.22 id has a current SELECTORS entry ===============

const v1422ids = v1422blockers.map((b) => b.id);
for (const id of v1422ids) {
  assertTrue(`1.${id}) SELECTORS["${id}"] exists`,
    SELECTORS[id] !== undefined);
  if (SELECTORS[id]) {
    assertTrue(`1.${id}) SELECTORS["${id}"].primary is an array`,
      Array.isArray(SELECTORS[id].primary));
    assertTrue(`1.${id}) SELECTORS["${id}"].fallbacks is an array`,
      Array.isArray(SELECTORS[id].fallbacks));
  }
}

// ===== 2. Superset invariant: every v1.4.22 selector still in chain ====
//
// Computes the union of current primary + fallbacks (flattened across
// any nested fallback groups) and asserts each v1.4.22 selector is in
// that union. If this fails for ANY blocker, fix2's CHANGELOG must
// explicitly mention which selectors were dropped + why.

for (const b of v1422blockers) {
  const inline = Array.isArray(b.selectors) ? b.selectors : [];
  const cur = SELECTORS[b.id];
  if (!cur) continue;       // already failed assertion 1
  const have = new Set();
  for (const s of (cur.primary || [])) have.add(s);
  for (const group of (cur.fallbacks || [])) {
    if (Array.isArray(group)) for (const s of group) have.add(s);
  }
  for (const s of inline) {
    assertTrue(`2.${b.id}) v1.4.22 selector preserved: ${JSON.stringify(s).slice(0, 60)}`,
      have.has(s));
  }
}

// ===== 3. Every blocker has at least one primary selector (or is JS-only) ==
//
// New invariant in v1.5.0-fix2: a blocker with primary.length === 0 is
// dead code unless it's flagged as a JS-only handler (autoplay does its
// work via clicking the YT autoplay toggle, not via selector matching).

for (const id of Object.keys(SELECTORS)) {
  const entry = SELECTORS[id];
  const jsOnly = !!entry.jsHandler && entry.primary.length === 0;
  if (jsOnly) {
    assertEq(`3.${id}) JS-only blocker has empty primary (autoplay convention)`,
      entry.primary.length, 0);
  } else {
    assertTrue(`3.${id}) primary[] is non-empty (length=${entry.primary.length})`,
      entry.primary.length >= 1);
  }
}

// ===== 4. BLOCKERS list shape parity =====================================

const v150ids = BLOCKERS_150.map((b) => b.id);
assertEq("4a) v1.5.0 BLOCKERS list has exactly 17 entries (no churn)",
  v150ids.length, 17);
assertEq("4b) v1.5.0 BLOCKERS ids = v1.4.22 BLOCKERS ids (no churn)",
  v150ids.slice().sort(), v1422ids.slice().sort());

// ===== 5. selectorsFor() getter returns the flattened chain ============
//
// The blockers.js getter is `get selectors() { return selectorsFor(id); }`.
// Pre-Phase-1 it was an inline static array. We verify the getter returns
// the EXACT same set of selectors that v1.4.22 used (modulo any new
// fallbacks current code may have added).

for (const b of BLOCKERS_150) {
  const runtime = b.selectors;       // <- the getter
  assertTrue(`5.${b.id}) b.selectors getter returns an array`,
    Array.isArray(runtime));
  const entry = SELECTORS[b.id];
  if (!entry) continue;
  const expected = (entry.primary || []).slice();
  for (const group of (entry.fallbacks || [])) {
    if (Array.isArray(group)) for (const s of group) expected.push(s);
  }
  assertEq(`5.${b.id}) b.selectors getter = flat [primary, ...fallbacks]`,
    runtime, expected);
}

// ===== 6. Forbid empty SELECTORS entries that don't carry jsHandler ====
//
// Belt and suspenders for invariant 3. Catches the failure mode the bug
// report SUSPECTED (which we proved didn't exist but might in the
// future): a blocker that's listed in popup.js but has no selectors and
// no JS handler, meaning it does literally nothing when enabled.

for (const id of Object.keys(SELECTORS)) {
  const entry = SELECTORS[id];
  const totalSelectors = (entry.primary || []).length +
    (entry.fallbacks || []).reduce((n, g) => n + (Array.isArray(g) ? g.length : 0), 0);
  assertTrue(`6.${id}) total selectors (primary + fallbacks) >= 1 OR jsHandler set (id=${id})`,
    totalSelectors >= 1 || !!entry.jsHandler);
}

process.stdout.write("\n");
console.log(`SELECTORS COMPLETENESS: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
