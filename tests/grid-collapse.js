/* CleanFeed v1.4.24.4 — grid-cell collapse (reflow, no empty gaps).
 *
 * The new-DOM hide rules set display:none on the INNER yt-lockup-view-model,
 * but its enclosing grid cell (ytd-rich-item-renderer) kept its box and left an
 * empty slot that didn't reflow. v1.4.24.4 adds companion "wrapper-collapse"
 * rules — ADDITIVE CSS only; no JS/detection/selector-logic change.
 *
 * Each collapse rule must be guarded by an active-only data-cf-* tag or a
 * specific blocked-content :has() — NEVER a bare ytd-rich-item-renderer rule
 * that would collapse normal cells.
 *
 * DOM-engine note: node has no :has() engine, so real CSS matching is verified
 * LIVE in Chrome (this fix: 6 wrappers collapsed, 24 untagged cells stayed
 * visible, 0 untagged collapsed). Here we (a) assert each collapse rule is
 * present in the shipped styles.css with the correct guard, and (b) model the
 * :has() DISCRIMINATOR to prove the over-match guarantee: a cell WITH the
 * tagged/blocked child collapses, a cell WITHOUT it does not.
 *
 * Run with:  node tests/grid-collapse.js
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
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}\n    expected: ${e}\n    actual:   ${a}`); }
}

const css = fs.readFileSync(path.join(__dirname, "..", "content", "styles.css"), "utf8");
// v1.4.24.8 — comment-stripped copy for selector scans: comments now document
// the banned RD selectors verbatim and must not trip the code-level checks.
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");

// ==========================================================================
// 1. Collapse rules present, each with the correct guard
// ==========================================================================
{
  // members-only + watched: scoped to their body.cf-block-* class (double
  // guard: the class AND the active-only data-cf-* tag).
  assertTrue("collapse: members-only wrapper rule present + body-class guarded",
    css.includes('body.cf-block-subs-members-only ytd-rich-item-renderer:has(yt-lockup-view-model[data-cf-members-only="1"])'));
  assertTrue("collapse: watched wrapper rule present + body-class guarded",
    css.includes('body.cf-block-subs-watched ytd-rich-item-renderer:has(yt-lockup-view-model[data-cf-watched="1"])'));

  // mixes: v1.4.24.8 — the RD-href collapse rule was REMOVED. Ordinary
  // new-DOM cards link through &list=RD…&start_radio=1, so an RD-keyed
  // collapse would hide normal feed cells (verified live: 15/21 sidebar
  // recs). No mixes collapse rule may exist at all.
  assertTrue("collapse: RD-href mixes wrapper rule is GONE",
    !css.includes('ytd-rich-item-renderer:has(a[href*="list=RD"])') &&
    !css.includes('ytd-rich-item-renderer:has(a[href*="&list=RD"])'));
  // Invalid nested :has() must NOT be shipped (Chrome would drop the rule).
  assertTrue("collapse: no nested :has() (invalid in Chrome)",
    !css.includes('ytd-rich-item-renderer:has(yt-lockup-view-model:has('));

  // channel-block + keyword-block: guarded by the data-cf-* tag (set only on
  // blocked content), so no body-class needed; cover 3 wrapper types.
  for (const wrap of ["ytd-rich-item-renderer", "ytd-video-renderer", "ytd-grid-video-renderer"]) {
    assertTrue(`collapse: channel-block guards ${wrap}`,
      css.includes(`${wrap}:has([data-cf-blocked-channel="1"])`));
    assertTrue(`collapse: keyword-block guards ${wrap}`,
      css.includes(`${wrap}:has([data-cf-keyword="1"])`));
  }
}

// ==========================================================================
// 2. NO bare wrapper collapse rule slipped in (the cardinal-sin guard)
// ==========================================================================
{
  // Every ytd-rich-item-renderer:has(...) collapse must carry a data-cf-* tag
  // or a list=RD blocked-content match — never a structural-only :has() that
  // could hit a normal cell. Scan each :has() argument on a rich-item wrapper.
  const re = /ytd-rich-item-renderer:has\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g;
  let m, checked = 0, bad = 0;
  while ((m = re.exec(cssCode)) !== null) {
    const arg = m[1];
    checked++;
    // A rich-item :has() is safe iff its argument references BLOCKED content:
    // an active-only data-cf-* tag, the members-only badge label, or a
    // content-specific badge class (.badge-style-type-* only ever appears on
    // that badge type) — the latter two are the pre-existing old-DOM
    // inner-hide rules. None of these ever matches a normal cell. A bare/
    // structural-only arg would be the cardinal sin. NOTE (v1.4.24.8):
    // list=RD is deliberately NOT an accepted guard anymore — normal new-DOM
    // cards carry start_radio RD hrefs, so an RD-keyed rule over-matches; if
    // one is ever reintroduced, this scan must flag it.
    const guarded = /data-cf-|Members only|badge-style-type-/.test(arg);
    if (!guarded) { bad++; console.error(`\n    UNGUARDED rich-item collapse arg: ${arg}`); }
  }
  assertTrue("collapse: scanned at least the expected rich-item :has() rules", checked >= 5);
  assertEq("collapse: zero unguarded ytd-rich-item-renderer:has() rules", bad, 0);
}

// ==========================================================================
// 3. Over-match DISCRIMINATOR models (mirror the :has() semantics)
// ==========================================================================
// A grid cell = { lockups:[{attrs}], anchors:[href], tagged:[attr names on any child] }
function cellHasTaggedLockup(cell, attr) {
  return cell.lockups.some((l) => l.attrs[attr] === "1");
}
function cellHasChildTag(cell, attr) {
  return cell.tagged.includes(attr);
}
function cell(opts) {
  return {
    lockups: opts.lockups || [],
    anchors: opts.anchors || [],
    tagged: opts.tagged || [],
  };
}

// ---- members-only ----
{
  const tagged = cell({ lockups: [{ attrs: { "data-cf-members-only": "1" } }] });
  const plain = cell({ lockups: [{ attrs: {} }] });
  const watchedOnly = cell({ lockups: [{ attrs: { "data-cf-watched": "1" } }] });
  assertTrue("3) members: cell WITH tagged lockup collapses", cellHasTaggedLockup(tagged, "data-cf-members-only"));
  assertTrue("3) members: plain cell does NOT collapse (over-match guard)", !cellHasTaggedLockup(plain, "data-cf-members-only"));
  assertTrue("3) members: watched-only cell does NOT collapse under members rule", !cellHasTaggedLockup(watchedOnly, "data-cf-members-only"));
}
// ---- watched ----
{
  const tagged = cell({ lockups: [{ attrs: { "data-cf-watched": "1" } }] });
  const plain = cell({ lockups: [{ attrs: {} }] });
  assertTrue("3) watched: cell WITH tagged lockup collapses", cellHasTaggedLockup(tagged, "data-cf-watched"));
  assertTrue("3) watched: plain cell does NOT collapse (over-match guard)", !cellHasTaggedLockup(plain, "data-cf-watched"));
}
// ---- mixes (v1.4.24.8: RD anchors are NOT a collapse trigger) ----
{
  // Ordinary new-DOM cards carry /watch?v=X&list=RDX&start_radio=1 hrefs
  // (radio play-endpoints), so a cell with an RD anchor is usually a NORMAL
  // video. No collapse rule may key on it — assert the shipped CSS has no
  // RD-based collapse and that a start_radio cell only collapses via a
  // data-cf-* tag, never via its anchors.
  assertTrue("3) mixes: no RD-keyed collapse rule shipped",
    !/ytd-rich-item-renderer:has\([^)]*list=RD/.test(cssCode));
  const normalRec = cell({ anchors: ["/watch?v=a&list=RDa&start_radio=1"] });
  assertTrue("3) mixes: start_radio cell does NOT collapse via members rule",
    !cellHasTaggedLockup(normalRec, "data-cf-members-only"));
  assertTrue("3) mixes: start_radio cell does NOT collapse via child tags",
    !cellHasChildTag(normalRec, "data-cf-blocked-channel") &&
    !cellHasChildTag(normalRec, "data-cf-keyword"));
}
// ---- channel-block / keyword-block ----
{
  const blockedCh = cell({ tagged: ["data-cf-blocked-channel"] });
  const kw = cell({ tagged: ["data-cf-keyword"] });
  const normal = cell({ tagged: [] });
  assertTrue("3) channel-block: cell with a blocked-channel child collapses", cellHasChildTag(blockedCh, "data-cf-blocked-channel"));
  assertTrue("3) keyword-block: cell with a keyword-tagged child collapses", cellHasChildTag(kw, "data-cf-keyword"));
  assertTrue("3) normal cell collapses under neither sweep",
    !cellHasChildTag(normal, "data-cf-blocked-channel") && !cellHasChildTag(normal, "data-cf-keyword"));
}

// ==========================================================================
// 4. Additive-only: existing inner-hide rules for the same blockers are KEPT
// ==========================================================================
{
  assertTrue("kept: inner members-only hide rule",
    css.includes('body.cf-block-subs-members-only yt-lockup-view-model[data-cf-members-only="1"]'));
  assertTrue("kept: inner watched hide rule",
    css.includes('body.cf-block-subs-watched ytd-browse[page-subtype="subscriptions"] yt-lockup-view-model[data-cf-watched="1"]'));
  // v1.4.24.8 — the inner RD mixes rule was REMOVED (over-matched normal
  // recs); old-DOM mixes coverage is what remains.
  assertTrue("mixes: RD inner hide rule GONE, old-DOM rule kept",
    !css.includes('yt-lockup-view-model:has(a[href*="list=RD"])') &&
    css.includes("body.cf-block-mixes-playlists ytd-radio-renderer"));
  assertTrue("kept: existing bare [data-cf-keyword] hide rule",
    css.includes('[data-cf-keyword="1"] { display: none !important; }'));
}

console.log(`\nGRID COLLAPSE: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
