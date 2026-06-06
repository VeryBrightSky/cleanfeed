/* CleanFeed v1.4.23 — locale-inventory completeness sentinel.
 *
 * v1.4.23 adds 7 new locales (vi / th / zh_CN / zh_TW / ko / nl / ar) to
 * the existing 12 (en, de, es, fr, hi, id, it, ja, pl, pt_BR, ru, tr),
 * bringing the total to 19. The new locales were auto-translated; their
 * pending native-speaker-review status is tracked in the root file
 * _locales/TRANSLATION_STATUS.md (not via an in-JSON key, which violated
 * Chrome's messages.json schema). This suite locks down the per-locale
 * inventory and enforces every constraint the Chrome Web Store imposes
 * on _locales/<code>/messages.json files.
 *
 * Invariants asserted (per spec):
 *   1. All 19 locales present (en + 11 existing + 7 new).
 *   2. Each locale's messages.json is valid JSON.
 *   3. Each locale contains every message key that en contains.
 *   4. Each locale's extName ≤ 75 chars.
 *   5. Each locale's extDescription ≤ 132 chars.
 *   6. For any en message containing $1 placeholder, the corresponding
 *      locale message also contains $1 (placeholder preservation).
 *   7. Every top-level key in every messages.json is an object carrying a
 *      string "message" field (strict Chrome schema; no scalar keys).
 *   8. _locales/TRANSLATION_STATUS.md exists at the _locales/ root and
 *      lists all 7 auto-translated locales.
 *
 * Run with:  node tests/locales-completeness.js
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

// v1.4.23 inventory — the exact 19 locales we ship.
const EXPECTED_LOCALES = [
  "en",                                                       // default_locale
  "de", "es", "fr", "hi", "id", "it", "ja", "pl", "pt_BR", "ru", "tr",   // v1.4.22 baseline
  "vi", "th", "zh_CN", "zh_TW", "ko", "nl", "ar",             // v1.4.23 additions
];

// ===== 1. All 19 locale directories present =============================

const localesDir = path.join(REPO, "_locales");
const actualLocales = fs.readdirSync(localesDir).filter((d) => {
  const p = path.join(localesDir, d);
  return fs.statSync(p).isDirectory();
}).sort();

assertEq("1) _locales/ contains exactly 19 locales (sorted)",
  actualLocales, EXPECTED_LOCALES.slice().sort());

// ===== 2. Each messages.json is valid JSON ==============================

const messagesByLocale = {};
for (const loc of EXPECTED_LOCALES) {
  const p = path.join(localesDir, loc, "messages.json");
  let json;
  try { json = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) {
    fail++;
    console.error(`\n  FAIL 2.${loc}) messages.json is not valid JSON: ${e.message}`);
    continue;
  }
  pass++; process.stdout.write(".");
  messagesByLocale[loc] = json;
}

// ===== 3. Every key in en is present in every other locale =============

const enKeys = Object.keys(messagesByLocale.en).filter((k) => !k.startsWith("_"));
for (const loc of EXPECTED_LOCALES) {
  if (loc === "en") continue;
  const json = messagesByLocale[loc];
  if (!json) continue;
  for (const key of enKeys) {
    assertTrue(`3.${loc}.${key}) locale has key "${key}"`,
      key in json && json[key] && typeof json[key].message === "string");
  }
}

// ===== 4. extName ≤ 75 chars in every locale ===========================

for (const loc of EXPECTED_LOCALES) {
  const json = messagesByLocale[loc];
  if (!json) continue;
  const len = (json.extName && json.extName.message || "").length;
  assertTrue(`4.${loc}) extName length ${len} ≤ 75`, len <= 75);
}

// ===== 5. extDescription ≤ 132 chars in every locale ===================

for (const loc of EXPECTED_LOCALES) {
  const json = messagesByLocale[loc];
  if (!json) continue;
  const len = (json.extDescription && json.extDescription.message || "").length;
  assertTrue(`5.${loc}) extDescription length ${len} ≤ 132`, len <= 132);
}

// ===== 6. $1 placeholder preservation ===================================
//
// For every en key whose message contains "$1", the corresponding locale
// key MUST also contain "$1". Chrome substitutes placeholders at runtime;
// a locale that drops $1 silently breaks the substitution.

for (const key of enKeys) {
  const enMsg = messagesByLocale.en[key].message;
  if (enMsg.indexOf("$1") < 0) continue;
  for (const loc of EXPECTED_LOCALES) {
    if (loc === "en") continue;
    const locMsg = messagesByLocale[loc] && messagesByLocale[loc][key]
      && messagesByLocale[loc][key].message;
    if (typeof locMsg !== "string") continue;
    assertTrue(`6.${loc}.${key}) preserves $1 placeholder`,
      locMsg.indexOf("$1") >= 0);
  }
}

// ===== 7. Strict schema: every top-level key is a message object =======
//
// Chrome's messages.json schema requires every top-level key to map to an
// object carrying a string "message" field. v1.4.23 originally shipped a
// non-conforming "_translation_status" string key; translation-status
// tracking now lives in _locales/TRANSLATION_STATUS.md instead. This
// assertion is a hard CI gate that catches any future schema violation
// (stray scalar keys, missing "message", etc.).

for (const loc of EXPECTED_LOCALES) {
  const json = messagesByLocale[loc];
  if (!json) continue;
  for (const key of Object.keys(json)) {
    const v = json[key];
    assertTrue(`7.${loc}.${key}) top-level key is an object with a string "message"`,
      v && typeof v === "object" && !Array.isArray(v) &&
      typeof v.message === "string");
  }
}

// ===== 8. Translation-status tracking lives in a root markdown file =====
//
// _locales/TRANSLATION_STATUS.md sits at the _locales/ root (Chrome ignores
// non-locale files here, so it won't break loading) and must enumerate all
// 7 auto-translated locales pending native-speaker review.

const NEW_LOCALES_V1423 = ["vi", "th", "zh_CN", "zh_TW", "ko", "nl", "ar"];
const statusMdPath = path.join(localesDir, "TRANSLATION_STATUS.md");
assertTrue("8) _locales/TRANSLATION_STATUS.md exists at _locales/ root",
  fs.existsSync(statusMdPath));

if (fs.existsSync(statusMdPath)) {
  const statusMd = fs.readFileSync(statusMdPath, "utf8");
  for (const loc of NEW_LOCALES_V1423) {
    assertTrue(`8.${loc}) TRANSLATION_STATUS.md lists "${loc}"`,
      statusMd.indexOf(loc) >= 0);
  }
}

process.stdout.write("\n");
console.log(`LOCALES COMPLETENESS: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
