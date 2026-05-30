/* CleanFeed v1.5.0 phase 2 — regex matching for keyword + channel blocking.
 *
 * v1.4.0 keywords were lowercase substring matches (array<string>).
 * v1.5.0 phase 2 generalises this:
 *   - hiddenKeywords becomes array<{pattern, isRegex}>
 *   - blockedChannels gains an optional isRegex flag per entry
 *   - Legacy storage shapes are normalised on read (one-time migration
 *     persists via options.js's edit path)
 *   - Invalid regex patterns are silently skipped at match time; the
 *     options UI surfaces a "⚠ invalid" indicator next to the row.
 *
 * Mirror of:
 *   content/content.js _normalizeKwEntry + applyKeywordBlocks matcher
 *   options/options.js  _normalizeKws + _isValidRegex
 *   content/content.js _channelMatcher
 *
 * Run with:  node tests/regex-keywords.js
 */
"use strict";

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

// ---- mirrors of production helpers --------------------------------------

function _normalizeKwEntry(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    return { pattern: t, isRegex: false };
  }
  if (typeof raw === "object") {
    const p = String(raw.pattern || "").trim();
    if (!p) return null;
    return { pattern: p, isRegex: !!raw.isRegex };
  }
  return null;
}

function _normalizeKws(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const n = _normalizeKwEntry(entry);
    if (!n) continue;
    const key = (n.isRegex ? "rx:" : "lit:") + n.pattern.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
    if (out.length >= 200) break;
  }
  return out;
}

function _isValidRegex(pat) {
  try { new RegExp(pat, "i"); return true; }
  catch (_) { return false; }
}

// Mirror of content.js applyKeywordBlocks' matching logic. Returns true
// if the given title would be HIDDEN by the given keyword list.
function _kwHides(kws, titleRaw) {
  const norm = _normalizeKws(kws);
  if (norm.length === 0) return false;
  const titleLower = String(titleRaw || "").toLowerCase();
  for (const k of norm) {
    if (k.isRegex) {
      let rx;
      try { rx = new RegExp(k.pattern, "i"); } catch (_) { continue; }
      if (rx.test(titleRaw)) return true;
    } else {
      const lit = k.pattern.toLowerCase();
      if (lit && titleLower.indexOf(lit) !== -1) return true;
    }
  }
  return false;
}

// Channel matcher mirror.
function _normalizeHandle(h) {
  if (!h) return "";
  return String(h).trim().toLowerCase().replace(/^@/, "");
}
function _channelHides(blockedChannels, info) {
  if (!info) return false;
  for (const b of blockedChannels) {
    if (!b) continue;
    if (b.isRegex) {
      const pat = String(b.handle || b.name || "").trim();
      if (!pat) continue;
      let rx;
      try { rx = new RegExp(pat, "i"); } catch (_) { continue; }
      if (rx.test(info.handle || "") || rx.test(info.name || "")) return true;
    } else {
      if (b.handle && info.handle && _normalizeHandle(b.handle) === info.handle) return true;
      if (b.name && info.name && b.name.toLowerCase() === info.name.toLowerCase()) return true;
    }
  }
  return false;
}

// ===== 1. Legacy substring path still works (migration sentinel) =======
//
// A user upgrading from v1.4.0+ has hiddenKeywords as array<string>.
// _normalizeKws lifts each string into {pattern, isRegex:false} and the
// matcher continues to substring-match the same way as before.

{
  const legacy = ["reaction", "clickbait", "drama"];
  assertEq("1a) legacy[0] -> {pattern, isRegex:false}",
    _normalizeKwEntry(legacy[0]), { pattern: "reaction", isRegex: false });
  assertEq("1b) legacy hides 'Best REACTION video EVER'",
    _kwHides(legacy, "Best REACTION video EVER"), true);
  assertEq("1c) legacy hides 'Total drama'", _kwHides(legacy, "Total drama"), true);
  assertEq("1d) legacy does NOT hide 'A documentary'",
    _kwHides(legacy, "A documentary"), false);
}

// ===== 2. v1.5.0 shape: explicit isRegex:false equals substring ========

{
  const kws = [
    { pattern: "reaction",  isRegex: false },
    { pattern: "clickbait", isRegex: false },
  ];
  assertEq("2a) new shape with isRegex:false hides 'Reaction!'",
    _kwHides(kws, "Reaction!"), true);
  assertEq("2b) new shape doesn't hide 'A nice video'",
    _kwHides(kws, "A nice video"), false);
}

