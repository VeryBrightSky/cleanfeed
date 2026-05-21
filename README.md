# CleanFeed for YouTube

A single-purpose Chrome extension that hides the parts of YouTube designed
to keep you scrolling — homepage feed, Shorts, sidebar recommendations,
end-screen suggestions, comments, the Trending / Explore menu, live chat,
and autoplay — so you only see what you intentionally search for.

Manifest V3. Vanilla JavaScript. No build step. No telemetry.

![CleanFeed icon](icons/icon-128.png)

## Changelog

### v1.4.18 — 2026-05-21
- **UI polish: redacted license-key display now shows full 6-group format with X masking.** Pre-v1.4.18 the active-license panel rendered the partial as `ABCD…XYZ2` (first 4 chars, Unicode ellipsis, last 4 chars). v1.4.18 renders it as `ABCD-XXXX-XXXX-XXXX-XXXX-XYZ2` — visually identical character count and layout to a real key, just with the middle four groups masked. The new `_displayPartial(lic)` helper at `options/options.js` always derives the displayed value from `lic.key` (the full stored key we already keep for `/verify`), so what users see is decoupled from whatever's persisted in `key_partial`. v1.4.17 users see the new format the first time they open Options after upgrading; `key_partial` storage is silently rewritten to the new form on that first render (display-only change, no security implication — the full key has always been the source of truth).
- **license-redeem tests**: 47 → 54. New assertions cover the new format (`partialLicense(CANON)` length 29, mask shape `^[A-Z2-9]{4}-XXXX-XXXX-XXXX-XXXX-[A-Z2-9]{4}$`), v1.4.17 legacy ellipsis storage rendering to new form, v1.4.18 fresh redemption idempotency, defensive fallback when full key is missing, and null-license render safety.
- Other suites unchanged: badge-count 12/12, first-install-race 13/13, migration-dryrun 30/30, onToggle-rapid-click 13/13, pause-rapid-click 15/15, show-comments-persist 58/58, stats-no-double-count 7/7.

### v1.4.17 — 2026-05-21
- **License-code redemption (Phase 2 of the licensing system).** The Cloudflare Worker deployed at `https://cleanfeed-license.cleanfeed.workers.dev` issues single-use, install-bound, lifetime Pro license keys; the extension can now redeem them. New "License code" section at the top of the Options page accepts `ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2`-format codes, normalizes (uppercase, strip non-`[A-Z2-9]`), validates against `/^[A-Z2-9]{24}$/`, and POSTs to the Worker's `/redeem` endpoint with `{ key, install_id }`. On success, stores `cleanfeed_license = { active, key, key_partial, redeemed_at }` in `chrome.storage.local` and shows "License active. Pro unlocked." with a redacted `ABCD…XYZ2` key partial.
- **Install ID.** Background service worker now generates a `crypto.randomUUID()` once per profile on `chrome.runtime.onInstalled` / `onStartup` and stores it as `installId` in `chrome.storage.local`. Idempotent + race-tolerant (Options can also lazily ensure it). The ID binds a license to one install — re-redeeming the same key on a second browser gets HTTP 409 from the Worker.
- **Pro state OR logic — single source of truth, zero call-site churn.** `STATE.paid` is read from `chrome.storage.local.paid` in popup, content, and options as before. v1.4.17 promotes `paid` to a *derived* value computed by the new `recomputePaid()` helper in `background.js:113`: `paid = extpayPaid || (cleanfeed_license && cleanfeed_license.active)`. The raw ExtPay signal is now stored under `extpayPaid` (split out from the prior `paid` write). One-time storage migration: existing v1.4.16 users have `paid` but no `extpayPaid`; recomputePaid initializes `extpayPaid` from the current `paid` on first run, so historical ExtPay state is preserved across the upgrade.
- **Periodic re-verification.** On every `onInstalled` and `onStartup`, if `cleanfeed_license.active` is true, the service worker POSTs `{ key, install_id }` to the Worker's `/verify` endpoint. On `{ok:false, reason: ...}` (revoked / wrong_install / not_found) it flips `cleanfeed_license.active = false` and recomputes `paid`. On network error it does nothing — license-paid users must NEVER lose Pro because of a wifi blip. Only the explicit server `ok:false + reason` payload can deactivate a license.
- **New tests/license-redeem.js (47/47).** Pure-logic coverage of: key normalization (whitespace strip, dash strip, lowercase→upper, 0/1 stripped, I/L/O preserved per spec regex), format validation (24-char `[A-Z2-9]`, rejects too short/too long/contains 0 or 1), Pro OR (ExtPay-only / license-only / both / neither), and `/verify` state transitions (active+ok stays active, active+revoked deactivates with reason, active+network-error stays active as fail-open, malformed `ok:false` without reason rejected, inactive license is a no-op, dual-subscribed user stays paid via ExtPay after license revocation).
- Other suites unchanged: badge-count 12/12, first-install-race 13/13, migration-dryrun 30/30, onToggle-rapid-click 13/13, pause-rapid-click 15/15, show-comments-persist 58/58, stats-no-double-count 7/7.

