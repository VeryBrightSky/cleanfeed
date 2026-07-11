/* CleanFeed v1.4.24.3 — extended new-DOM selector coverage.
 *
 * Follows v1.4.24.2 (tests/newdom-selectors.js, the 3 core fixes). This suite
 * covers the four additional blockers that the full selector-health sweep found
 * dead / at-risk on YouTube's lit `yt-*-view-model` / `ytm-*-view-model` DOM:
 *
 *   1. mixes-playlists — v1.4.24.8 REVERSAL: the v1.4.24.3 RD-href lockup
 *      selectors were removed. Ordinary new-DOM recommendation links route
 *      through &list=RD…&start_radio=1, so [href*="list=RD"] matched NORMAL
 *      videos (hid 15/21 sidebar recs, verified live). Old-DOM renderers
 *      remain the only mixes selectors; new-DOM Mixes are under-blocked.
 *   2. subs-members-only — new-DOM card is yt-lockup-view-model with no stable
 *      badge attribute; a JS sweep (applyMembersOnlySweep) reads badge text and
 *      tags matches with data-cf-members-only="1".
 *   3. subs-watched — new progress bar is yt-thumbnail-overlay-progress-bar-
 *      view-model; applyWatchedSweep now detects BOTH it and the old #progress.
 *   4. thumbnails — also fade Shorts lockup images (ytm-shorts-lockup-view-model-v2 img).
 *
 * ABSOLUTE RULE tested throughout: every OLD selector is still present; the new
 * ones are ADDED alongside (both DOMs ship across cohorts).
 *
 * DOM-engine note: node here has no jsdom/:has() engine, so CSS :has() matching
 * is verified LIVE in the browser step. In node we (a) assert the selector text
 * is present in (or, for the removed RD rules, ABSENT from) the shipped
 * blockers.js/styles.css, and (b) unit-test the JS sweep logic against a
 * hand-rolled mock DOM (mirrors content.js).
 *
 * Run with:  node tests/newdom-extended.js
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
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}\n    expected: ${e}\n    actual:   ${a}`); }
}

// ----- load the REAL blockers.js + read the REAL css / content sources ------
const root = path.join(__dirname, "..");
const blockersSrc = fs.readFileSync(path.join(root, "content", "blockers.js"), "utf8");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(blockersSrc, sandbox);
const BLOCKERS = sandbox.window.__cleanfeed_blockers;
const byId = Object.fromEntries((BLOCKERS || []).map((b) => [b.id, b]));
const css = fs.readFileSync(path.join(root, "content", "styles.css"), "utf8");
const contentJs = fs.readFileSync(path.join(root, "content", "content.js"), "utf8");

assertTrue("blockers.js loaded", Array.isArray(BLOCKERS) && BLOCKERS.length > 0);

// ==========================================================================
// 1. MIXES-PLAYLISTS — v1.4.24.8: old renderers kept, RD-href selectors GONE
// ==========================================================================
{
  const mixes = byId["mixes-playlists"].selectors;
  assertTrue("mixes KEEPS ytd-radio-renderer", mixes.includes("ytd-radio-renderer"));
  assertTrue("mixes KEEPS ytd-compact-radio-renderer", mixes.includes("ytd-compact-radio-renderer"));
  // The RD-href approach is banned: ordinary new-DOM recommendation links use
  // /watch?v=X&list=RDX&start_radio=1, so ANY list=RD selector hides normal
  // videos (verified live: 15/21 sidebar recs vanished).
  assertTrue("mixes has NO RD-href selector left",
    !mixes.some((s) => s.indexOf("list=RD") !== -1));
  assertEq("mixes selector list is exactly the two old-DOM renderers",
    mixes, ["ytd-radio-renderer", "ytd-compact-radio-renderer"]);
}

// ----- 1b. OVER-MATCH GUARD: no shipped SELECTOR keys on list=RD ------------
// Scan every blocker's selector list AND every CSS selector line. list=RD may
// appear in comments (documenting the ban) but never in a live selector.
{
  for (const b of BLOCKERS) {
    assertTrue(`no list=RD selector in blocker '${b.id}'`,
      !(b.selectors || []).some((s) => s.indexOf("list=RD") !== -1));
  }
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assertTrue("styles.css has NO list=RD selector outside comments",
    cssNoComments.indexOf("list=RD") === -1);

  // Model of a NORMAL new-DOM sidebar recommendation (the card that was
  // wrongly hidden): a lockup whose thumbnail + title anchors carry the
  // start_radio RD href. It must match NO mixes selector — with the RD rules
  // gone, only the two old-DOM TAG selectors remain, and a lockup is neither.
  const normalRec = {
    tag: "yt-lockup-view-model",
    anchors: ["/watch?v=kyqpSycLASY&list=RDkyqpSycLASY&start_radio=1",
              "/watch?v=kyqpSycLASY&list=RDkyqpSycLASY&start_radio=1"],
  };
  const mixes = byId["mixes-playlists"].selectors;
  const matchedBy = mixes.filter((s) => s === normalRec.tag);
  assertEq("over-match guard: normal start_radio rec lockup matches NO mixes selector",
    matchedBy, []);
  // A real old-DOM Mix still matches (tag selector).
  assertTrue("old-DOM ytd-radio-renderer still matches",
    mixes.includes("ytd-radio-renderer"));
}

// ==========================================================================
// 2. THUMBNAILS — Shorts lockup image added alongside the existing selectors
// ==========================================================================
{
  const thumbs = byId["thumbnails"].selectors;
  assertTrue("thumbnails KEEPS yt-thumbnail-view-model img (v1.4.24.2)",
    thumbs.includes("yt-thumbnail-view-model img"));
  assertTrue("thumbnails KEEPS ytd-thumbnail img",
    thumbs.includes("ytd-thumbnail img"));
  assertTrue("thumbnails ADDS ytm-shorts-lockup-view-model-v2 img",
    thumbs.includes("ytm-shorts-lockup-view-model-v2 img"));
  assertTrue("styles.css fades shorts lockup image (base)",
    css.includes("body.cf-block-thumbnails ytm-shorts-lockup-view-model-v2 img"));
  assertTrue("styles.css fades shorts lockup image (blur mode)",
    css.includes("cf-mode-thumbnails-blur ytm-shorts-lockup-view-model-v2 img"));
  assertTrue("styles.css fades shorts lockup image (dim mode)",
    css.includes("cf-mode-thumbnails-dim ytm-shorts-lockup-view-model-v2 img"));
}

// ==========================================================================
// 3. SUBS-MEMBERS-ONLY — old CSS :has() kept + JS sweep tags new-DOM lockups
// ==========================================================================
{
  const members = byId["subs-members-only"].selectors;
  assertTrue("members KEEPS old ytd-badge-supported-renderer :has()",
    members.includes('ytd-rich-item-renderer:has(ytd-badge-supported-renderer[aria-label="Members only"])'));
  assertTrue("members KEEPS old [aria-label*] :has()",
    members.includes('ytd-rich-item-renderer:has([aria-label*="Members only"])'));
  assertTrue("members ADDS data-attr selector for the JS-tagged new-DOM card",
    members.includes('yt-lockup-view-model[data-cf-members-only="1"]'));
  assertTrue("styles.css hides JS-tagged new-DOM members card",
    css.includes('body.cf-block-subs-members-only yt-lockup-view-model[data-cf-members-only="1"]'));
  assertTrue("content.js wires applyMembersOnlySweep into applyBlockers",
    contentJs.includes("applyMembersOnlySweep(membersOnlyActive)"));
}

// ----- 3b. applyMembersOnlySweep logic (mirror of content.js) ---------------
// Badges are the new-DOM <badge-shape> hosts. A text badge carries its label in
// textContent (.ytBadgeShapeText child); an icon badge carries it in aria-label.
function makeBadge(opts) {
  opts = opts || {};
  return {
    textContent: opts.text || "",
    getAttribute(n) { return n === "aria-label" ? (opts.aria || null) : null; },
  };
}
function makeLockup(badges) {
  return {
    tagName: "YT-LOCKUP-VIEW-MODEL",
    _attrs: {},
    _badges: (badges || []).map(makeBadge),
    querySelectorAll() { return this._badges; },  // stands in for the badge-host query
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    removeAttribute(n) { delete this._attrs[n]; },
  };
}
function runMembersSweep(active, paid, lockups) {
  if (!active) {
    lockups.filter((l) => l.getAttribute("data-cf-members-only") === "1")
      .forEach((l) => l.removeAttribute("data-cf-members-only"));
    return;
  }
  if (!paid) return;
  lockups.forEach((lk) => {
    const badges = lk.querySelectorAll("badge-shape, .ytBadgeShapeText");
    let isMembers = false;
    for (const b of badges) {
      const label = (((b.getAttribute && b.getAttribute("aria-label")) || "") +
        " " + (b.textContent || "")).toLowerCase();
      if (label.indexOf("members only") !== -1) { isMembers = true; break; }
    }
    if (isMembers) {
      if (lk.getAttribute("data-cf-members-only") !== "1") lk.setAttribute("data-cf-members-only", "1");
    } else if (lk.getAttribute("data-cf-members-only") === "1") {
      lk.removeAttribute("data-cf-members-only");
    }
  });
}
{
  const membersText = makeLockup([{ text: "Members only" }]);          // text badge
  const membersCaps = makeLockup([{ text: "MEMBERS ONLY" }]);          // case-insensitive
  const membersAria = makeLockup([{ aria: "Members only", text: "" }]); // icon badge (aria-label)
  const fourK = makeLockup([{ text: "4K" }]);
  const durationOnly = makeLockup([{ text: "11:54" }]);  // over-match: card whose TITLE might say "members only" isn't scanned — only badges are
  const noBadge = makeLockup([]);
  const dom = [membersText, membersCaps, membersAria, fourK, durationOnly, noBadge];
  runMembersSweep(true, true, dom);
  assertEq("3b) text-badge 'Members only' tagged", membersText.getAttribute("data-cf-members-only"), "1");
  assertEq("3b) 'MEMBERS ONLY' (case-insensitive) tagged", membersCaps.getAttribute("data-cf-members-only"), "1");
  assertEq("3b) icon-badge aria-label 'Members only' tagged", membersAria.getAttribute("data-cf-members-only"), "1");
  assertEq("3b) '4K' badge NOT tagged (over-match guard)", fourK.getAttribute("data-cf-members-only"), null);
  assertEq("3b) duration-only card NOT tagged (badges scanned, not title)", durationOnly.getAttribute("data-cf-members-only"), null);
  assertEq("3b) no-badge lockup NOT tagged", noBadge.getAttribute("data-cf-members-only"), null);

  // Free user → no-op.
  const freeLk = makeLockup([{ text: "Members only" }]);
  runMembersSweep(true, /* paid */ false, [freeLk]);
  assertEq("3b) free user -> members sweep is no-op", freeLk.getAttribute("data-cf-members-only"), null);

  // Idempotent across many MutationObserver ticks.
  const idem = makeLockup([{ text: "Members only" }]);
  for (let i = 0; i < 50; i++) runMembersSweep(true, true, [idem]);
  assertEq("3b) idempotent 50x -> tagged once", idem.getAttribute("data-cf-members-only"), "1");

  // Toggle off untags everything previously tagged.
  runMembersSweep(false, true, dom);
  assertEq("3b) toggle-off untags all",
    dom.filter((l) => l.getAttribute("data-cf-members-only") === "1").length, 0);

  // A badge that later disappears (YT re-render) gets untagged on next sweep.
  const wasMembers = makeLockup([{ text: "Members only" }]);
  runMembersSweep(true, true, [wasMembers]);
  wasMembers._badges = [];   // badge removed on re-render
  runMembersSweep(true, true, [wasMembers]);
  assertEq("3b) badge removed -> untagged on next sweep",
    wasMembers.getAttribute("data-cf-members-only"), null);
}