// ===== 3. Regex matching (isRegex:true) ================================

{
  // ^I (case-insensitive) — matches titles that start with 'I' (with optional
  // leading whitespace handled by the case-insensitive flag).
  const kws = [{ pattern: "^I", isRegex: true }];
  assertEq("3a) regex ^I hides 'I tried X'",  _kwHides(kws, "I tried X"), true);
  assertEq("3b) regex ^I hides 'i tried X' (case-insensitive)",
    _kwHides(kws, "i tried X"), true);
  assertEq("3c) regex ^I does NOT hide 'X tried I'",
    _kwHides(kws, "X tried I"), false);
}
{
  // Multi-alternation pattern: reaction|drama|clickbait
  const kws = [{ pattern: "react(s|ed|ion)?|drama|clickbait", isRegex: true }];
  assertEq("3d) regex hides 'My reaction was'", _kwHides(kws, "My reaction was"), true);
  assertEq("3e) regex hides 'reacted to'",      _kwHides(kws, "reacted to"), true);
  assertEq("3f) regex hides 'pure drama'",      _kwHides(kws, "pure drama"), true);
  assertEq("3g) regex hides 'CLICKBAIT title'", _kwHides(kws, "CLICKBAIT title"), true);
  assertEq("3h) regex does NOT hide 'a casual chat'",
    _kwHides(kws, "a casual chat"), false);
}
{
  // Word-boundary regex: hide 'AI' as a standalone word but not 'rain'.
  const kws = [{ pattern: "\\bAI\\b", isRegex: true }];
  assertEq("3i) word-boundary AI hides 'GPT-4 is AI'",
    _kwHides(kws, "GPT-4 is AI"), true);
  assertEq("3j) word-boundary AI does NOT hide 'rain'",
    _kwHides(kws, "rain"), false);
  assertEq("3k) word-boundary AI does NOT hide 'maintained'",
    _kwHides(kws, "maintained"), false);
}

// ===== 4. Substring + regex coexist =====================================

{
  const kws = [
    { pattern: "drama",     isRegex: false },     // substring
    { pattern: "^Top \\d+", isRegex: true },      // regex
  ];
  assertEq("4a) substring 'drama' hides", _kwHides(kws, "Pure drama"), true);
  assertEq("4b) regex 'Top \\d+' hides 'Top 10 facts'",
    _kwHides(kws, "Top 10 facts"), true);
  assertEq("4c) neither matches 'A calm video'",
    _kwHides(kws, "A calm video"), false);
}

// ===== 5. Invalid regex is silently skipped =============================

{
  const kws = [
    { pattern: "[invalid",   isRegex: true },     // unclosed character class
    { pattern: "good",       isRegex: false },
  ];
  assertEq("5a) _isValidRegex('[invalid') = false",
    _isValidRegex("[invalid"), false);
  assertEq("5b) invalid regex doesn't crash; substring still hides 'good vibes'",
    _kwHides(kws, "good vibes"), true);
  assertEq("5c) invalid regex doesn't match anything",
    _kwHides([{ pattern: "[invalid", isRegex: true }], "anything"), false);
}
{
  // Unbalanced paren
  assertEq("5d) _isValidRegex('(unclosed') = false",
    _isValidRegex("(unclosed"), false);
  // Lookbehind that some old engines reject — but Node accepts. Confirm
  // it's accepted (regression sentinel: if a future bump rejects, this
  // flips).
  assertEq("5e) _isValidRegex('(?<=x)y') = true (Node supports lookbehind)",
    _isValidRegex("(?<=x)y"), true);
}

// ===== 6. Dedupe across substring + regex spaces ========================
//
// The same pattern as substring and as regex are DIFFERENT entries (a
// substring search for "react" is conceptually different from a regex
// "react" pattern). Both should survive normalization.

{
  const kws = [
    { pattern: "react", isRegex: false },
    { pattern: "react", isRegex: true },
    { pattern: "react", isRegex: false },        // duplicate substring
    { pattern: "react", isRegex: true  },        // duplicate regex
  ];
  const norm = _normalizeKws(kws);
  assertEq("6a) dedupe to 2 entries (one substring + one regex)",
    norm.length, 2);
  assertTrue("6b) substring entry present",
    norm.some((k) => k.pattern === "react" && !k.isRegex));
  assertTrue("6c) regex entry present",
    norm.some((k) => k.pattern === "react" && k.isRegex));
}

// ===== 7. Empty / malformed entries pruned ==============================