### v1.4.16 — 2026-05-21
- **Added four new CWS locales** for the Tier-1 European/Eurasian markets: `ru` (Russian), `it` (Italian), `pl` (Polish), `tr` (Turkish). Each gets a translated store name + description following the v1.4.8 pattern (anchor: local-language "Block YouTube Shorts" → "Feed & Recommendations" → "Focus Lock"). Twelve `_locales/` folders now: de, en, es, fr, hi, id, **it**, ja, **pl**, pt_BR, **ru**, **tr**. CJK locales (zh_CN, ko) and vi are deferred for paid human translation — out of scope here.
- No code logic changes; manifest version bump and locale files only.

### v1.4.15 — 2026-05-21
- **Fixed v1.4.14 regression: toggling the Comments blocker off then on left the inline reveal sticky.** Repro: Comments blocker ON → click "Show comments" → comments visible (via v1.4.14's inline `display: block !important`) → toggle Comments OFF in popup → toggle back ON → comments stayed visible and the restore button stayed hidden, so the toggle-on appeared to do nothing. Root cause: `applyBlockers()`'s else branch (the path taken when `commentsActive` is false, including the toggle-off case) correctly called `clearCommentsManualReveal()` and removed `cf-comments-shown` from body, but did NOT reset `STATE.commentsManuallyShown`. The visible reveal cleared, but the state flag stayed sticky at `true`; when the blocker was toggled back ON, the true branch read the stale flag and re-applied the inline reveal. v1.4.13's `maybeNavReset()` covered the navigation path (pathname / v= change); v1.4.15 closes the same-page settings-change path by also setting `STATE.commentsManuallyShown = false` in the else branch.
- **New test scenarios in `tests/show-comments-persist.js`**: Q-pre is a regression sentinel proving v1.4.14 fails the toggle-off → toggle-on flow (clears the visible reveal but the stale state flag re-applies on toggle-on). Q validates the v1.4.15 fix end-to-end across the full flow: toggle-on injects button → click reveals → toggle-off clears reveal AND resets state AND removes button → toggle-on re-blocks fresh → click works again. Q-nav and Q-mut are sanity guards that v1.4.13's nav path and v1.4.14's external-body-class-wipe survival both still pass under v1.4.15. 58/58.
- Other suites unchanged: stats-no-double-count 7/7, pause-rapid-click 15/15, onToggle-rapid-click 13/13, badge-count 12/12, migration-dryrun 30/30, first-install-race 13/13.

### v1.4.14 — 2026-05-21
- **Actually fixed the "Show comments" re-hide bug (v1.4.13 was insufficient).** v1.4.13 gated nav-reset on canonical-video-identity and claimed CSS specificity was fine, but real-Chrome testing showed comments still got re-hidden after click. Root cause: the visibility mechanism rode on TWO fragile conditions — (a) the `cf-comments-shown` body class staying on body, and (b) its CSS rule winning the cascade tie-break against `cf-block-comments`. The MutationObserver in `startObserver()` watches only `childList`+`subtree` on body, NOT attribute mutations, so when an external actor (YT's framework, theme toggles, etc.) modifies `body.className` in a way that drops `cf-comments-shown`, our re-apply never fires until the next subtree mutation. Between the wipe and the next mutation (potentially many seconds on an idle user) the body has `cf-block-comments` unopposed and the comments are persistently hidden. v1.4.14 bypasses the body-class mechanism for visibility entirely — `applyCommentsManualReveal()` sets inline `display: block !important` directly on each comments element (`ytd-comments#comments`, `#comments.ytd-watch-flexy`, `ytd-comments-header-renderer`). Inline `!important` is the TOP of the CSS cascade and beats every author stylesheet rule regardless of specificity, source order, or body-class wipes. Re-applied on every `applyBlockers()` tick so YT replacing the `ytd-comments` element doesn't lose the reveal. The body class stays for hiding the restore button via CSS (no cascade tie-break risk there).
- **Updated `tests/show-comments-persist.js`** to model the actual v1.4.13 failure mode (the previous test passed against a broken v1.4.13 because its body-classList shim was Set-backed and nothing external could touch it — real Chrome has YT's own JS that touches body classes). New scenario J is a regression sentinel that proves v1.4.13 dies on external body-class wipe. New scenarios K–P validate v1.4.14: inline reveal survives wipe (K), survives YT replacing the `ytd-comments` element (L), clears on real video nav (M), survives spurious nav events (N), respects blocker-off state (O), and only touches elements we tagged (P). 36/36 pass.
- Other suites unchanged: stats-no-double-count 7/7, pause-rapid-click 15/15, onToggle-rapid-click 13/13, badge-count 12/12, migration-dryrun 30/30, first-install-race 13/13.

### v1.4.13 — 2026-05-18
- **Actually fixed the "Show comments" re-hide bug (v1.4.12 was insufficient).** v1.4.12 added `STATE.commentsManuallyShown` so `applyBlockers()` wouldn't strip `cf-comments-shown` on MutationObserver re-runs — that part worked, but the reveal still died. Real-Chrome testing showed comments still got re-hidden after click. Root cause: `watchSPANavigation()` reset the state on EVERY `yt-navigate-finish` AND on ANY `location.href` change. Both triggers fire for non-video-change events on the same /watch page — YT internal page-state transitions fire `yt-navigate-finish`, and YT auto-adds `&t=<timestamp>` to the URL when the user clicks a chapter, scrubs the timeline, or clicks a timestamp link. v1.4.13 introduces `_navIdentity()` (`pathname + ?v=`) and gates the reset behind an actual canonical-video-identity change. Spurious `yt-navigate-finish` while still on the same video, and URL changes that are just `&t=` on the same `v=`, are now no-ops for state.
- **Updated `tests/show-comments-persist.js`** to model the actual failure mode (the previous test passed against a broken v1.4.12 because it only mocked clean navigation). New scenarios: spurious `yt-navigate-finish` on same video → reveal preserved; URL change adding `&t=` → reveal preserved; real `v=` change → reveal resets; pathname change off /watch → reveal resets. 17/17 pass.
- Other suites unchanged: stats-no-double-count 7/7, pause-rapid-click 15/15, onToggle-rapid-click 13/13, badge-count 12/12, migration-dryrun 30/30, first-install-race 13/13.

### v1.4.12 — 2026-05-18
- **Fixed "Show comments" button flicker on YouTube watch pages.** Pre-v1.4.12, `applyBlockers()` unconditionally stripped the `cf-comments-shown` body class at the top of every call. The MutationObserver re-fires `applyBlockers()` ~100ms after any YouTube DOM mutation (very frequent on watch pages — player ticks, comments lazy-loading, related-videos refresh, etc.), so clicking "Show comments" revealed comments for ≤100ms before they re-hid and the button reappeared. The reveal is now persisted in `STATE.commentsManuallyShown` and reset only on actual YouTube navigation (`yt-navigate-finish` or URL change), so the user's choice survives DOM mutations within a single watch-page view.
- **Fixed inflated session-stats counter.** `countBlockedElements()` ADDED the current `querySelectorAll` match count to `STATE.counts.total` on every `applyBlockers()` tick, so the same DOM elements were re-counted on every observer fire. After a few minutes of normal browsing the popup's "elements blocked this session" stat ballooned to 5–6 digits. A module-level `WeakSet` now dedupes counted elements across ticks; new elements that appear later (infinite-scroll) still count once. Conceptual meaning of the stat is unchanged — it remains a cumulative count of elements blocked this session, just without double-counting.
- **New tests:** `tests/show-comments-persist.js` (16/16 pass) — manual reveal survives 10+ simulated `applyBlockers()` re-runs and resets on nav. `tests/stats-no-double-count.js` (7/7 pass) — 100 ticks on 10 stable elements = 10 counted (not 1000); new elements still count; overlapping selectors don't double-count. Other suites unchanged: pause-rapid-click 15/15, onToggle-rapid-click 13/13, badge-count 12/12, migration-dryrun 30/30, first-install-race 13/13.

### v1.4.11 — 2026-05-17
- **Fixed toolbar badge active-blocker count for v1.4.0 free blockers.** `background.js:350` hardcoded `FREE_IDS = ["home-feed", "shorts"]` — a stale 2-key subset from v1.0. v1.4.0 added two more free-tier blockers (`merch-shelf`, `breaking-news`), but the badge counter wasn't updated, so a free user enabling Merch shelf + Breaking news saw an empty badge instead of "2". Same family of defect as v1.4.10's `resetAll` fix (4.3). `FREE_IDS` now lists all four canonical free-tier ids, with a comment requiring sync with `content/blockers.js`.
- **New test:** `tests/badge-count.js` covers Pro full-count, free-tier subset, license-downgrade edge cases, and the FREE_LIMIT=2 cap (12/12 pass). Other suites unchanged: pause-rapid-click 15/15, onToggle-rapid-click 13/13, migration-dryrun 30/30, first-install-race 13/13.

### v1.4.10 — 2026-05-17
- **`onToggle` re-entrance lock (audit finding 1.1).** Blocker-toggle checkboxes now use the same in-flight lock pattern that v1.4.9 added to `togglePause`: a module-level `onToggleInFlight` flag + `inputEl.disabled = true` during the storage write, with `try/finally` to re-enable. Rapid checkbox clicks (and fast cross-toggle clicks) used to fire overlapping async handlers; `renderBlockers()` rebuilt the `<input>` nodes mid-burst and later clicks landed on destroyed inputs. The lock coalesces a burst into a single committed transition and reverts dropped clicks' UI to the committed STATE.
- **Completed `resetAll` defaults (audit finding 4.3).** `options/options.js` `resetAll()` defaults now include all four v1.4.0 blockers (`playables`, `merch-shelf`, `breaking-news`, `mixes-playlists`); the previous 10-key subset relied on content/popup re-defaulting at read time. User-visible behaviour of "Reset All" is unchanged — the canonical defaults block just no longer drifts from `BLOCKERS`.
- **New test:** `tests/onToggle-rapid-click.js` simulates rapid same-toggle and cross-toggle bursts (13/13 pass). Other suites unchanged: pause-rapid-click 15/15, migration-dryrun 30/30, first-install-race 13/13.

### v1.4.9 — 2026-05-17
- **Fixed "Pause for 1 hour" button state corruption on rapid clicks.** Spam-clicking pause used to fire N overlapping async handlers racing on `STATE.pausedUntil` + `chrome.storage.local`, with the popup's own `storage.onChanged` listener clobbering STATE between successive read-modify-write windows. Symptom: after a few rapid clicks the extension would stop hiding videos AND the blocker toggles would stop responding, with no self-recovery. Fix: added an in-flight lock + visible button-disable in `togglePause()` (`popup/popup.js`) that coalesces a click-burst into a single transition; subsequent clicks during the in-flight window are no-ops.
- **Defensive `sanePausedUntil()` clamp** in popup, content script, and background badge updater. Any `pausedUntil` > `now + 1hr + 5min` is treated as corrupted and reset to 0 — fail-OPEN here means fail-CLOSED for the user, so a bad timestamp can never pin the extension paused forever.
- **Background relay now forwards `pausedUntil`** in `cf:settings-changed`. Previously content scripts only learned pause changes via `chrome.storage.onChanged`, which under rapid clicks could arrive out-of-order with the message broadcast. Inline-forwarding keeps content STATE and storage in lock-step.
- **New test:** `tests/pause-rapid-click.js` simulates 10 + 25-click bursts and asserts coalesced state (15/15 pass). Migration dry-run remains 30/30; first-install race remains 13/13.

### v1.4.8 — 2026-05-17
- **SEO-optimized store-facing metadata.** English name + description now lead with the primary search phrase "Block YouTube Shorts" (name 69/75 chars, description 130/132 chars).
- **Localized listings** (`_locales/`): Spanish, French, Portuguese (BR), and German names + descriptions rewritten to lead with the local-language equivalent of "Block YouTube Shorts", all within the 75/132 char limits. Japanese, Hindi, and Indonesian deliberately left at their v1.4.4 strings pending human-translator review — flagged for follow-up.
- **`store-assets/title.txt`** and **`store-assets/short-description.txt`** synced to match the new manifest.

### v1.4.7 — 2026-05-17
- **Fixed stale feature count in README.** "10 independent blockers" → "14 independent blockers"; enumerated list extended with the 4 v1.4.0 additions (Playables, Merch shelf, Breaking news, Mixes & playlists).
- **Fixed "Leave a review" button URL.** `popup.js` `REVIEW_URL` was still the `REPLACE_WITH_FINAL_ID` placeholder; replaced with the canonical Chrome Web Store reviews URL for `mghmfmjlaelbkellppfneocliomiclnn`.

### v1.4.6 — 2026-05-16
- **Fixed first-install service worker readiness race.** On a brand-new
  install, the popup could open and read `chrome.storage.local` before
  background.js's `onInstalled` handler finished seeding defaults.
  Reading empty storage rendered the onboarding view, and the user's
  preset pick was then overwritten by `onInstalled`'s later full-defaults
  write (`onboardingComplete: false` clobbered the user's `true`). The
  popup looked laggy and the user had to close + reopen it 2-3 times
  before it worked. v1.4.3 fixed click-handler attachment latency but
  did not address this separate storage write/read race.
  - `background.js` `onInstalled` now seeds defaults BEFORE opening the
    onboarding tab, awaits the write, then writes a single
    `cf_initialized: true` flag in a separate set.
  - `popup.js` `init()` now `await`s `waitForInitialized()` (a
    short-circuit + `storage.onChanged` wait + 3s safety timeout) before
    `loadState()`. The existing 150ms loading line stays visible during
    the wait.
  - `popup.js` `storage.onChanged` now also handles `onboardingComplete`
    so any future clobber self-recovers without close/reopen.
  - v1.4.3's synchronous handler attachment, `cf:wake` ping, and
    module-top listener registration are preserved untouched.

### v1.4.4 — 2026-05-15
- Chrome Web Store localization — listing now available in English, Spanish, Portuguese (BR), Hindi, French, German, Indonesian, Japanese.

### v1.4.3 — 2026-05-14
- **Fixed cold-start popup unresponsiveness.** On a fresh install (and
  intermittently after the MV3 service worker slept) the popup was
  visible but inert for the first couple of seconds — all click
  handlers were attached *after* `await chrome.storage.local.get(...)`
  inside `init()`. Users had to close and reopen the popup before
  buttons started working. Fixed by splitting init into a synchronous
  `bootstrap()` that attaches every handler before any await, plus a
  `cf:wake` ping that keeps the SW alive during popup render. A thin
  teal progress line appears at the top edge if storage takes >150 ms.
- **Manifest name + description updated for Chrome Web Store SEO.**
  Name now leads with "Hide YouTube Distractions" and lists the
  headline features. Description rewritten to surface "homepage feed,
  Shorts, recommendations, comments" — the queries new users actually
  type. Still under the 132-char short-description limit.

### v1.4.2 — 2026-05-13
- **Pre-mints ExtPay api_key on install + on browser startup**, not
  just on popup open. This kills the 2-10 second freeze the very
  first time a brand-new user clicks "Upgrade — $4.99" before they've
  ever opened the popup.
- Upgrade and login buttons now show "Opening…" immediately on click,
  apply a subtle `.is-busy` pulse, and at 5 seconds swap to
  "Still working… check your browser tabs" so the user knows where
  to look. 8-second safety restore on failure so they can retry.
- Pre-fetches ExtPay api_key on popup open as a second-chance warm-up.
- Fixed upsell modal copy: "10 blockers" → "14 blockers + keyword
  blocking, Pomodoro Focus Lock, per-page rules".
- Fixed `usageCount` integer coercion (now `parseInt(..., 10) || 0`)
  to prevent the review prompt appearing at the wrong time.

### v1.4.1 — 2026-05-13
- Completed per-page rules with full tabbed popup UI. Pro users can
  now configure different blocker settings per YouTube page
  (Homepage / Watch / Subscriptions) with on / off / inherit
  controls per blocker. The storage engine shipped in v1.4.0; this
  release adds the visual interface.

### v1.4.0 — 2026-05-13
- Keyword blocking (Pro) — hide any video whose title contains your
  blocked words
- Onboarding presets — pick "Just no Shorts", "Focused", or "Minimal"
  on first install
- 4 new blockers: Playables, merch shelf, breaking news, mixes &
  algorithmic playlists (14 total now)
- Pomodoro Focus Lock mode (Pro) — cycle through focus / break
  periods with locked blockers during focus
- Per-page rules (Pro) — opt-in storage-driven overrides so different
  pages can have different blocker configurations (tabbed popup UI
  is queued for v1.5.0; the content-script engine is live now)
- Review prompt after 5 popup uses (one-time, dismissible)

### v1.3.5 — 2026-05-13
- Centered the "Upgrade — $4.99" button in the Pro upsell modal.

### v1.3.4 — 2026-05-13
- Fixed "404 API key required" error when clicking Upgrade or
  I already paid. The previous fix opened ExtPay's URL in a tab
  but skipped the SDK's lazy api_key generation. Now we read the
  key from storage, create one ourselves via ExtPay's `/api/new-key`
  endpoint if missing, then build the URL with it before opening
  the tab. `lib/extpay.js` untouched.

### v1.3.3 — 2026-05-13
- Replaced ExtPay's popup-window flow with direct tab opening for
  both Upgrade and "I already paid" actions. The popup approach
  was throwing "Invalid value for bounds" on multi-monitor /
  high-DPI setups and silently breaking the upgrade conversion.
  Opens in a normal new tab now — same checkout, same login,
  zero bounds math. `lib/extpay.js` untouched.

### v1.3.2 — 2026-05-13
- Defensive fallback for ExtPay popup window failures. On rare
  multi-monitor / high-DPI setups, Chrome can reject the small popup
  window ExtPay tries to open ("Invalid value for bounds"), which
  previously caused the Upgrade and Log-in buttons to silently do
  nothing. They now fall back to opening ExtPay's hosted page in a
  regular tab. Same flow, same payment, never silently fails.

### v1.3.1 — 2026-05-13
- Removed the `window.addEventListener("unload", ...)` from the content
  script. YouTube ships a Permissions-Policy that disallows `unload`
  events, which was producing a benign-but-noisy console warning. The
  `pagehide` listener right below it already handles observer cleanup
  for tab close, navigation, and bfcache eviction.

### v1.3.0 — 2026-05-13
- **Pre-launch QA pass.** Comprehensive audit + cleanup for Chrome Web Store submission:
  - Removed unused `activeTab` permission — we never invoke it (everything goes through `host_permissions` + `chrome.tabs.query`). Smaller permission ask = friendlier install prompt + lower rejection risk.
  - Deleted the unreachable `login/` directory (3 files, ~14 KB). Since v1.2.4 the "I already paid" button routes through the official ExtPay SDK directly; the branded form had no inbound callers.
  - Added a `chrome.runtime.lastError` guard around the popup's cached-paid-status read so a sleeping service worker no longer drops the popup into a broken state.
  - Tidied a couple of stale code comments that referenced the removed login flow.

### v1.2.4 — 2026-05-13
- Fixed branded login page — was calling ExtPay API directly without
  auth, causing 404. Now routes through background SW using official
  SDK. The "I already paid" button now opens ExtensionPay's hosted
  email-collection page directly via `extpay.openLoginPage()`; the
  branded `login/login.html` is no longer on the main flow (the
  official SDK exposes no `login(email)` method, so a custom form
  would have nothing to call).

### v1.2.3 — 2026-05-13
- Fixed Focus Lock banner showing on a fresh install. The `.cf-focus-banner`
  CSS rule had `display: grid`, which beat the user-agent
  `[hidden] { display: none }` at equal specificity, so toggling the
  `hidden` attribute did nothing visually. Added an explicit
  `.cf-focus-banner[hidden] { display: none !important; }` rule (same
  pattern already used by `.cf-modal[hidden]`). Also tightened the
  `isFocusLockActive()` check so it explicitly tests `activeUntil` is
  a non-zero, future timestamp.

### v1.2.2 — 2026-05-13
- Fixed Focus Lock emergency bypass button and countdown timer display.

### v1.2.1 — 2026-05-12
- **Fixed: CORS error blocking ExtPay API.** The previous custom client
  hit endpoints (`/api/v1/<id>/users/...`) that ExtensionPay no longer
  serves with permissive CORS headers, so all license checks failed with
  *No 'Access-Control-Allow-Origin' header*. Replaced `lib/extpay.js`
  with the **official ExtensionPay SDK** verbatim (no modifications).
  Every ExtPay call now goes exclusively through `background.js`
  (service worker); popup / options / login / content scripts use
  `chrome.runtime.sendMessage(...)` to ask background, which in turn
  calls the SDK. Added the SDK as a content script on
  `https://extensionpay.com/*` (required by the SDK's `onPaid`
  auto-trigger). No new permissions added beyond the existing scope.

### v1.2.0 — 2026-05-12
- **Blocker #9 — Hide thumbnails** (PRO). Every video thumbnail fades to a
  neutral grey placeholder. Hover any card to peek. Choose what to watch
  by reading titles, not by clickbait imagery.
- **Blocker #10 — Hide subscription algorithm** (PRO). On
  `/feed/subscriptions` the "For you" / "Most relevant" shelves are
  hidden — only your chronological feed remains.
- **Focus Lock** (PRO). Set a 4-digit PIN (stored as a salted SHA-256
  hash via SubtleCrypto, never plaintext). Pick 30 min / 1 h / 2 h /
  until-manual; all blockers force-enable, popup toggles disable. A 60-
  second hold-to-disable button is the ethical safety valve for real
  emergencies; auto-expires without needing the PIN.
- **Daily time tracker** (FREE for everyone). Only counts time when a
  YouTube tab is focused + visible — never background. Today + 7-day +
  rolling-average view in the popup and options page. Last 30 days
  stored as compact `YYYY-MM-DD → seconds` JSON.
- **YouTube Music support**. Same toggles, same blockers — now extend
  to `music.youtube.com` via added host permission + adapted selectors.
- **Right-click "Block this channel"** (PRO). Adds a chrome.contextMenus
  entry on any YouTube page; videos from blocked channels disappear
  from homepage, search, sidebars, and (you'll never see them in)
  recommendations. Manage the list in the options page.

### v1.1.0 — 2026-05-12
- **Custom branded login page** at `login/login.html` — replaces the
  generic ExtPay portal with a CleanFeed-themed magic-link form with
  inline email validation and loading / success / error states.
- **1-hour pause feature** — single button in the popup that temporarily
  disables every blocker, with a live countdown and auto-resume.
- **2 new Pro blockers:**
  - **Live chat** — hides the live-chat panel on streams + premieres.
  - **Autoplay** — auto-disables the autoplay toggle on every watch page.
- **Pro upsell modal** — a slick in-popup modal with backdrop blur
  (graceful CSS fallback) replaces the inline upgrade prompt; ESC and
  outside-click both dismiss it.
- **Visual polish:** popup fade-in, toggle cubic-bezier animation,
  gradient primary CTA, pulsing PRO badges, soft inner glow on active
  toggles, 8px spacing rhythm, button hover lift.
- **Bug fixes:**
  - "I already paid" button now opens our branded login page (was a 404).
  - `openLoginPage()` URL fixed — removed the bogus `/login` subpath
    that ExtensionPay returns 404 for.

### v1.0.0 — 2026-05-12
- Initial release. 6 toggleable blockers; free / Pro tiers; ExtensionPay
  monetization; onboarding; options page; minimap-style stats.

## Features

- **14 independent blockers**, each toggleable on/off:
  1. Homepage recommendation grid
  2. Shorts shelves (homepage, search, left-nav entry)
  3. Sidebar recommendations on watch pages
  4. End-screen video suggestions and pause overlay
  5. Comments section (with an on-demand "show comments" button)
  6. Trending / Explore section in the left nav
  7. Live chat panel on streams + premieres
  8. Autoplay (auto-disables YouTube's autoplay toggle)
  9. Hide thumbnails (replaces every thumbnail with a placeholder)
  10. Hide subscription algorithm shelves
  11. Playables games panel
  12. Merch shelf
  13. Breaking news shelf
  14. Mixes & playlists
- **Focus Lock (Pro)** — PIN-protected lock that force-enables every blocker
  for a chosen duration. 60-second hold-to-disable safety valve.
- **Daily time tracker (free)** — see today / this week / 7-day average.
- **Right-click "Block this channel" (Pro)** — instant blocklist.
- **YouTube Music support** — every blocker works on `music.youtube.com` too.
- **Pause for 1 hour** — bypass every blocker temporarily; auto-resumes.
- **Channel whitelist** — disable all blockers on channels you actively
  want to engage with (Pro).
- **Custom CSS** — power users can write their own hide rules (Pro).
- **Session stats** — count of blocked elements, visible in the popup.
- **Free tier**: any 2 blockers, forever. **Pro tier**: $4.99 one-time
  unlocks all 6 + whitelist + custom CSS.
- **CSS-first hiding** via injected stylesheet — survives YouTube's SPA
  navigation. MutationObserver re-applies after dynamic content loads.
- **Zero analytics. Zero telemetry. No data leaves your browser.**

## Install (developer mode)

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `cleanfeed/` folder.
4. The CleanFeed icon appears in the toolbar. Open YouTube and click it.

## Install (Chrome Web Store)

CleanFeed will be published to the Chrome Web Store after review.
See `SUBMISSION.md` for the upload procedure.

## Controls

| Where           | Action |
| --------------- | ------ |
| Toolbar icon    | Open popup with 6 toggles, session stats, upgrade CTA |
| Right-click → Options | Open Options page (whitelist + custom CSS) |
| First install   | Onboarding tab opens explaining each blocker |
| Watch page      | If comments are blocked, a small **show comments** button appears |

## Architecture

```
cleanfeed/
├── manifest.json              # MV3 manifest, minimal permissions
├── background.js              # service worker: ExtPay, install, badge, routing
├── content/
│   ├── content.js             # MutationObserver, message handling, stats
│   ├── blockers.js            # 6 blocker modules (selectors + tier)
│   └── styles.css             # CSS-first hiding rules
├── popup/                     # popup UI
├── options/                   # advanced settings page
├── onboarding/                # first-install welcome
├── lib/extpay.js              # vendored ExtensionPay client
├── icons/                     # 16/32/48/128 PNGs (procedurally generated)
└── store-assets/              # Chrome Web Store listing copy
```

### How the 6 blockers work

Each blocker is declared in `content/blockers.js`:

```js
{ id: "home-feed", label: "Homepage feed", tier: "free",
  selectors: ['ytd-browse[page-subtype="home"] ytd-rich-grid-renderer', ...] }
```

The content script flips a body class — e.g. `body.cf-block-home-feed`
— and `content/styles.css` maps every body class to `display: none !important`
on the corresponding selectors. This is much faster than removing DOM
nodes one by one and survives YouTube's React-style re-renders.

Selectors prefer **semantic tag names** (`ytd-comments`, `ytd-reel-shelf-renderer`),
**aria-label** / **title** attributes, and **page-subtype** attributes — all
of which YouTube has kept stable for years. We avoid random hashed class
names like `.css-1a2b3c` because they regenerate weekly.

### Performance

- Stylesheet is injected at `document_start` so hiding happens before
  paint — no flash of unfiltered content.
- The MutationObserver is debounced at 100ms. On a busy watch page that
  takes us from ~10 callbacks/sec to ~10/sec max regardless of churn.
- Observers disconnect on `unload` and `pagehide` to prevent leaks
  across SPA navigation.

### Privacy

- **`storage`** for settings (`chrome.storage.local`) — never leaves
  your machine. A copy of toggles + whitelist is mirrored to
  `chrome.storage.sync` so it follows your Chrome profile.
- **`activeTab`** + **host permission for `*://*.youtube.com/*`** — the
  minimum required for the content script. We never request `<all_urls>`
  or `tabs`/`history`.
- ExtensionPay is the only network call we make: it confirms whether
  you've paid. It does not collect personal data; identity is an
  anonymous UUID stored locally. See `PRIVACY.md`.

## Tests

There are no automated tests bundled (Chrome extensions are tested in
the browser). A manual checklist lives in `tests-manual.md`. Quick
smoke pass:

1. Load unpacked → no console errors.
2. Open `youtube.com` → CleanFeed icon's badge shows `2` (two default blockers active).
3. Open the popup → toggles for home-feed and shorts are ON; rest are OFF and locked with **PRO** badge.
4. Toggle "Shorts" off → the Shorts shelves reappear within ~200ms.
5. Open a video → the sidebar related videos panel is visible (Pro feature, not unlocked on free).
6. Click "Upgrade — $4.99" → opens `extensionpay.com/extension/cleanfeed2342` in a new tab.

## License

MIT — see `LICENSE`.

## Contributing

Pull requests welcome for selector fixes when YouTube updates. Please
prefer selectors that target **semantic tag names, aria-labels, and
titles** — not random hashed class names.
