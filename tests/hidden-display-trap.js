/* CleanFeed v1.4.24.7 — [hidden] vs author-display trap audit.
 *
 * THE TRAP: the UA stylesheet's `[hidden] { display: none }` loses to ANY
 * author-level display declaration (author origin beats UA origin regardless
 * of specificity). So an element toggled via `el.hidden = ...` whose class
 * sets `display: flex/grid/...` stays PAINTED while hidden=true. This bit
 * the focus banner (fixed v1.2.3), the paused banner (fixed v1.4.24.6), and
 * the schedule indicator (fixed v1.4.24.7).
 *
 * THE RULE THIS TEST ENFORCES: every element toggled through the hidden
 * attribute either (a) has no author display rule on its subject selector,
 * or (b) ships a `<subject>[hidden] { display: none }` guard.
 *
 * AUDIT[] below is the hand-audited inventory of hidden-toggled elements
 * (from `grep '\.hidden = ' popup/ options/ onboarding/ content/`). The
 * meta-checks at the bottom fail if a NEW `$("...").hidden` toggle appears
 * in the JS that isn't listed here — forcing this inventory (and therefore
 * the guard check) to stay current.
 *
 * Run with:  node tests/hidden-display-trap.js
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

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const SURFACES = {
  popup:   { html: read("popup/popup.html"),     js: read("popup/popup.js"),     css: read("popup/popup.css") },
  options: { html: read("options/options.html"), js: read("options/options.js"), css: read("options/options.css") },
};

// Hand-audited inventory: every element toggled via `.hidden = ` in JS.
// classes = the element's class list from its HTML tag ([] = bare element).
const AUDIT = [
  { surface: "popup",   id: "cf-paused-banner",    classes: ["cf-paused-banner"] },
  { surface: "popup",   id: "cf-focus-banner",     classes: ["cf-focus-banner"] },
  { surface: "popup",   id: "cf-today-bar",        classes: ["cf-today-bar"] },
  { surface: "popup",   id: "cf-streak-line",      classes: ["cf-streak-line"] },
  { surface: "popup",   id: "cf-week-stats",       classes: ["cf-week-stats"] },
  { surface: "popup",   id: "cf-sched-indicator",  classes: ["cf-sched-indicator"] },
  { surface: "popup",   id: "cf-upgrade-card",     classes: ["cf-upgrade"] },
  { surface: "popup",   id: "cf-modal",            classes: ["cf-modal"] },
  { surface: "options", id: "cf-license-form",     classes: [] },
  { surface: "options", id: "cf-license-active",   classes: [] },
  { surface: "options", id: "cf-sub-panel",        classes: ["cf-panel"] },
  { surface: "options", id: "cf-focus-pin-setup",  classes: ["cf-focus-section"] },
  { surface: "options", id: "cf-focus-controls",   classes: ["cf-focus-section"] },
  { surface: "options", id: "cf-focus-active",     classes: ["cf-focus-active"] },
  { surface: "options", id: "cf-pomo-cancel",      classes: ["cf-btn", "cf-btn-warn"] },
  { surface: "options", id: "cf-sched-modal",      classes: ["cf-modal"] },
];

// ---- tiny CSS reader ------------------------------------------------------
// Flat rule extraction; rules inside @media blocks are still captured because
// the regex matches innermost `selector { decls }` pairs.
function parseRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const selectors = m[1].split(",").map((s) => s.trim()).filter(Boolean)
      .filter((s) => !s.startsWith("@"));   // drop @media/@keyframes headers
    if (selectors.length) rules.push({ selectors, decls: m[2] });
  }
  return rules;
}
// A selector styles the SUBJECT element itself (not a descendant/child and
// not a different compound) when it is exactly `.cls`/`#id`, optionally
// followed by pseudo-classes/elements — nothing else.
function isSubject(sel, base) {
  if (sel === base) return true;
  return sel.startsWith(base) && /^::?[a-zA-Z-]/.test(sel.slice(base.length));
}
function declaresDisplay(decls) {
  return /(^|[;\s])display\s*:/.test(decls);
}
// Author display rules on the element (excluding its own [hidden] guard).
function subjectDisplayRules(rules, bases) {
  return rules.filter((r) =>
    r.selectors.some((s) => bases.some((b) => isSubject(s, b))) &&
    declaresDisplay(r.decls));
}
// A guard: `<base>[hidden]` selector whose decls set display: none.
function hasHiddenGuard(rules, bases) {
  return rules.some((r) =>
    r.selectors.some((s) => bases.some((b) => s === `${b}[hidden]`)) &&
    /display\s*:\s*none/.test(r.decls));
}

// ---- 1. the audit rule: display-on-subject ⇒ [hidden] guard --------------
for (const entry of AUDIT) {
  const S = SURFACES[entry.surface];
  const rules = parseRules(S.css);
  const bases = entry.classes.map((c) => `.${c}`).concat([`#${entry.id}`]);

  assertTrue(`${entry.surface}: #${entry.id} exists in HTML`,
    S.html.includes(`id="${entry.id}"`));

  const displayRules = subjectDisplayRules(rules, bases);
  if (displayRules.length > 0) {
    assertTrue(
      `${entry.surface}: #${entry.id} sets author display — [hidden] guard REQUIRED`,
      hasHiddenGuard(rules, bases));
  } else {
    // No author display on the subject: UA [hidden] works. Nothing to guard.
    assertTrue(`${entry.surface}: #${entry.id} has no author display (UA [hidden] suffices)`, true);
  }
}

// The three known traps must be guarded explicitly (regression pins).
{
  const pcss = SURFACES.popup.css;
  assertTrue("pin: .cf-sched-indicator[hidden] guard shipped (v1.4.24.7)",
    pcss.includes(".cf-sched-indicator[hidden] { display: none !important; }"));
  assertTrue("pin: .cf-paused-banner[hidden] guard shipped (v1.4.24.6)",
    pcss.includes(".cf-paused-banner[hidden] { display: none !important; }"));
  assertTrue("pin: .cf-focus-banner[hidden] guard shipped (v1.2.3)",
    pcss.includes(".cf-focus-banner[hidden] { display: none !important; }"));
}

// ---- 2. meta-check: the inventory can't silently go stale ----------------
// Every direct `$("<id>").hidden = ` toggle in the JS must be in AUDIT.
// (Variable-held hosts are toggled as `host.hidden = ...`; those ids reach
// the JS via `$("<id>")` too, so we ALSO require every audited id to appear
// in its surface's JS — catching renames/removals in the other direction.)
for (const [surface, S] of Object.entries(SURFACES)) {
  const direct = new Set();
  const re = /\$\("([^"]+)"\)\s*\.hidden\s*=/g;
  let m;
  while ((m = re.exec(S.js)) !== null) direct.add(m[1]);
  const audited = new Set(AUDIT.filter((e) => e.surface === surface).map((e) => e.id));
  for (const id of direct) {
    assertTrue(`meta: ${surface} direct toggle #${id} is in the audit inventory`,
      audited.has(id));
  }
  for (const id of audited) {
    assertTrue(`meta: audited #${id} still referenced in ${surface} JS`,
      S.js.includes(`$("${id}")`));
  }
}

// content/ and onboarding/ have no hidden-attribute toggles at all (the
// pause pill self-removes; onboarding uses full-page views).
{
  const contentJs = read("content/content.js");
  assertTrue("content.js has no hidden-attribute toggles",
    !/\.hidden\s*=\s*(true|false|!)/.test(contentJs));
  const obDir = path.join(ROOT, "onboarding");
  const obJs = fs.readdirSync(obDir).filter((f) => f.endsWith(".js"))
    .map((f) => read(path.join("onboarding", f))).join("\n");
  assertTrue("onboarding JS has no hidden-attribute toggles",
    !/\.hidden\s*=\s*(true|false|!)/.test(obJs));
}

console.log(`\nHIDDEN DISPLAY TRAP: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