// ==========================================================================
// 4. SUBS-WATCHED — old #progress kept + new progress-bar-view-model detected
// ==========================================================================
{
  const watched = byId["subs-watched"].selectors;
  assertTrue("watched KEEPS old rich-item data-attr selector",
    watched.includes('ytd-browse[page-subtype="subscriptions"] ytd-rich-item-renderer[data-cf-watched="1"]'));
  assertTrue("watched ADDS new-DOM lockup data-attr selector",
    watched.includes('ytd-browse[page-subtype="subscriptions"] yt-lockup-view-model[data-cf-watched="1"]'));
  assertTrue("styles.css hides new-DOM watched lockup",
    css.includes('body.cf-block-subs-watched ytd-browse[page-subtype="subscriptions"] yt-lockup-view-model[data-cf-watched="1"]'));
  assertTrue("content.js detects new progress-bar view-model",
    contentJs.includes("yt-thumbnail-overlay-progress-bar-view-model"));
  assertTrue("content.js keeps old #progress detection",
    contentJs.includes("ytd-thumbnail-overlay-resume-playback-renderer #progress"));
}

// ----- 4b. applyWatchedSweep logic (mirror of content.js, dual detection) ---
const BODY = { tagName: "BODY" };
function el(tagName, opts) {
  opts = opts || {};
  const node = {
    tagName,
    _attrs: opts.style !== undefined ? { style: opts.style } : {},
    parentElement: opts.parent || null,
    _kids: opts.kids || [],
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    removeAttribute(n) { delete this._attrs[n]; },
    querySelectorAll() { return this._kids; },  // stands in for [style] descendant scan
  };
  return node;
}
function readPct(eln) {
  const scan = (node) => {
    const style = (node && node.getAttribute && node.getAttribute("style")) || "";
    const m = style.match(/width\s*:\s*(\d+(?:\.\d+)?)\s*%/);
    return m ? parseFloat(m[1]) : NaN;
  };
  let pct = scan(eln);
  if (isFinite(pct)) return pct;
  const kids = (eln.querySelectorAll && eln.querySelectorAll("[style]")) || [];
  for (const k of kids) { pct = scan(k); if (isFinite(pct)) return pct; }
  return NaN;
}
function tagIfWatched(progressEl) {
  const pct = readPct(progressEl);
  if (!isFinite(pct) || pct <= 95) return;
  let richItem = null, lockup = null, cur = progressEl;
  while (cur && cur !== BODY) {
    if (!richItem && cur.tagName === "YTD-RICH-ITEM-RENDERER") richItem = cur;
    if (!lockup && cur.tagName === "YT-LOCKUP-VIEW-MODEL") lockup = cur;
    cur = cur.parentElement;
  }
  const target = richItem || lockup;
  if (target && target.getAttribute("data-cf-watched") !== "1") target.setAttribute("data-cf-watched", "1");
}
function runWatchedSweep(loc, active, paid, dom) {
  if (!active) {
    dom.cards.filter((c) => c.getAttribute("data-cf-watched") === "1")
      .forEach((c) => c.removeAttribute("data-cf-watched"));
    return;
  }
  if (!paid) return;
  if (loc.pathname.indexOf("/feed/subscriptions") !== 0) return;
  dom.oldBars.forEach(tagIfWatched);
  dom.newBars.forEach(tagIfWatched);
}
const SUBS = { pathname: "/feed/subscriptions" };
{
  // 4b-i. OLD DOM: #progress width 97% on a rich-item card → tagged (unchanged).
  const rOld = el("YTD-RICH-ITEM-RENDERER", { parent: BODY });
  const oldBar = el("DIV", { parent: rOld, style: "width: 97%;" });
  // 4b-ii. NEW DOM in a rich-item wrapper: width on an inner segment → tag rich-item.
  const rNew = el("YTD-RICH-ITEM-RENDERER", { parent: BODY });
  const seg = el("DIV", { style: "width: 98%;" });
  const newBar = el("YT-THUMBNAIL-OVERLAY-PROGRESS-BAR-VIEW-MODEL", { parent: rNew, kids: [seg] });
  // 4b-iii. NEW DOM fully migrated (lockup wrapper, no rich-item) → tag lockup.
  const lk = el("YT-LOCKUP-VIEW-MODEL", { parent: BODY });
  const seg2 = el("DIV", { style: "width: 99%;" });
  const newBar2 = el("YT-THUMBNAIL-OVERLAY-PROGRESS-BAR-VIEW-MODEL", { parent: lk, kids: [seg2] });
  // 4b-iv. Boundary: exactly 95% → NOT tagged.
  const rEdge = el("YTD-RICH-ITEM-RENDERER", { parent: BODY });
  const edgeBar = el("DIV", { parent: rEdge, style: "width: 95%;" });
  // 4b-v. Missing width → skipped, no throw.
  const rNoWidth = el("YTD-RICH-ITEM-RENDERER", { parent: BODY });
  const noWidthBar = el("YT-THUMBNAIL-OVERLAY-PROGRESS-BAR-VIEW-MODEL", { parent: rNoWidth, kids: [el("DIV", {})] });

  const dom = {
    cards: [rOld, rNew, lk, rEdge, rNoWidth],
    oldBars: [oldBar, edgeBar],
    newBars: [newBar, newBar2, noWidthBar],
  };
  runWatchedSweep(SUBS, true, true, dom);
  assertEq("4b-i) OLD #progress 97% -> rich-item tagged", rOld.getAttribute("data-cf-watched"), "1");
  assertEq("4b-ii) NEW bar 98% -> rich-item tagged", rNew.getAttribute("data-cf-watched"), "1");
  assertEq("4b-iii) NEW bar in lockup 99% -> lockup tagged", lk.getAttribute("data-cf-watched"), "1");
  assertEq("4b-iv) exactly 95% -> NOT tagged", rEdge.getAttribute("data-cf-watched"), null);
  assertEq("4b-v) missing width -> NOT tagged", rNoWidth.getAttribute("data-cf-watched"), null);

  // Toggle off untags every wrapper (old + new).
  runWatchedSweep(SUBS, false, true, dom);
  assertEq("4b) toggle-off untags all wrappers",
    dom.cards.filter((c) => c.getAttribute("data-cf-watched") === "1").length, 0);
}
{
  // 4b-vi. PREFERENCE: new bar nested lockup-inside-rich-item → tag the
  // rich-item (existing CSS covers it), NOT the inner lockup.
  const rWrap = el("YTD-RICH-ITEM-RENDERER", { parent: BODY });
  const lkInner = el("YT-LOCKUP-VIEW-MODEL", { parent: rWrap });
  const seg = el("DIV", { style: "width: 97%;" });
  const bar = el("YT-THUMBNAIL-OVERLAY-PROGRESS-BAR-VIEW-MODEL", { parent: lkInner, kids: [seg] });
  const dom = { cards: [rWrap, lkInner], oldBars: [], newBars: [bar] };
  runWatchedSweep(SUBS, true, true, dom);
  assertEq("4b-vi) nested -> prefers rich-item", rWrap.getAttribute("data-cf-watched"), "1");
  assertEq("4b-vi) nested -> inner lockup NOT tagged", lkInner.getAttribute("data-cf-watched"), null);

  // 4b-vii. Free user + wrong page → no-op.
  const rFree = el("YTD-RICH-ITEM-RENDERER", { parent: BODY });
  const barFree = el("DIV", { parent: rFree, style: "width: 99%;" });
  runWatchedSweep(SUBS, true, /* paid */ false, { cards: [rFree], oldBars: [barFree], newBars: [] });
  assertEq("4b-vii) free user -> no-op", rFree.getAttribute("data-cf-watched"), null);
  runWatchedSweep({ pathname: "/watch" }, true, true, { cards: [rFree], oldBars: [barFree], newBars: [] });
  assertEq("4b-vii) wrong page (/watch) -> no-op", rFree.getAttribute("data-cf-watched"), null);
}

// ==========================================================================
// 5. CARD_SELECTOR — content-gated sweeps include the full modern container set
// ==========================================================================
{
  assertTrue("content.js defines CARD_SELECTOR", contentJs.includes("const CARD_SELECTOR"));
  for (const tag of ["yt-lockup-view-model", "ytm-shorts-lockup-view-model-v2", "ytd-reel-item-renderer",
                     "ytd-rich-item-renderer", "ytd-compact-video-renderer", "ytd-video-renderer"]) {
    assertTrue(`CARD_SELECTOR mentions ${tag}`,
      new RegExp("CARD_SELECTOR[\\s\\S]{0,400}" + tag.replace(/[-]/g, "\\-")).test(contentJs));
  }
  // The channel-block + keyword-block sweeps route through CARD_SELECTOR.
  assertEq("content.js uses CARD_SELECTOR at 3 call sites",
    (contentJs.match(/querySelectorAll\(CARD_SELECTOR\)|matches\(CARD_SELECTOR\)/g) || []).length, 3);
}

// ---- summary ------------------------------------------------------------
console.log(`\nNEWDOM EXTENDED: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