{
  const kws = [
    "",                                  // empty string
    "   ",                               // whitespace
    null,
    undefined,
    { pattern: "",       isRegex: false },
    { pattern: "good",   isRegex: false },
    { pattern: undefined, isRegex: true  },
    42,                                  // non-object, non-string
  ];
  const norm = _normalizeKws(kws);
  assertEq("7) malformed entries pruned to exactly 1 valid",
    norm.length, 1);
  assertEq("7) the valid entry survived",
    norm[0], { pattern: "good", isRegex: false });
}

// ===== 8. 200-entry cap =================================================

{
  const arr = [];
  for (let i = 0; i < 250; i++) arr.push({ pattern: "kw" + i, isRegex: false });
  const norm = _normalizeKws(arr);
  assertEq("8) 250-entry list truncated to 200", norm.length, 200);
}

// =====================================================================
// Channel blocklist regex
// =====================================================================

// ===== 9. Legacy channel entry (no isRegex) — exact match only ========

{
  const blocked = [
    { handle: "kurzgesagt",      name: "Kurzgesagt – In a Nutshell" },
  ];
  assertEq("9a) exact handle match hides",
    _channelHides(blocked, { handle: "kurzgesagt", name: "" }), true);
  assertEq("9b) exact name match hides",
    _channelHides(blocked, { handle: "", name: "Kurzgesagt – In a Nutshell" }), true);
  assertEq("9c) different channel passes",
    _channelHides(blocked, { handle: "otherone", name: "Other Channel" }), false);
  assertEq("9d) partial substring does NOT match (exact only)",
    _channelHides(blocked, { handle: "kurzgesagtext", name: "" }), false);
}

// ===== 10. Channel regex toggle =========================================

{
  const blocked = [
    { handle: "^drama.*", name: "", isRegex: true },
  ];
  assertEq("10a) regex 'drama.*' hides handle 'dramachannel'",
    _channelHides(blocked, { handle: "dramachannel", name: "" }), true);
  assertEq("10b) regex 'drama.*' hides handle 'DramaTV' (case-insensitive)",
    _channelHides(blocked, { handle: "DramaTV", name: "" }), true);
  assertEq("10c) regex 'drama.*' does NOT hide 'newschannel'",
    _channelHides(blocked, { handle: "newschannel", name: "" }), false);
}
{
  // Regex also tries the name field
  const blocked = [
    { handle: "", name: "^Daily News$", isRegex: true },
  ];
  assertEq("10d) regex on name matches",
    _channelHides(blocked, { handle: "", name: "Daily News" }), true);
  assertEq("10e) regex on name doesn't match 'Daily News Extra'",
    _channelHides(blocked, { handle: "", name: "Daily News Extra" }), false);
}

// ===== 11. Invalid channel regex silently skipped =====================

{
  const blocked = [
    { handle: "[invalid", name: "", isRegex: true },
    { handle: "goodchannel", name: "", isRegex: false },
  ];
  assertEq("11a) bad regex doesn't crash; good channel still hides",
    _channelHides(blocked, { handle: "goodchannel", name: "" }), true);
  assertEq("11b) bad regex matches nothing",
    _channelHides([{ handle: "[invalid", name: "", isRegex: true }],
                  { handle: "anything", name: "any name" }), false);
}

// ===== 12. Mixed regex + exact channels coexist =======================

{
  const blocked = [
    { handle: "kurzgesagt",  name: "", isRegex: false },     // exact
    { handle: "^news.*tv$",  name: "", isRegex: true },      // regex
  ];
  assertEq("12a) exact-match channel hides",
    _channelHides(blocked, { handle: "kurzgesagt", name: "" }), true);
  assertEq("12b) regex channel hides 'newsmainstreamtv'",
    _channelHides(blocked, { handle: "newsmainstreamtv", name: "" }), true);
  assertEq("12c) unmatched channel passes",
    _channelHides(blocked, { handle: "otherone", name: "" }), false);
}

// ===== 13. Storage shape migration round-trip ==========================
//
// _normalizeKws is idempotent: running it on an already-normalized array
// returns the same shape.

{
  const v140 = ["reaction", "drama"];
  const once  = _normalizeKws(v140);
  const twice = _normalizeKws(once);
  assertEq("13a) once-normalized v140 list",
    once, [
      { pattern: "reaction", isRegex: false },
      { pattern: "drama",    isRegex: false },
    ]);
  assertEq("13b) twice-normalized identical",
    twice, once);
}

process.stdout.write("\n");
console.log(`REGEX KEYWORDS: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
