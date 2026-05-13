# v1.3.0 final report

**Goal:** Chrome-Web-Store-ready hardening.
**Status:** ✅ Done. Ship-ready.

## Bug counts

| Severity | Found | Fixed | Deferred |
|---|---|---|---|
| **P0 (ship-blockers)** | 2 | 2 | 0 |
| **P1 (should-fix)** | 3 | 3 | 0 |
| **P2 (nice-to-have)** | 2 | 0 | 2 (see `TODO.md`) |

## Fixes in this release

1. **Removed unused `activeTab` permission** from `manifest.json`. Verified by `grep` it was never referenced. Reduces install-prompt friction and a top CWS-rejection trigger.
2. **Deleted `login/` directory** (3 files, ~14 KB of dead code). Since v1.2.4 the "I already paid" button has routed through the official ExtPay SDK; the branded form had no inbound callers. `build.py` updated to drop it from `INCLUDE_PATHS`.
3. **Added `chrome.runtime.lastError` guard** in `popup/popup.js` → `refreshPaidStatus`. A sleeping service worker no longer breaks the popup; it falls back to cached state.
4. **Tidied stale comments** in `popup/popup.js` and `background.js` that referenced the removed branded login flow.
5. **Version bump** + **README v1.3.0 changelog entry**.

## What I verified is already correct (and did NOT touch)

- ExtPay SDK at `lib/extpay.js` — unmodified, official source (1576 lines)
- All `extpay.*` calls confined to `background.js` — audited via `grep`
- Free-tier 2-blocker cap enforced in both popup UI *and* content script (defense in depth)
- Focus Lock PIN salted + SHA-256 hashed via `SubtleCrypto`
- Time-tracker compact `{YYYY-MM-DD: seconds}`, auto-prunes 30 days
- All selectors in `content/blockers.js` use stable patterns — tag names, ARIA labels, `page-subtype` attributes
- MutationObserver debounced 100 ms, disconnects on `unload`/`pagehide`
- `yt-navigate-finish` event wired for SPA navigation
- No `eval`, `new Function`, remote scripts, `localStorage`, `sessionStorage`
- All `innerHTML` references in remaining files are in comments only
- Modal closes via X / ESC / backdrop click
- Focus banner properly gated on `activeUntil > Date.now()` (v1.2.3 fix)
- Hold-to-unlock button DOM-gated by being inside the banner
- Title 31 chars (< 45 ✓), short-desc 115 chars (< 132 ✓)
- No "Chrome" standalone word anywhere user-visible
- PRIVACY.md has real `Vito Lomonaco` + `vitowebpro@gmail.com`
- docs/index.html has real `VeryBrightSky/cleanfeed` URLs

## Final commit

- **Hash:** see `git log -1 --oneline` after the push at the end of this session
- **Branch:** `main` on <https://github.com/VeryBrightSky/cleanfeed>
- **Zip:** `/home/moffy/workspace/cleanfeed/dist/cleanfeed-v1.3.0.zip` (56.9 KB, 21 files)

## The 5 things to do in the morning before submitting

1. **Load `dist/cleanfeed-v1.3.0.zip` unpacked** (`chrome://extensions` → Developer mode → Load unpacked → pick the unzipped `cleanfeed/` folder). Verify **0 errors** in the service-worker DevTools console and that the popup opens cleanly. Toggle two blockers, confirm they hide elements within ~200ms on `youtube.com`.

2. **Smoke-test the payment loop end-to-end.** Use a Stripe test card on the ExtensionPay dashboard. From the popup: Upgrade → choose-plan tab → pay → return to popup → confirm `FREE` flips to `PRO` and all 10 toggles unlock.

3. **Smoke-test the login loop.** With a known-paid email on another browser profile, click "I already paid" → ExtPay popup opens → enter email → check inbox → click magic link → confirm `paid` flips to `true` on this profile.

4. **Take 4 PNG screenshots** at 1280×800 (specs in `store-assets/promotional-images/README.md`):
   1. popup open on a YouTube watch page
   2. YouTube homepage with feed hidden
   3. watch page with sidebar + end-screen hidden
   4. options page with focus-lock setup visible

5. **Upload to Chrome Web Store.** <https://chromewebstore.google.com/devconsole> → Add new item → upload `cleanfeed-v1.3.0.zip` → paste title / short / long description from `store-assets/` → privacy URL = <https://raw.githubusercontent.com/VeryBrightSky/cleanfeed/main/PRIVACY.md> → Single purpose = "Hide distracting parts of YouTube to help users focus" → Distribution = Free (the $4.99 unlock is in-extension via ExtensionPay) → Submit.

## Deferred work

See `TODO.md` — all cosmetic, no impact on submission. Promotional images (1280×800 screenshots, 440×280 tile, 1400×560 marquee) still need to be produced before the Promotional images section of the listing can be completed.

## Time / budget

- Wall time spent: ~25 minutes of active work
- Tool invocations: ~25 (well under the 50-cap)
- No agents spawned (all changes are local edits — agent overhead wasn't warranted)
