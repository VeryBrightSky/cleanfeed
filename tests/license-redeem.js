/* CleanFeed v1.4.17 license-code redemption tests.
 *
 * Pure-logic tests for the four invariants that govern the license flow:
 *
 *   1. Key normalization: paste, type, with-dashes, no-dashes, mixed-case,
 *      surrounding whitespace — all must canonicalize to the same 24-char
 *      uppercase string in the [A-Z2-9] alphabet.
 *   2. Format validation: only canonical 24-char strings in the
 *      [A-Z2-9] alphabet are valid. Ambiguous chars (0, 1, I, L, O), too
 *      short, too long, or non-alphanumeric punctuation must be rejected.
 *   3. Pro state OR logic: the derived `paid` flag is TRUE iff ExtPay says
 *      so OR a license is active. Both off → not paid.
 *   4. /verify state transitions: active+ok stays active; active+revoked
 *      (or wrong_install / not_found) deactivates; active+network-error
 *      stays active (NEVER fail-closed).
 *
 * The helpers below mirror the production helpers in options/options.js
 * (_normalizeLicense, _isValidLicenseFormat, _formatLicense) and the
 * background.js merge function recomputePaid() / verifyLicenseIfPresent().
 *
 * Run with:  node tests/license-redeem.js
 */
"use strict";

