/* CleanFeed v1.5.0 phase 2 — thumbnail-blocker render-mode variants.
 *
 * v1.4.19 introduced per-blocker hide/blur/dim modes. v1.5.0 phase 2
 * extends the thumbnails blocker (and only that one) with two more:
 *   - "grayscale"  — filter: grayscale(100%)
 *   - "hover-blur" — blur until :hover
 *
 * Mirror of:
 *   content/content.js _effectiveModeFor  (mode validation per blocker)
 *   popup/popup.js     _BLOCKER_MODE_OPTIONS  (dropdown options per blocker)
 *
 * Asserts:
 *   1. _effectiveModeFor("thumbnails", "<v>") allows the five-mode allowlist,
 *      coerces unknown values to "hide".
 *   2. _effectiveModeFor("home-feed", "grayscale") returns "hide" — non-
 *      thumbnails blockers stay restricted to the original trio.
 *   3. applyBlockers' tear-down loop wipes ALL five mode classes before
 *      re-applying the chosen one, so switching grayscale → hover-blur
 *      doesn't leave a stale grayscale class on body.
 *   4. _BLOCKER_MODE_OPTIONS.thumbnails has exactly 5 options in the
 *      order: hide, blur, dim, grayscale, hover-blur.
 *   5. _BLOCKER_MODE_OPTIONS._core has exactly 3 options for every other
 *      blocker (regression sentinel — adding a 6th to thumbnails must
 *      not leak into the core list).
 *
 * Run with:  node tests/thumbnail-variants.js
 */
"use strict";

