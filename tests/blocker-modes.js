/* CleanFeed soft-blur / dim render modes per blocker (v1.4.19 F3).
 *
 * Each blocker has a render mode persisted in chrome.storage.local under
 * settings.blockerModes (e.g. { "home-feed": "blur" }). Defaults to "hide"
 * for any blocker the user has not touched — preserves prior behaviour for
 * existing users.
 *
 * Invariants:
 *   • Default mode for any blocker == "hide" (zero behavior change).
 *   • "blur" and "dim" are the only other valid values.
 *   • Garbage values (typo, null, undefined, true) fall back to "hide".
 *   • Setting a mode persists into blockerModes; setting back to "hide"
 *     removes the entry (keeps storage object small).
 *   • Body class composition: cf-block-{id} + cf-mode-{id}-{mode}.
 *   • Show-comments inline reveal must clear inline filter/opacity so a
 *     blurred Comments blocker still reveals cleanly on click.
 *
 * Run with:  node tests/blocker-modes.js
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

// ----- helpers (mirror content/content.js + popup/popup.js) -------------
function effectiveMode(modes, id) {
  const m = modes && modes[id];
  return (m === "blur" || m === "dim") ? m : "hide";
}
async function writeMode(STATE, id, mode) {
  const next = Object.assign({}, STATE.blockerModes || {});
  if (mode === "hide") delete next[id];
  else                 next[id] = mode;
  STATE.blockerModes = next;
}
// Mirror of applyBlockers body-class composition. Returns the set of
// classes that would be applied for the given active blockers.
function composeBodyClasses(activeIds, modes) {
  const set = new Set();
  for (const id of activeIds) {
    set.add("cf-block-" + id);
    set.add("cf-mode-" + id + "-" + effectiveMode(modes, id));
  }
  return set;
}

// ===== 1. Default mode resolution =====
assertEq("default: unmigrated storage -> hide", effectiveMode({}, "home-feed"), "hide");
assertEq("default: undefined modes -> hide",    effectiveMode(undefined, "home-feed"), "hide");
assertEq("default: null modes -> hide",         effectiveMode(null, "home-feed"), "hide");
assertEq("default: missing id -> hide",         effectiveMode({ "shorts": "blur" }, "home-feed"), "hide");

// ===== 2. Valid mode values =====
assertEq("valid: blur", effectiveMode({ "home-feed": "blur" }, "home-feed"), "blur");
assertEq("valid: dim",  effectiveMode({ "home-feed": "dim"  }, "home-feed"), "dim");
assertEq("valid: hide explicitly", effectiveMode({ "home-feed": "hide" }, "home-feed"), "hide");

// ===== 3. Garbage values fall back to "hide" =====
assertEq("garbage: typo 'bluur' -> hide",   effectiveMode({ "home-feed": "bluur"   }, "home-feed"), "hide");
assertEq("garbage: 'BLUR' caps -> hide",    effectiveMode({ "home-feed": "BLUR"    }, "home-feed"), "hide");
assertEq("garbage: '' empty -> hide",       effectiveMode({ "home-feed": ""        }, "home-feed"), "hide");
assertEq("garbage: null per id -> hide",    effectiveMode({ "home-feed": null      }, "home-feed"), "hide");
assertEq("garbage: number 1 -> hide",       effectiveMode({ "home-feed": 1         }, "home-feed"), "hide");
assertEq("garbage: boolean true -> hide",   effectiveMode({ "home-feed": true      }, "home-feed"), "hide");

// ===== 4. Storage object shape — hide is the absent-value default =====
(async () => {
  const STATE = { blockerModes: {} };
  await writeMode(STATE, "home-feed", "blur");
  assertEq("write blur persists",       STATE.blockerModes, { "home-feed": "blur" });
  await writeMode(STATE, "shorts", "dim");
  assertEq("write dim persists alongside",
    STATE.blockerModes, { "home-feed": "blur", "shorts": "dim" });
  // Setting back to "hide" deletes the entry — default is implicit.
  await writeMode(STATE, "home-feed", "hide");
  assertEq("write hide removes key",    STATE.blockerModes, { "shorts": "dim" });
  await writeMode(STATE, "shorts", "hide");
  assertEq("write hide on last key -> empty",
    STATE.blockerModes, {});

  // ===== 5. Body-class composition for active blockers =====
  {
    const classes = composeBodyClasses(["home-feed"], { "home-feed": "blur" });
    assertEq("compose: blur mode -> two classes",
      Array.from(classes).sort(),
      ["cf-block-home-feed", "cf-mode-home-feed-blur"]);
  }
  {
    const classes = composeBodyClasses(["home-feed", "shorts"], { "home-feed": "blur", "shorts": "dim" });
    assertEq("compose: two blockers, different modes",
      Array.from(classes).sort(),
      ["cf-block-home-feed", "cf-block-shorts", "cf-mode-home-feed-blur", "cf-mode-shorts-dim"]);
  }
  {
    // Default mode for an untouched blocker still emits cf-mode-*-hide.
    const classes = composeBodyClasses(["comments"], {});
    assertEq("compose: untouched blocker still emits hide mode class",
      Array.from(classes).sort(),
      ["cf-block-comments", "cf-mode-comments-hide"]);
  }

  // ===== 6. Show-comments inline reveal contract (v1.4.15 + v1.4.19) =====
  // applyCommentsManualReveal must set display, filter, opacity, pointer-
  // events all to safe values so a blurred Comments blocker reveals
  // cleanly when the user clicks "Show comments". Mirror the inline-style
  // writer from content/content.js.
  function makeEl() {
    const props = {}, imp = {};
    return {
      style: {
        setProperty(n, v, p) { props[n] = v; imp[n] = p === "important"; },
        removeProperty(n)    { delete props[n]; delete imp[n]; },
        getPropertyValue(n)  { return props[n] || ""; },
        getPropertyPriority(n) { return imp[n] ? "important" : ""; },
      },
      dataset: {},
      setAttribute(n, v) { if (n === "data-cf-shown") this.dataset.cfShown = v; },
      removeAttribute(n) { if (n === "data-cf-shown") delete this.dataset.cfShown; },
    };
  }
  function applyReveal(el) {
    el.style.setProperty("display", "block", "important");
    el.style.setProperty("filter", "none", "important");
    el.style.setProperty("opacity", "1", "important");
    el.style.setProperty("pointer-events", "auto", "important");
    el.setAttribute("data-cf-shown", "1");
  }
  function clearReveal(el) {
    if (el.dataset.cfShown !== "1") return;
    el.style.removeProperty("display");
    el.style.removeProperty("filter");
    el.style.removeProperty("opacity");
    el.style.removeProperty("pointer-events");
    el.removeAttribute("data-cf-shown");
  }
  {
    const el = makeEl();
    applyReveal(el);
    assertEq("reveal sets display block !important", el.style.getPropertyValue("display"), "block");
    assertEq("reveal display is !important",        el.style.getPropertyPriority("display"), "important");
    assertEq("reveal clears filter to none",        el.style.getPropertyValue("filter"), "none");
    assertEq("reveal filter is !important",         el.style.getPropertyPriority("filter"), "important");
    assertEq("reveal sets opacity 1",               el.style.getPropertyValue("opacity"), "1");
    assertEq("reveal sets pointer-events auto",     el.style.getPropertyValue("pointer-events"), "auto");
    assertEq("reveal tags element",                 el.dataset.cfShown, "1");
    clearReveal(el);
    assertEq("clear removes display",        el.style.getPropertyValue("display"), "");
    assertEq("clear removes filter",         el.style.getPropertyValue("filter"), "");
    assertEq("clear removes opacity",        el.style.getPropertyValue("opacity"), "");
    assertEq("clear removes pointer-events", el.style.getPropertyValue("pointer-events"), "");
    assertEq("clear removes dataset tag",    el.dataset.cfShown, undefined);
  }

  process.stdout.write("\n");
  console.log(`BLOCKER MODES: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
})();