let pass = 0, fail = 0;
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}\n    expected: ${e}\n    actual:   ${a}`); }
}

// ---- helpers under test (mirror production code) -----------------------

function normalizeLicense(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z2-9]/g, "");
}
function isValidLicenseFormat(normalized) {
  return /^[A-Z2-9]{24}$/.test(normalized);
}
function formatLicense(normalized) {
  return normalized.match(/.{4}/g).join("-");
}
// v1.4.18 — partial-display redaction (production helper in options.js).
function partialLicense(normalized) {
  return normalized.slice(0, 4) + "-XXXX-XXXX-XXXX-XXXX-" + normalized.slice(20, 24);
}
// Render-time derivation: prefer the full key; fall back to whatever
// key_partial holds.
function displayPartial(lic) {
  if (lic && typeof lic.key === "string") {
    const norm = normalizeLicense(lic.key);
    if (norm.length === 24) return partialLicense(norm);
  }
  return (lic && lic.key_partial) || "";
}
// background.js recomputePaid pseudo: derived `paid` from inputs.
function computePaid(extpayPaid, license) {
  return !!extpayPaid || !!(license && license.active);
}
// background.js verifyLicenseIfPresent pseudo: returns the next license
// state given the current license + the server response (or null for
// network error).
function applyVerifyResponse(license, response, now = 1700000000000) {
  if (!license || !license.active) return license;        // no-op
  if (response === null) return license;                  // network — keep
  if (response && response.ok === true) return license;   // valid — keep
  if (response && response.ok === false && response.reason) {
    return Object.assign({}, license, {
      active: false,
      deactivated_reason: response.reason,
      deactivated_at: now,
    });
  }
  // Unexpected shape — fail open, keep current license.
  return license;
}

const VALID = "ABCDEFGHJKMNPQRSTUVWX23";       // 22 chars (NOT 24 — invalid)
const CANON = "ABCDEFGHJKMNPQRSTUVWXYZ2";      // canonical 24-char sample
const CANON_DASHED = "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2";

// ===== 1. Normalization =================================================

assertEq("normalize: dashed canonical -> 24-char",
  normalizeLicense(CANON_DASHED), CANON);
assertEq("normalize: lowercase + dashes",
  normalizeLicense("abcd-efgh-jkmn-pqrs-tuvw-xyz2"), CANON);
assertEq("normalize: surrounded by whitespace",
  normalizeLicense("   ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2   "), CANON);
assertEq("normalize: tabs + newlines + interspersed spaces",
  normalizeLicense("\tABCD EFGH\nJKMN  PQRS  TUVW\tXYZ2 "), CANON);
assertEq("normalize: dropped dashes entirely",
  normalizeLicense("abcdefghjkmnpqrstuvwxyz2"), CANON);
// Per the spec regex /^[A-Z2-9]{24}$/, only 0 and 1 are outside the
// alphabet — I, L, O remain. The Worker never issues keys containing
// I/L/O, so a key with those chars will simply 404 server-side; the
// client doesn't need to second-guess.
assertEq("normalize: 0 and 1 stripped; I/L/O preserved (per spec regex)",
  normalizeLicense("01ABCDEFGHIJKLMNOPQRSTUVW"), "ABCDEFGHIJKLMNOPQRSTUVW");
assertEq("normalize: empty input -> empty string",
  normalizeLicense(""), "");
assertEq("normalize: null input -> empty string",
  normalizeLicense(null), "");
assertEq("normalize: punctuation stripped",
  normalizeLicense("ABCD!EFGH@JKMN#PQRS$TUVW%XYZ2"), CANON);

// ===== 2. Format validation ============================================

assertEq("format: canonical 24-char -> valid", isValidLicenseFormat(CANON), true);
assertEq("format: 23 chars -> invalid",
  isValidLicenseFormat(CANON.slice(0, 23)), false);
assertEq("format: 25 chars -> invalid",
  isValidLicenseFormat(CANON + "A"), false);
// Per spec regex /^[A-Z2-9]{24}$/: 0 and 1 are outside the alphabet,
// so they're rejected at format-validation; I/L/O ARE allowed at this
// layer (the Worker server is the alphabet authority — keys containing
// I/L/O simply don't exist in KV, server returns 404).
assertEq("format: contains 0 (outside alphabet) -> invalid",
  isValidLicenseFormat("ABCDEFGHJKMNPQRSTUVWXY02"), false);
assertEq("format: contains 1 (outside alphabet) -> invalid",
  isValidLicenseFormat("ABCDEFGHJKMNPQRSTUVWXY12"), false);
assertEq("format: contains I (kept by spec regex; server 404s on mismatch)",
  isValidLicenseFormat("ABCDEFGHJKMNPQRSTUVWXYI2"), true);
assertEq("format: contains L (kept by spec regex; server 404s)",
  isValidLicenseFormat("ABCDEFGHJKMNPQRSTUVWXYL2"), true);
assertEq("format: contains O (kept by spec regex; server 404s)",
  isValidLicenseFormat("ABCDEFGHJKMNPQRSTUVWXYO2"), true);
assertEq("format: lowercase -> invalid (must be pre-normalized)",
  isValidLicenseFormat("abcdefghjkmnpqrstuvwxyz2"), false);
assertEq("format: contains dashes -> invalid (must be pre-normalized)",
  isValidLicenseFormat(CANON_DASHED), false);
assertEq("format: empty -> invalid", isValidLicenseFormat(""), false);

// ===== 3. Display formatting ===========================================

assertEq("format(canonical) -> dashed groups of 4",
  formatLicense(CANON), CANON_DASHED);

// ===== 3b. v1.4.18 partial-display redaction ===========================
//
// New format mirrors the full canonical layout (6 groups of 4 separated
// by dashes) but masks the middle four groups as XXXX. Identical char
// count to a real key — visually distinguishable only by the mask.

assertEq("partial: canonical -> first4-XXXX-XXXX-XXXX-XXXX-last4",
  partialLicense(CANON),
  "ABCD-XXXX-XXXX-XXXX-XXXX-XYZ2");
assertEq("partial: length matches full key length (29 chars incl. dashes)",
  partialLicense(CANON).length, 29);
assertEq("partial: middle 4 groups are exactly XXXX",
  /^[A-Z2-9]{4}-XXXX-XXXX-XXXX-XXXX-[A-Z2-9]{4}$/.test(partialLicense(CANON)), true);

// 3c. v1.4.18 render-time derivation prefers full key over stored partial.
//     v1.4.17 stored key_partial in the old ellipsis form "ABCD…XYZ2";
//     v1.4.18 always re-derives the display from lic.key, so the legacy
//     storage value is irrelevant for what the user sees.
{
  const v1417_legacy_lic = {
    active: true,
    key: "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2",
    key_partial: "ABCD…XYZ2",          // legacy ellipsis form
    redeemed_at: 1700000000000,
  };
  assertEq("display: v1.4.17 legacy storage -> new 6-group masked display",
    displayPartial(v1417_legacy_lic),
    "ABCD-XXXX-XXXX-XXXX-XXXX-XYZ2");
}
{
  const v1418_fresh_lic = {
    active: true,
    key: "Z2JQ-EFGH-JKMN-PQRS-TUVW-Y9N2",
    key_partial: "Z2JQ-XXXX-XXXX-XXXX-XXXX-Y9N2",
    redeemed_at: 1700000000000,
  };
  assertEq("display: v1.4.18 fresh redemption -> idempotent",
    displayPartial(v1418_fresh_lic),
    "Z2JQ-XXXX-XXXX-XXXX-XXXX-Y9N2");
}
{
  // Defensive: missing full key, only key_partial available. Return
  // whatever's there — best-effort, no crash.
  const stub = { active: true, key_partial: "WEIRDFORMATXYZ", redeemed_at: 1 };
  assertEq("display: missing key falls back to stored key_partial",
    displayPartial(stub), "WEIRDFORMATXYZ");
}
{
  // Edge case: lic is null (no license set yet) — return empty string,
  // never crash the render.
  assertEq("display: null lic -> empty string",
    displayPartial(null), "");
}

// ===== 4. Pro OR logic =================================================

assertEq("paid: ExtPay only",
  computePaid(true, null), true);
assertEq("paid: license only",
  computePaid(false, { active: true }), true);
assertEq("paid: both",
  computePaid(true, { active: true }), true);
assertEq("paid: neither",
  computePaid(false, null), false);
assertEq("paid: false ExtPay + license object exists but active=false",
  computePaid(false, { active: false, key: "X" }), false);
assertEq("paid: undefined ExtPay treated as falsy",
  computePaid(undefined, null), false);
assertEq("paid: license null + ExtPay true",
  computePaid(true, null), true);
assertEq("paid: license missing 'active' key treated as inactive",
  computePaid(false, {}), false);

// ===== 5. /verify state transitions ====================================

const activeLicense = {
  active: true,
  key: "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2",
  key_partial: "ABCD…XYZ2",
  redeemed_at: 1699000000000,
};

// 5a. active + ok=true -> unchanged
assertEq("verify: active + ok stays active",
  applyVerifyResponse(activeLicense, { ok: true }),
  activeLicense);

// 5b. active + ok=false revoked -> deactivated, reason recorded
{
  const next = applyVerifyResponse(activeLicense, { ok: false, reason: "revoked" }, 1700000000000);
  assertEq("verify: revoked -> active false",
    next.active, false);
  assertEq("verify: revoked -> reason stored",
    next.deactivated_reason, "revoked");
  assertEq("verify: revoked -> timestamp stored",
    typeof next.deactivated_at === "number" && next.deactivated_at > 0, true);
  assertEq("verify: revoked -> original key preserved (for audit)",
    next.key, activeLicense.key);
}

// 5c. active + ok=false wrong_install -> deactivated
{
  const next = applyVerifyResponse(activeLicense, { ok: false, reason: "wrong_install" });
  assertEq("verify: wrong_install -> deactivated",
    next.active, false);
  assertEq("verify: wrong_install -> reason wrong_install",
    next.deactivated_reason, "wrong_install");
}

// 5d. active + ok=false not_found -> deactivated
{
  const next = applyVerifyResponse(activeLicense, { ok: false, reason: "not_found" });
  assertEq("verify: not_found -> deactivated",
    next.active, false);
}

// 5e. active + network error (response === null) -> unchanged
//    THIS IS LOAD-BEARING. A paid user must NEVER lose Pro because of a
//    network blip. The Worker /verify must be the only path that can flip
//    license.active to false, and only with an explicit reason payload.
{
  const next = applyVerifyResponse(activeLicense, null);
  assertEq("verify: network error -> license unchanged (fail-open)",
    next, activeLicense);
  assertEq("verify: network error -> still active",
    next.active, true);
}

// 5f. active + ok=false WITHOUT reason (malformed response) -> unchanged
//    Defensive: a malformed server response shouldn't be able to revoke
//    a legitimate license; only well-formed {ok:false, reason} can.
{
  const next = applyVerifyResponse(activeLicense, { ok: false });
  assertEq("verify: malformed ok:false (no reason) -> license unchanged",
    next, activeLicense);
}

// 5g. already-inactive license + any response -> no-op
{
  const inactive = Object.assign({}, activeLicense, { active: false });
  assertEq("verify: already-inactive + ok=true -> no-op",
    applyVerifyResponse(inactive, { ok: true }), inactive);
  assertEq("verify: already-inactive + ok=false -> no-op (don't churn)",
    applyVerifyResponse(inactive, { ok: false, reason: "revoked" }), inactive);
  assertEq("verify: null license -> no-op",
    applyVerifyResponse(null, { ok: false, reason: "revoked" }), null);
}

// ===== 6. Compose: paid flag after a verify-driven revocation ===========
//    End-to-end sanity that revoking via /verify drops the user back to
//    ExtPay-only Pro state (or no Pro at all if ExtPay also false).
{
  let lic = Object.assign({}, activeLicense);
  let ext = false;
  assertEq("compose: license-only Pro user starts as paid",
    computePaid(ext, lic), true);
  lic = applyVerifyResponse(lic, { ok: false, reason: "revoked" });
  assertEq("compose: revocation drops license-only Pro user to FREE",
    computePaid(ext, lic), false);
}
{
  let lic = Object.assign({}, activeLicense);
  let ext = true;        // user is also an ExtPay subscriber
  assertEq("compose: dual-subscribed user starts as paid",
    computePaid(ext, lic), true);
  lic = applyVerifyResponse(lic, { ok: false, reason: "revoked" });
  assertEq("compose: revocation on dual-subscribed user STAYS paid via ExtPay",
    computePaid(ext, lic), true);
}

process.stdout.write("\n");
console.log(`LICENSE REDEEM: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