let pass = 0, fail = 0;
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}\n    expected: ${e}\n    actual:   ${a}`); }
}

// ---- mirrors of production helpers --------------------------------------

function _effectiveModeFor(id, m) {
  if (id === "thumbnails") {
    if (m === "blur" || m === "dim" || m === "grayscale" || m === "hover-blur") return m;
    return "hide";
  }
  return (m === "blur" || m === "dim") ? m : "hide";
}

const _ALL_MODES = ["hide", "blur", "dim", "grayscale", "hover-blur"];

const _BLOCKER_MODE_OPTIONS = {
  _core: [
    { v: "hide", label: "Hide" },
    { v: "blur", label: "Blur" },
    { v: "dim",  label: "Dim"  },
  ],
  thumbnails: [
    { v: "hide",       label: "Hide" },
    { v: "blur",       label: "Blur" },
    { v: "dim",        label: "Dim"  },
    { v: "grayscale",  label: "Grayscale" },
    { v: "hover-blur", label: "Hover-only blur" },
  ],
};

// ===== 1. _effectiveModeFor("thumbnails", x) — five-mode allowlist =====

assertEq("1a) thumbnails: hide stays hide",        _effectiveModeFor("thumbnails", "hide"),       "hide");
assertEq("1b) thumbnails: blur stays blur",        _effectiveModeFor("thumbnails", "blur"),       "blur");
assertEq("1c) thumbnails: dim stays dim",          _effectiveModeFor("thumbnails", "dim"),        "dim");
assertEq("1d) thumbnails: grayscale stays grayscale", _effectiveModeFor("thumbnails", "grayscale"), "grayscale");
assertEq("1e) thumbnails: hover-blur stays hover-blur", _effectiveModeFor("thumbnails", "hover-blur"), "hover-blur");
assertEq("1f) thumbnails: unknown coerces to hide", _effectiveModeFor("thumbnails", "rainbow"),    "hide");
assertEq("1g) thumbnails: undefined → hide",       _effectiveModeFor("thumbnails", undefined),    "hide");
assertEq("1h) thumbnails: empty string → hide",    _effectiveModeFor("thumbnails", ""),           "hide");

// ===== 2. Other blockers stay restricted to hide/blur/dim ===============

for (const id of ["home-feed", "shorts", "watch-sidebar", "end-screen", "comments",
                  "explore", "live-chat", "thumbnails", "subs-algo"]) {
  if (id === "thumbnails") continue;
  assertEq(`2.${id}.grayscale) ${id}: grayscale coerces to hide`,
    _effectiveModeFor(id, "grayscale"), "hide");
  assertEq(`2.${id}.hover-blur) ${id}: hover-blur coerces to hide`,
    _effectiveModeFor(id, "hover-blur"), "hide");
}

// ===== 3. _ALL_MODES iterates every class we might apply or remove ======

assertEq("3a) _ALL_MODES has exactly five entries",  _ALL_MODES.length, 5);
assertEq("3b) _ALL_MODES order: hide, blur, dim, grayscale, hover-blur",
  _ALL_MODES, ["hide", "blur", "dim", "grayscale", "hover-blur"]);

// ===== 4. applyBlockers tear-down — simulated body classList ============
//
// applyBlockers' first loop calls classList.remove() for every mode-class
// for every blocker. We simulate that pattern against a stub classList
// to confirm that switching grayscale → hover-blur leaves no stale class.

function makeClassList() {
  const set = new Set();
  return {
    add(c)    { set.add(c); },
    remove(c) { set.delete(c); },
    contains(c) { return set.has(c); },
    toArray() { return Array.from(set).sort(); },
    _set: set,
  };
}

{
  const body = makeClassList();
  // Simulate prior tick: thumbnails active with grayscale.
  body.add("cf-block-thumbnails");
  body.add("cf-mode-thumbnails-grayscale");
  // applyBlockers tear-down — remove EVERY mode class for this blocker.
  for (const m of _ALL_MODES) {
    body.remove("cf-mode-thumbnails-" + m);
  }
  body.remove("cf-block-thumbnails");
  // Re-apply with hover-blur.
  body.add("cf-block-thumbnails");
  body.add("cf-mode-thumbnails-" + _effectiveModeFor("thumbnails", "hover-blur"));
  assertEq("4a) after grayscale→hover-blur, no stale grayscale class",
    body.contains("cf-mode-thumbnails-grayscale"), false);
  assertEq("4b) after grayscale→hover-blur, hover-blur class present",
    body.contains("cf-mode-thumbnails-hover-blur"), true);
  assertEq("4c) base cf-block-thumbnails class present",
    body.contains("cf-block-thumbnails"), true);
}

// And the reverse direction.
{
  const body = makeClassList();
  body.add("cf-block-thumbnails");
  body.add("cf-mode-thumbnails-hover-blur");
  for (const m of _ALL_MODES) body.remove("cf-mode-thumbnails-" + m);
  body.remove("cf-block-thumbnails");
  body.add("cf-block-thumbnails");
  body.add("cf-mode-thumbnails-" + _effectiveModeFor("thumbnails", "grayscale"));
  assertEq("4d) after hover-blur→grayscale, no stale hover-blur class",
    body.contains("cf-mode-thumbnails-hover-blur"), false);
  assertEq("4e) after hover-blur→grayscale, grayscale class present",
    body.contains("cf-mode-thumbnails-grayscale"), true);
}

// And from a v1.4.19 mode (blur) into a v1.5.0 mode (grayscale).
{
  const body = makeClassList();
  body.add("cf-block-thumbnails");
  body.add("cf-mode-thumbnails-blur");
  for (const m of _ALL_MODES) body.remove("cf-mode-thumbnails-" + m);
  body.remove("cf-block-thumbnails");
  body.add("cf-block-thumbnails");
  body.add("cf-mode-thumbnails-" + _effectiveModeFor("thumbnails", "grayscale"));
  assertEq("4f) blur → grayscale, no stale blur",
    body.contains("cf-mode-thumbnails-blur"), false);
  assertEq("4g) blur → grayscale, grayscale present",
    body.contains("cf-mode-thumbnails-grayscale"), true);
}

// ===== 5. Dropdown options per blocker ==================================

assertEq("5a) _BLOCKER_MODE_OPTIONS.thumbnails has 5 options",
  _BLOCKER_MODE_OPTIONS.thumbnails.length, 5);
assertEq("5b) thumbnails option order",
  _BLOCKER_MODE_OPTIONS.thumbnails.map((o) => o.v),
  ["hide", "blur", "dim", "grayscale", "hover-blur"]);
assertEq("5c) _BLOCKER_MODE_OPTIONS._core has 3 options",
  _BLOCKER_MODE_OPTIONS._core.length, 3);
assertEq("5d) core order: hide, blur, dim",
  _BLOCKER_MODE_OPTIONS._core.map((o) => o.v),
  ["hide", "blur", "dim"]);

// ===== 6. Storage round-trip: legacy blockerModes shape unchanged ======
//
// v1.4.19's storage shape was { [blockerId]: "hide"|"blur"|"dim" }.
// v1.5.0 phase 2 only extends the value side for the thumbnails entry —
// no shape change. A migration sentinel: a v1.4.19 user with
// blockerModes={thumbnails:"blur"} should still resolve to "blur".

{
  const legacy = { thumbnails: "blur" };
  assertEq("6) v1.4.19 blockerModes shape still resolves",
    _effectiveModeFor("thumbnails", legacy.thumbnails), "blur");
}

process.stdout.write("\n");
console.log(`THUMBNAIL VARIANTS: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
