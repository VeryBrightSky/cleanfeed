# CleanFeed for YouTube

A single-purpose Chrome extension that hides the parts of YouTube designed
to keep you scrolling — homepage feed, Shorts, sidebar recommendations,
end-screen suggestions, comments, the Trending / Explore menu, live chat,
and autoplay — so you only see what you intentionally search for.

Manifest V3. Vanilla JavaScript. No build step. No telemetry.

![CleanFeed icon](icons/icon-128.png)

## Changelog

### v1.4.22 — 2026-05-29 (revert subscription pivot — back to $4.99 once, lifetime access; dashboard + grandfather + ExtPay SDK preserved as defensive scaffolding; legacy subscribers auto-grandfathered at no charge; free tier unchanged)
- **Strategic revert.** v1.4.21's pricing pivot from $4.99 lifetime to $1.99/mo or $19.99/yr subscription is rolled back. Competitive context (Unhook 800k installs free, UnTrap $5.99/mo for AI not blocking, DF Tube paid clone failed publicly, 0.8% conversion benchmark, CleanFeed at 58 installs) made subscription wrong for this product at this scale. v1.4.22 returns to the v1.4.20-era $4.99 one-time lifetime model, with all v1.4.21 plumbing kept in place as future-proofing scaffolding.
- **EXTPAY DASHBOARD STATE.** Manual prerequisite (already done by the maintainer): ExtPay's plan dashboard now has ONE plan — **$4.99 USD, Once - Lifetime, URL-friendly name `lifetime`**. The previous `monthly` and `annual` nicknames are DELETED from ExtPay. Calling `extpay.openPaymentPage("monthly")` or `("annual")` at this point would 404; the v1.4.22 background handler coerces all incoming plan values to `lifetime` for that reason (with a console.warn so a stale popup state can be traced).
- **KEPT (defensive scaffolding for future re-pivot).**
  - v1.4.20 `cf_stats` analytics + dashboard (popup mini-card + options 7-day chart + per-blocker breakdown). Real users requested it; nothing to do with pricing.
  - v1.4.21 grandfather logic (`cf_grandfathered`, `ensureGrandfather`, license-key holders + legacy `extpayPaid` users = lifetime Pro forever) — extended with a new `legacy_subscriber` qualifier (below).
  - v1.4.21 `cf_subscription` storage shape — kept as `{status:"none", plan:null, cancelAt:null, lastSyncAt:0}` defaults. The field reads/writes still happen (phase 2's ExtPay sync still runs); it just shouldn't normally observe `"active"` post-v1.4.22. Re-pivoting the pricing model in the future is one prompt away.
  - v1.4.21-fix2 ExtPay multi-plan SDK integration: `lib/extpay.js` is unchanged. `extpay.startBackground()` boot logging + 5 s watchdog + CF_DEBUG per-message logging + `cf:open-payment` SDK primary path with manual fallback — all preserved.
  - All 17 blockers, Focus Lock, Pomodoro, license-key redemption, Cloudflare Worker, every functional surface — unchanged.
- **Popup upgrade card (Case F) — single Get Pro CTA.** Replaces v1.4.21 Phase 3's side-by-side Monthly + Annual cards.
  ```
  ╭─────────────────────────────────────────────╮
  │  Unlock all 17 blockers + Focus Lock        │
  │  $4.99 once · yours forever                 │
  │         [   Get Pro   ]                     │
  │  No subscription. No upsell. No ads.        │
  ╰─────────────────────────────────────────────╯
  Already paid? Log in
  ```
  Click handler: routes through `cf:open-payment` with `plan: "lifetime"` → SDK's `openPaymentPage("lifetime")`. The ⭐ POPULAR badge, "$1.99/month", "$19.99/year", "Save $4", "16% off", "Cancel anytime", "Monthly"/"Annual" strings are GONE from popup.html + popup.js.
- **Popup Case D (cancellation_pending) — Switch to Pro for life.** Legacy subscribers in their cancellation grace period see "Pro ends [date]" + a "Switch to Pro for life" button that routes to the lifetime checkout. Monthly/Annual nicknames are deleted from ExtPay so "Resubscribe to keep Pro" copy no longer makes sense.
- **Popup Cases B / C / E — unchanged code paths.** Active monthly/annual subscribers (the dev profile + any Stripe-webhook-lag users) still see the v1.4.21 Phase 3 "Pro active — Monthly/Annual plan" + "Manage subscription" rendering. They keep Pro through their billing period and drop to free unless grandfathered. past_due (Case E) keeps the "Update payment method" rendering unchanged.
- **Options Subscription card — simplified.** `renderSubscriptionPanel` no longer offers plan-switch CTAs. If `cf_subscription.status ∈ {active, cancellation_pending}`, render the legacy-subscriber notice: "You're subscribed to the legacy monthly/annual plan. CleanFeed has switched to a one-time $4.99 model — you'll keep Pro for your current billing period, and you can switch to lifetime at no extra cost." + a "Switch to lifetime ($0)" button calling the new `cf:legacy-sub-grandfather` message handler. `past_due` keeps "Update payment method" copy. `none` / `canceled` hides the panel entirely. Grandfathered users continue to see the License-code card's "Lifetime Pro · {reason} · Granted [date]" framing (now with a new reason label: `legacy_subscriber` → "legacy subscriber (auto-grandfathered)").
- **Legacy-subscriber grandfather (defensive — likely zero affected users at revert time).** Three additions:
  1. `ensureGrandfather` (`background.js`) now treats `cf_subscription.status ∈ {active, cancellation_pending}` as a third qualifier with `reason = "legacy_subscriber"`. Precedence: `legacy_extpay > legacy_subscriber > license_key`. The precedence reasoning: legacy_extpay users predate every other path; legacy_subscriber paid real money via the subscription before we reverted (most specific historical signal); license_key holders got lifetime by redemption, not by paying a recurring fee.
  2. New `cf:legacy-sub-grandfather` message handler. Confirms status was active/cancellation_pending, calls `ensureGrandfather`, calls `recomputePaid`, returns `{ok:true, granted:true, reason, at}` on success or `{ok:false, error:"not_eligible"}` if status doesn't qualify. Idempotent — calling twice doesn't churn timestamps.
  3. **Auto-grant on v1.4.22 first SW boot.** `ensureGrandfather` runs from `onInstalled` + `onStartup` (since Phase 1). On v1.4.22 first boot, a legacy active/cancellation_pending subscriber gets `cf_grandfathered = true` + `reason = "legacy_subscriber"` automatically, with a `console.log("[CleanFeed] legacy subscriber detected — auto-granting lifetime Pro at no charge.")` for the audit trail. The "Switch to lifetime ($0)" button stays in the options page as user-facing confirmation but is functionally a no-op confirmation toast after auto-grant fires.
- **`cf:open-payment` handler — lifetime-only allowlist.** Coerces any incoming plan value (monthly, annual, "pro", undefined, garbage) to `"lifetime"`. Missing plan defaults silently (intentional no-arg shape); non-lifetime string plans emit `console.warn` with the bad value so stale callers can be traced. v1.4.21-fix2's SDK-primary + manual-fallback dispatch is unchanged — the `via:` response field still tells you which path opened the tab.
- **12-locale `extDescription` rewritten.** All twelve store-listing descriptions now mention "$4.99 once" + "Yours forever" + "No subscription" using each locale's currency convention. `extName` unchanged in every locale (preserves SEO). Per-locale char counts (`extName`/75, `extDescription`/132): en 69/127, de 70/125, es 71/129, fr 70/124, hi 53/130, id 55/131, it 66/125, ja 57/78, pl 68/115, pt_BR 70/130, ru 72/128, tr 74/129. All under limits.
- **Tests.** All 18 v1.4.21-fix2 suites stay green. Three suites updated:
  - `tests/upgrade-card-states.js` (36 → 47, +11): Case F now renders one Get Pro CTA; Case D Resubscribe coerces to lifetime; new section 11 grep-test asserts ZERO residual "$1.99", "$19.99", `"/month"`, `"/year"`, "⭐ POPULAR" strings in `popup/popup.html`, `popup/popup.js`, `options/options.html`, `options/options.js`.
  - `tests/grandfather-migration.js` (41 → 52, +11): legacy_subscriber auto-grandfather on `active` + `cancellation_pending`; `past_due` and `canceled` do NOT auto-grandfather; idempotency on repeat clicks; precedence matrix (extpay > subscriber > license_key).
  - `tests/subscribe-button-flow.js` (58 → 71, +13): Get Pro click sends `plan:"lifetime"`; stale `data-plan="monthly"` still coerces to lifetime in dispatch; legacy `onSubscribeClick` missing-data-plan branch still surfaces; handler builds `/choose-plan/lifetime` URL; monthly/annual/"pro" coerce to lifetime with `console.warn`; missing plan silent default; empty api_key landing-page fallback; chrome.tabs.create throw caught; SW-lifecycle simulation; stubbed-ExtPay fallback; plan-coercion matrix.
  - Grand total: **649 pass / 0 fail** (+35 from v1.4.21-fix2's 614).
- **Anti-scope-creep guarantees.** Cloudflare Worker license-server unchanged. ExtPay SDK (`lib/extpay.js`) unchanged. 17 blocker selectors unchanged. v1.4.20 `cf_stats` counter logic unchanged. v1.4.21-fix2 boot logging + watchdog + per-message log preserved. No new features (scheduling, watch caps, regex blocking, sync, anti-clickbait, homepage redirect, self-healing selectors, settings backup) — those are a separate v1.5.0 conversation.
- **Manifest.** `version: "1.4.21.4" → "1.4.22.0"`. `version_name: "1.4.21-fix2" → "1.4.22"`. Zip: `dist/cleanfeed-v1.4.22.zip`. All 12 `_locales/` folders intact.
- **Diff summary.** `popup/popup.html` (modal: side-by-side cards → single Get Pro CTA), `popup/popup.js` (renderUpgrade Case F: side-by-side cards → single Get Pro card; onSubscribeClick → onGetProClick; modal binding cf-modal-subscribe-* → cf-modal-get-pro; delegated handler keys on data-plan=lifetime / cf-get-pro / cf-resubscribe), `popup/popup.css` (+30 lines: cf-upgrade-price, cf-upgrade-once, cf-upgrade-cta, cf-modal-fine), `background.js` (~25 lines: ensureGrandfather legacy_subscriber qualifier + precedence + auto-grant log; new cf:legacy-sub-grandfather handler; cf:open-payment lifetime-coercion + console.warn), `options/options.js` (renderSubscriptionPanel: plan-switch CTAs → legacy-subscriber notice + Switch-to-lifetime button + _onSwitchToLifetime handler; renderLicensePanel reason map adds legacy_subscriber → "legacy subscriber (auto-grandfathered)"), `_locales/{12 locales}/messages.json` (extDescription only), `manifest.json` (2 lines), `README.md` (this entry), `tests/{upgrade-card-states,grandfather-migration,subscribe-button-flow}.js` (+35 assertions). Zero changes to `content/`, `onboarding/`, `lib/`, `icons/`, `build.py`.
- **Manual repro plan (v1.4.22).**
  1. Extract + load: `mkdir -p ~/cleanfeed-v1422-unpacked && python3 -m zipfile -e ~/workspace/cleanfeed/dist/cleanfeed-v1.4.22.zip ~/cleanfeed-v1422-unpacked/`. Remove old extension + Load unpacked → pick the v1.4.22 folder. Open SW DevTools console; the fix2 boot chain logs should appear (`SW boot start`, `ExtPay constructed`, `extpay.startBackground() returned`, 5 s watchdog).
  2. **Fresh free profile** — popup shows a single `$4.99 once · yours forever` card with one "Get Pro" button. Click it. SW console logs `cf:open-payment rawPlan= lifetime validPlan= lifetime` → `calling extpay.openPaymentPage lifetime` → tab opens to `https://extensionpay.com/extension/cleanfeed2342/choose-plan/lifetime?api_key=…` → Stripe checkout for $4.99 once. Test card `4242 4242 4242 4242`.
  3. **Grandfathered profile (license-key redeemed)** — popup shows Case A "✓ Lifetime Pro active ♥". Options License card shows "Lifetime Pro · license key · Granted [date]". Subscription card hidden.
  4. **Dev profile with `cf_subscription.status="active"`** (legacy from the v1.4.21 Stripe-test purchase) — on v1.4.22 first load, SW console logs `[CleanFeed] legacy subscriber detected — auto-granting lifetime Pro at no charge.` Storage immediately reflects `cf_grandfathered: true`, `cf_grandfathered_reason: "legacy_subscriber"`. Popup re-renders to Case A. Options License card shows "Lifetime Pro · legacy subscriber (auto-grandfathered) · Granted [date]". Options Subscription card now shows the legacy-subscriber notice with a "Switch to lifetime ($0)" button that's effectively a no-op confirmation (grandfather already granted).
  5. **Stale popup hot-reload** — if you reload with a popup still open from a pre-v1.4.22 snapshot that has data-plan="monthly", the click still routes to lifetime. SW console emits `[CleanFeed] cf:open-payment got non-lifetime plan "monthly" — coercing to 'lifetime' (the only configured plan post-v1.4.22).` The tab still opens correctly.

### v1.4.21-fix2 — 2026-05-28 (actually fix Subscribe button — register cf:open-payment handler properly + ensure extpay.startBackground() runs on install (fix1 was incomplete))
- **Ship-blocker continuation.** v1.4.21-fix1 added popup-side error surfacing but did NOT change the SW-side flow. The user's real-Chrome diagnostic still showed Subscribe doing nothing, with the SW-console reporting "Could not establish connection. Receiving end does not exist." when sending `cf:open-payment` to the SW, and the storage-state check showing the ExtPay api_key + installed_at as empty. fix2 instruments every load-bearing SW init step, routes the payment handler through the SDK's documented multi-plan API, and corrects two diagnostic mistakes from the previous round.
- **Diagnostic clarifications (both important even before fix2's code changes).**
  - **The SDK writes to `chrome.storage.SYNC`, not `local`.** `lib/extpay.js:1258-1273` `get`/`set` helpers try sync first, fall back to local only on error. The correct command to inspect ExtPay state is `chrome.storage.sync.get(['extensionpay_api_key', 'extensionpay_installed_at'], console.log)` — the previous test against `chrome.storage.local` returns empty for keys that live in sync, even when ExtPay is healthy.
  - **`chrome.runtime.sendMessage` from the SW DevTools console does NOT reach the SW's own onMessage listener.** Chrome routes those messages to other extension pages (popup, options, content scripts). With no popup open at test time, "Receiving end does not exist." is normal — it's not proof the handler is broken. The real test is sendMessage from the **popup** DevTools console, which targets the SW.
- **fix2 — instrumented boot (`background.js:13-78`).** New `CF_DEBUG = true` const and `_cflog()` helper that prefix every log with `[CleanFeed]`. SW boot now emits, in order:
  - `SW boot start, manifest version <v>` — first line after the `_cflog` definition.
  - `lib/extpay.js loaded; typeof ExtPay = function` — confirms importScripts succeeded.
  - `ExtPay constructed for id cleanfeed2342` — confirms the constructor didn't throw.
  - `extpay.startBackground() returned` — confirms the SDK's onMessage listener was registered for `extpay-fetch-user` / `extpay-trial-start` / `extpay-extinfo`.
  After 5 s, a watchdog logs the ExtPay state from BOTH stores: `watchdog: chrome.storage.sync ExtPay state = ...` and `watchdog: chrome.storage.local ExtPay state = ...`. If the sync line shows `(empty)` and the local line ALSO shows `(empty)` after 5 s on a fresh install, ExtPay's `extensionpay_installed_at` write inside the constructor failed — almost certainly a `browserPolyfill` initialization issue or a chrome.storage.sync block.
- **fix2 — defensive ExtPay stub.** `background.js:35-50` wraps `ExtPay(EXTPAY_ID)` and `extpay.startBackground()` in try/catch. If either throws (e.g. browserPolyfill missing, manifest permission lockout), `extpay` is replaced with a stub whose `openPaymentPage` / `openLoginPage` return rejected Promises. The rest of the SW boots without throwing on undefined accesses, and the cf:open-payment handler's try/catch surfaces the stub-failure path explicitly to the SW console.
- **fix2 — per-message CF_DEBUG log (`background.js:809`).** Top of the chrome.runtime.onMessage listener now logs `[CleanFeed] onMessage <type> from sender id=<id>`. Clicking Subscribe should produce `[CleanFeed] onMessage cf:open-payment from sender id=<extension-id>` in the SW DevTools console. If you click Subscribe and DON'T see that line, the message never reached the SW (SW suspended without wake, sender context wrong, or background.js syntax-aborted before line 791) — a fundamentally different failure mode than the silent restore we patched in fix1.
- **fix2 — `cf:open-payment` routed through `extpay.openPaymentPage(plan)` (`background.js:927-955`).** PRIMARY PATH is now the SDK's documented multi-plan API. The SDK handles get_key/create_key + chrome.tabs.create internally and writes the api_key to chrome.storage.sync. If the SDK throws (api_key fetch fails, browserPolyfill misbehaves), the handler catches and FALLS BACK to the v1.3.4 manual URL + chrome.tabs.create path. Every branch ends with a sendResponse + a log line. The response includes a `via: "extpay.openPaymentPage" | "manual-fallback"` field so the next diagnostic round can confirm which path opened the tab.
- **Anti-scope-creep guarantees.** Popup, options, content scripts, _locales, onboarding — unchanged. Manifest permissions unchanged. ExtPay SDK (`lib/extpay.js`) unchanged. Cloudflare Worker license-server unchanged. Test inventory unchanged for 17 of 19 suites; `subscribe-button-flow.js` extended; `subscription-sync.js`/`grandfather-migration.js`/etc untouched.
- **Tests extended: `tests/subscribe-button-flow.js` (58/58, +14 from fix1's 44).** New assertions: (19) SW-listener returns true for cf:open-payment + sendResponse fires (proves async response wiring is intact); (20) handler still responds when the primary SDK path throws — fallback path's sendResponse fires with `via=manual-fallback`; (21) ExtPay stub (constructor-threw scenario) still routes to fallback; (22) plan-payload coercion allowlist matrix: "monthly" / "annual" / "pro" / "" / undefined / number / object — every non-monthly/annual input coerces to `null` (no-arg plan-picker URL), never reaches openPaymentPage with an invalid nickname.
- **All 18 existing suites stay green.** Grand total: **614 pass / 0 fail** (+14 from v1.4.21-fix1's 600).
- **Manifest.** `version: "1.4.21.3" → "1.4.21.4"`. `version_name: "1.4.21-fix1" → "1.4.21-fix2"`. Zip: `dist/cleanfeed-v1.4.21-fix2.zip`. All 12 `_locales/` folders intact.
- **Diff summary.** `background.js` (+90/-25: CF_DEBUG + _cflog helper, instrumented boot, ExtPay stub, 5 s watchdog, onMessage entry log, refactored cf:open-payment to use extpay.openPaymentPage as primary with manual fallback), `manifest.json` (2 lines), `README.md` (this entry), `tests/subscribe-button-flow.js` (+ ~170 lines for 14 new assertions). Zero changes to `popup/`, `options/`, `_locales/`, `content/`, `onboarding/`, `lib/`, `icons/`, `build.py`.
- **Manual verification plan (fix2) — CORRECTED diagnostics from fix1.**
  1. Extract + load: `mkdir -p ~/cleanfeed-v1421-fix2-unpacked && python3 -m zipfile -e ~/workspace/cleanfeed/dist/cleanfeed-v1.4.21-fix2.zip ~/cleanfeed-v1421-fix2-unpacked/`. In `chrome://extensions` → Remove old + Load unpacked → pick the fix2 folder.
  2. **Open the SW DevTools console** (chrome://extensions → CleanFeed → "service worker" link). Within ~1 s of load you should see, in order:
     ```
     [CleanFeed] SW boot start, manifest version 1.4.21.4
     [CleanFeed] lib/extpay.js loaded; typeof ExtPay = function
     [CleanFeed] ExtPay constructed for id cleanfeed2342
     [CleanFeed] extpay.startBackground() returned
     ```
     If any of these is MISSING or replaced with `[CleanFeed] ExtPay constructor threw: …`, paste that exact line back — it identifies which part of the SDK loaded broken.
  3. Wait 5 s. Watchdog logs both stores:
     ```
     [CleanFeed] watchdog: chrome.storage.sync ExtPay state = { extensionpay_installed_at: "..." [+ extensionpay_api_key if minted] }
     [CleanFeed] watchdog: chrome.storage.local ExtPay state = (empty)
     ```
     The `extensionpay_installed_at` field in SYNC should be a timestamp. If sync also says `(empty)`, the SDK's constructor's storage write failed.
  4. Open the popup. SW console should log `[CleanFeed] onMessage cf:wake from sender id=<extension-id>` (the popup's wake-ping). If this is missing, the popup→SW channel is broken.
  5. Click Monthly Subscribe. SW console logs:
     ```
     [CleanFeed] onMessage cf:open-payment from sender id=<extension-id>
     [CleanFeed] cf:open-payment plan= monthly validPlan= monthly
     [CleanFeed] calling extpay.openPaymentPage monthly
     [CleanFeed] extpay.openPaymentPage resolved (tab should be open)
     ```
     A new tab opens to `https://extensionpay.com/extension/cleanfeed2342/choose-plan/monthly?api_key=…` → Stripe Monthly checkout. Test card `4242 4242 4242 4242`, any future expiry, any CVC.
  6. **If the SDK path fails**, the SW console shows the fallback path engaging:
     ```
     [CleanFeed] extpay.openPaymentPage threw, falling back to manual URL: Error: ...
     [CleanFeed] fallback opened tab id=<N> url=https://extensionpay.com/extension/cleanfeed2342/choose-plan/monthly?api_key=...
     ```
     A tab still opens — just via the manual chrome.tabs.create path instead. The popup gets `{ok: true, via: "manual-fallback"}`.
  7. **Correct diagnostic command for ExtPay state** (when you want to test from devtools later):
     ```javascript
     chrome.storage.sync.get(['extensionpay_api_key', 'extensionpay_installed_at'], console.log)
     ```
     NOT `chrome.storage.local`. The api_key + installed_at live in `sync`.
  8. **Correct diagnostic command for the message channel**: send the test message from the **popup DevTools console**, not the SW console:
     - Right-click the popup → Inspect → Console tab.
     - Paste: `chrome.runtime.sendMessage({type:'cf:open-payment', plan:'monthly'}, r => console.log('resp:', r, 'lastError:', chrome.runtime.lastError?.message))`
     - Expected: `resp: {ok: true, via: 'extpay.openPaymentPage', plan: 'monthly'} lastError: undefined`
     - If you see `lastError: "Could not establish connection..."`, the SW listener really isn't responding — paste the SW console output for triage.

### v1.4.21-fix1 — 2026-05-28 (fix dead Subscribe button + 14→17 copy + grandfather recompute)
- **Ship-blocker hotfix.** v1.4.21 shipped with the inline Subscribe button (Case F upsell, both Monthly and Annual) silently failing — no tab opened, no console errors anywhere. Diagnosis (jsdom + static trace) confirmed the click chain itself was correct end-to-end; the actual user-visible failure was hidden by a swallowed callback path. fix1 surfaces every failure mode + adds a defensive event-delegation backup + closes two adjacent bugs in the same patch.
- **Root cause (`popup/popup.js:1234` pre-fix).** The `_busyClickWithPayload` callback collapsed three distinct failure modes — `chrome.runtime.lastError` (closed message port), missing response, and `resp.ok === false` — into a single silent `restore()` with no log line. Compounding factor: the STATIC modal Subscribe buttons (`popup/popup.html:140,147`) lacked the `data-plan` attribute, so any click that reached them was silently early-returned by `onSubscribeClick` (the dataset.plan check failed). Compounding factor 2 (architectural fragility): per-button `addEventListener` inside `renderUpgrade` re-attaches on every re-render, which a future re-render race could orphan.
- **fix1 — error surfacing.** Every previously-silent path in `_busyClickWithPayload` and `_busyClick` now calls `console.error` with the failure mode (`lastError.message`, "empty response", or background's `resp.error`) BEFORE restoring the button. `onSubscribeClick` logs when the early-return path triggers (defensive — should be unreachable post-fix). Background `cf:open-payment` handler now logs when plan validation fails (invalid nickname → fallback), when api_key is empty (→ landing-page fallback), and successful tab opens (`console.log` with tab id + url).
- **fix1 — `data-plan` on static modal buttons.** `popup/popup.html:140,147` now carry `data-plan="monthly"` and `data-plan="annual"`. This closes the silent early-return path through the modal Subscribe buttons.
- **fix1 — event delegation on `#cf-upgrade-card`.** New delegated handler attached in `_attachStaticHandlers` catches every Subscribe/Manage/Resubscribe/Update-payment click via `e.target.closest("button, .cf-link")` and routes by `data-plan` or button id. Robust against re-render races. Per-button inline listeners set `e._cfHandled = true` to prevent double-dispatch on the happy path.
- **fix1 — 14 → 17 blocker copy.** Grep across the repo found stale "14 blockers" / "14 toggleable" strings in `popup/popup.js:832` (Case F upsell features line — the same card that says "17 blockers" in the header), `onboarding/welcome.html:114` (first-install Pro features list), `docs/index.html` (hero + Pro tier list), `docs/press.html` (tagline, boilerplate, factsheet), `docs/compare.html` (strengths line). All bumped to 17. The "9 other" / "6 other" sub-counts in press.html were also adjusted to keep the arithmetic correct (12 and 9 respectively). README CHANGELOG history is left intact.
- **fix1 — `recomputePaid` on `cf_grandfathered` + `cf_subscription` changes.** `background.js` `storage.onChanged` listener pre-fix only triggered `recomputePaid` on `cleanfeed_license` / `extpayPaid` changes. If any other path flipped `cf_grandfathered` (options reset, dev override, future feature) the derived `paid` flag would lag. fix1 adds both Phase 1 inputs to the trigger list. `recomputePaid` is idempotent so the extra firing on multi-key changes is harmless.
- **New regression sentinel: `tests/subscribe-button-flow.js` (44/44).** Covers: Monthly/Annual click sends correct `{type:"cf:open-payment", plan}` message; missing-`data-plan` early-return surfaces a `console.error` (zero messages sent — exact ship-blocker scenario); `chrome.runtime.lastError` surfaces with "message port" diagnostic; empty response surfaces; background's `ok:false` surfaces with its error string; synchronous sendMessage throw is caught + logged; background handler builds `/choose-plan/monthly` and `/choose-plan/annual` URLs correctly; missing plan falls back to `/choose-plan` (no nickname) silently (intentional); invalid plan ("lifetime") falls back to `/choose-plan` AND logs the bad nickname; empty api_key falls back to landing-page URL AND logs the cause; `chrome.tabs.create` throw is caught and returns `{ok:false, error}` AND logs the URL for debugging; `cf_grandfathered` change alone triggers `recomputePaid` (no `ensureGrandfather`); `cf_subscription` change alone triggers `recomputePaid`; `cleanfeed_license` change still triggers both `ensureGrandfather` + `recomputePaid` (no pre-fix regression); multi-key change fires both branches (`ensureGrandfather` once, `recomputePaid` twice — harmless); unrelated changes (`settings`) trigger nothing.
- **Tests.** All 18 v1.4.21 suites stay green: badge-count 12, blocker-modes 32, cf-stats-migration-real-chrome 49, first-install-race 13, grandfather-migration 41, homepage-redirect 33, license-redeem 62, migration-dryrun 46, onToggle-rapid-click 13, pause-rapid-click 15, show-comments-persist 58, stats-autoplay-counter 24, stats-blocker-counter 20, stats-no-double-count 7, subs-feed-cleanup 29, subscription-sync 45, upgrade-card-states 36, youtube-music-exempt 21. Grand total: **600 pass / 0 fail** (+44 from v1.4.21's 556).
- **jsdom-backed click simulation.** `/tmp/sub-repro/repro.js` boots `popup.html` + `popup.js` in real jsdom with a chrome.* shim, confirms `renderUpgrade` Case F constructs the inline Subscribe buttons, the click event reaches `onSubscribeClick`, and exactly one `{type:"cf:open-payment", plan:"monthly"}` message is dispatched per click (no double-fire from delegation). Available as a diagnostic if future regressions break the click chain.
- **Manifest.** `version: "1.4.21.2" → "1.4.21.3"`. `version_name: "1.4.21" → "1.4.21-fix1"`. Zip: `dist/cleanfeed-v1.4.21-fix1.zip`. All 12 `_locales/` folders intact.
- **Diff summary.** `popup/popup.js` (~80 lines: error-surfacing in _busyClick/_busyClickWithPayload, delegation handler in _attachStaticHandlers, _cfHandled guards in onSubscribeClick/onResubscribeClick/onManageSubscription/openPayment/openLogin, 14→17 in features line), `popup/popup.html` (data-plan added to modal buttons), `background.js` (~20 lines: error/info logging in cf:open-payment, storage.onChanged extended for cf_grandfathered/cf_subscription), `onboarding/welcome.html` (14→17), `docs/{index,press,compare}.html` (14→17 + arithmetic), `manifest.json` (2 lines), `README.md` (this entry), `tests/subscribe-button-flow.js` (new). Zero changes to `_locales/`, `content/`, `options/`, `lib/`, `icons/`, `build.py`.
- **Manual verification plan (fix1).** Load unpacked from `dist/cleanfeed-v1.4.21-fix1.zip`. Then: (a) Click Monthly Subscribe → SW console logs `[CleanFeed] cf:open-payment opened tab <id> url=https://extensionpay.com/extension/cleanfeed2342/choose-plan/monthly?api_key=...`. A new tab opens to the Stripe Monthly checkout. Confirm with test card `4242 4242 4242 4242`, any future expiry, any CVC. (b) Repeat with Annual → URL switches to `/choose-plan/annual?...`. (c) If the popup still acts dead: open the popup's DevTools console (right-click popup → Inspect). You will now see a specific `[CleanFeed] cf:open-payment failed: ...` error explaining the failure (was previously suppressed). (d) Set `cf_grandfathered: true` via SW DevTools console → confirm `paid` storage key flips to true within ~50ms (was previously delayed until the next license/extpay change). (e) Confirm Case F upsell features line reads "All 17 blockers" (was 14). (f) Confirm onboarding welcome page Pro tier list reads "All 17 blockers unlocked" (was 14).

### v1.4.21 — 2026-05-27 (pricing model pivot from $4.99 lifetime to $1.99/mo or $19.99/yr subscription, analytics dashboard, all 12 locales updated; license-key holders and legacy ExtPay buyers grandfathered as lifetime Pro forever)
- **The user-facing release of the v1.4.21 pricing pivot.** Combines Phases 1 + 2 (backend storage model + subscription sync — see the v1.4.21-phase1 / v1.4.21-phase2 entries below for the plumbing) with Phase 3: popup pricing cards (cases A–F), analytics dashboard in popup + options, License-card "Lifetime Pro" framing for grandfathered users, multi-plan ExtPay handoff via `cf:open-payment` with `msg.plan = "monthly" | "annual"`, and updated store-listing copy in all 12 locales.
- **Pricing pivot, customer-facing.** $4.99 lifetime is retired. New plans: **$1.99/month** or **$19.99/year** (Stripe via ExtPay v3.1+'s multi-plan API). Free tier UNCHANGED — any 2 of 17 blockers, forever, no paywall.
- **Grandfather kindness, forever.** Anyone who EVER redeemed a license key OR was `extpayPaid=true` at any prior version is permanently `cf_grandfathered=true`. Once set, NEVER overwritten — even if their license is later revoked or their old ExtPay record disappears. Subscribers do NOT get grandfathered; their access ends with their subscription.
- **Popup upgrade card (`popup/popup.js` `renderUpgrade`).** Six dispatched states:
  - **A — Lifetime Pro** (`cf_grandfathered=true`): "✓ Lifetime Pro active" + heart glyph. No CTAs.
  - **B — Active monthly** (`status="active"` + `plan="monthly"`): "✓ Pro active — Monthly plan" + "Manage subscription" → ExtPay portal.
  - **C — Active annual** (`status="active"` + `plan="annual"`): same shape, Annual plan label.
  - **D — Cancellation pending** (`status="cancellation_pending"`): "Pro ends [date]" + "Resubscribe to keep Pro" → `cf:open-payment` with the prior plan nickname.
  - **E — Past due** (`status="past_due"`): amber "Card needs updating to keep Pro" + "Update payment method" → ExtPay portal.
  - **F — Free / lapsed** (everything else): side-by-side **Monthly $1.99/mo** + **Annual $19.99/yr ⭐ POPULAR** plan cards, Annual visually pre-selected. Buttons route through `cf:open-payment` with `msg.plan = "monthly" | "annual"`.
- **Defensive seventh case**: `paid=true` but no matching subscription state (the brief window after a license redemption before `ensureGrandfather()` fires) renders as Case A — never the upsell.
- **Popup weekly stats mini-card (`renderWeekStats`).** New section at the top of the popup, visible to free AND Pro alike. Reads `cf_stats` and shows last-7-days totals: `videos blocked`, `time saved` (videos × 4 min midpoint via `CF_AVG_VIDEO_MIN`), and `+ N autoplays avoided` (only when > 0). All-zeros state shows "Browse YouTube to start tracking what you’re saving." instead of three `0/0/0` cells.
- **Options "Your stats" dashboard (`options/options.js` `renderStatsDashboard`).** New panel above Time tracker: (1) inline-SVG 7-day bar chart of total daily blocks (bars sized against the tallest day, hover-tooltip via `<title>`), (2) per-blocker breakdown table for the last 30 days sorted descending, (3) all-time totals line "X videos blocked, Y hours saved, Z autoplay chains avoided." Colors via CSS variables so the chart respects light/dark mode.
- **Options Subscription card (`renderSubscriptionPanel`).** Below the License code panel. Mirrors the popup state logic but with renewal/billing detail and a "Switch plan" link (`cf:open-payment` with the OTHER plan nickname). Hidden entirely when `cf_grandfathered=true` — the existing License code card above is updated to show "Lifetime Pro · {legacy_extpay | license_key} · Granted [date]" instead of the redemption form.
- **Multi-plan handoff (`background.js` `cf:open-payment`).** The message handler now accepts `msg.plan` and validates against the configured nicknames (`"monthly"`, `"annual"`). Invalid or missing plan falls back to the generic `/choose-plan` (ExtPay's plan-picker), matching the SDK's `openPaymentPage()` with no args. Defense against a popup bug accidentally opening arbitrary plan URLs.
- **12-locale store copy updated** (`_locales/{en,de,es,fr,hi,id,it,ja,pl,pt_BR,ru,tr}/messages.json`). Every `extDescription` rewritten to mention "$1.99/mo or $19.99/yr" using locale-appropriate currency conventions (en/ja "$1.99/mo"; de/es/it/pl/pt_BR/ru/tr "$1,99/mo"; fr "1,99 $/mois"; hi keeps "$" + devanagari periods). All under the Chrome Web Store limits (extName ≤75, extDescription ≤132). Char counts per locale: en 69/127, de 70/127, es 71/127, fr 70/128, hi 53/115, id 55/131, it 66/122, ja 57/91, pl 68/117, pt_BR 70/124, ru 72/131, tr 74/124. `extName` is unchanged in every locale (preserves SEO).
- **Anti-scope-creep guarantees.** Cloudflare Worker license-server unchanged. ExtPay SDK (`lib/extpay.js`) unchanged. 17 blocker selectors unchanged. v1.4.20 `cf_stats` counter logic unchanged. The `cf_devmode_force_sub_status` escape hatch from Phase 2 still works (production code never writes it).
- **New tests: `tests/upgrade-card-states.js` (36/36).** Cases A–F dispatch correctness; Case A defensive seventh-case path (paid + no current sub); cancellation_pending preserves prior plan in Resubscribe payload; past_due Update-payment routes through `cf:open-login`; Case F sends exactly 3 buttons with `plan="monthly"` / `plan="annual"` / login; grandfather wins over canceled sub; computeWeekStats sums only last 7 days (ignores out-of-window entries); zero-state predicate; empty/null cf_stats doesn't crash; plan-button payload is always in the `["monthly","annual"]` allowlist.
- **`tests/license-redeem.js` extended (54 → 62).** New Section 7 asserts ensureGrandfather is the source of truth on redemption: fresh redemption locks in `cf_grandfathered=true` + `reason="license_key"`; grandfather survives later license revocation (the kindness invariant); a second redemption against an already-grandfathered profile is idempotent (no `cf_grandfathered_at` churn, no reason overwrite — `legacy_extpay` wins forever).
- **Tests.** All 17 v1.4.21-phase2 suites stay green: badge-count 12, blocker-modes 32, cf-stats-migration-real-chrome 49, first-install-race 13, grandfather-migration 41, homepage-redirect 33, **license-redeem 62** (+8), migration-dryrun 46, onToggle-rapid-click 13, pause-rapid-click 15, show-comments-persist 58, stats-autoplay-counter 24, stats-blocker-counter 20, stats-no-double-count 7, subs-feed-cleanup 29, subscription-sync 45, **upgrade-card-states 36** (new), youtube-music-exempt 21. Grand total: **556 pass / 0 fail** (+44 from v1.4.21-phase2's 512).
- **Manifest.** `version: "1.4.21.1" → "1.4.21.2"`. `version_name: "1.4.21-phase2" → "1.4.21"`. Zip: `dist/cleanfeed-v1.4.21.zip`. All 12 `_locales/` folders intact.
- **Diff summary (Phase 3 only).** `popup/popup.html` (~25 lines: week-stats mount + JS-rendered upgrade-card mount + modal plan picker), `popup/popup.css` (~140 lines: week-stats + plan-row + upgrade-state variants), `popup/popup.js` (~280 lines: STATE additions, renderWeekStats, renderUpgrade six-case dispatcher, _busyClickWithPayload, onSubscribeClick/onResubscribeClick/onManageSubscription, storage.onChanged hooks for cf_subscription/cf_grandfathered/cf_stats), `options/options.html` (Subscription + Your stats panels), `options/options.css` (~60 lines: cf-stats-* + cf-sub-* styles), `options/options.js` (~200 lines: STATE additions, renderSubscriptionPanel, renderStatsDashboard, grandfather framing in renderLicensePanel, message-routed plan-switch + portal opens), `background.js` (~15 lines: `cf:open-payment` accepts msg.plan + validates against the two-nickname allowlist), `_locales/{12 locales}/messages.json` (extDescription only, ~1 line each), `manifest.json` (2 lines), `README.md` (this entry), `tests/upgrade-card-states.js` (new), `tests/license-redeem.js` (+8 assertions).
- **Manual repro plan (Phase 3).** Load unpacked from `dist/cleanfeed-v1.4.21.zip`. Then: (a) brand-new profile — popup shows Case F (side-by-side Monthly/Annual). Click Monthly Subscribe → background opens `/choose-plan/monthly`. Click Annual → `/choose-plan/annual`. (b) Set `cf_devmode_force_sub_status: "active"` + `cf_subscription.plan: "monthly"` via DevTools — popup re-renders to Case B with "Manage subscription". (c) Same with `plan: "annual"` → Case C. (d) Set status to `"cancellation_pending"` with a cancelAt timestamp → Case D shows "Pro ends [date]" + Resubscribe routes to the prior plan. (e) Set status to `"past_due"` → Case E (amber). (f) Set `cf_grandfathered: true` + `cf_grandfathered_reason: "license_key"` + `cf_grandfathered_at: <ISO>` → Case A in popup ("Lifetime Pro active"), Subscription card in options is HIDDEN, License-code card shows "Lifetime Pro · license key · Granted [date]". (g) On a fresh profile after light YouTube browsing, popup's weekly mini-card shows non-zero counts; options "Your stats" shows the 7-day bar chart, per-blocker breakdown, and all-time totals line. (h) Redeem a real license key on v1.4.21 → confirm `chrome.storage.local.get("cf_grandfathered")` flips to true and `cf_grandfathered_reason: "license_key"`. (i) ExtPay test-mode end-to-end: subscribe monthly via Stripe test card `4242 4242 4242 4242`, confirm Case B; cancel via Stripe customer portal, confirm Case D; let the period end (or use `cf_devmode_force_sub_status: "canceled"`) → confirm drop to Case F (free) when NOT grandfathered, stays Case A when grandfathered. (j) Set `cf_devmode_force_sub_status: "past_due"` → confirm Case E + popup amber border. Remove the override → confirm real ExtPay state takes over again.

### v1.4.21-phase2 — 2026-05-27 (ExtPay subscription wiring + 6-hourly periodic sync, backend only, no UI change)
- **Phase 2 of the v1.4.21 pricing pivot.** Backend only — no popup/options/_locales/UI changes. Phase 3 will ship the user-facing pricing cards, dashboard, and 12-locale store-copy updates.
- **ExtPay SDK confirmed v3.1+ compatible.** `lib/extpay.js:1450` exposes `open_payment_page(plan_nickname)` accepting a nickname argument — the multi-plan API. `fetch_user` spreads every server field (including `subscriptionStatus`, `subscriptionCancelAt`, `planNickname`/`plan`) unchanged into the returned user object, so the new sync function can rely on the spec'd field shape. No SDK swap needed.
- **New helper: `syncSubscriptionFromExtPay(prefetchedUser?)` (`background.js`).** Single entry point that translates an ExtPay user payload into `cf_subscription`. State derivation per the documented machine:
  - `user.paid && !user.subscriptionCancelAt` → `"active"`
  - `user.paid && user.subscriptionCancelAt` → `"cancellation_pending"`
  - `user.subscriptionStatus === "past_due"` → `"past_due"` (treated as paid — Stripe 7-day retry grace)
  - `user.subscriptionStatus === "canceled"` → `"canceled"`
  - else → `"none"`
  Also detects legacy one-time-paid users (`paid===true` with neither `subscriptionStatus` nor `subscriptionCancelAt`) and sets `extpayPaid=true` + calls `ensureGrandfather()`. Critically does NOT grandfather monthly/annual subscribers — they get subscription access, not lifetime.
- **Network errors NEVER strip Pro.** If `extpay.getUser()` throws, the sync function exits without touching `cf_subscription`. Last-known state is preserved so a paid user can't lose Pro mid-session from a wifi blip.
- **`syncSubscriptionFromExtPay` called from:** `chrome.runtime.onInstalled`, `chrome.runtime.onStartup`, the existing `extpay.onPaid` listener (replacing its previous behavior — every flow now goes through the unified sync, eliminating the v1.4.17 path that blanket-set `extpayPaid=!!user.paid` and would have stickied subscribers to permanent Pro), the existing `cf:get-user` message handler (popup/options refresh), and a new 6-hourly `chrome.alarms` periodic sync (`cf-extpay-sync`, `periodInMinutes: 360`) so state doesn't drift on long-running Chrome sessions.
- **Test-mode escape hatch: `cf_devmode_force_sub_status`.** If `chrome.storage.local` contains this string key, sync applies it as a `cf_subscription.status` override AFTER the real ExtPay sync. Lets QA simulate canceled/past_due states without touching a real card. Production code never writes this key — it's only set manually via DevTools.
- **Anti-scope-creep guarantees.** Cloudflare Worker license-server, ExtPay SDK (`lib/extpay.js`), 17 blocker selectors, `cf_stats` counter logic, popup, options, content scripts, onboarding, and `_locales/` are all byte-identical to v1.4.21-phase1. The 6-hourly alarm reuses the existing `alarms` permission added in v1.4.0 for Pomodoro.
- **New regression sentinel: `tests/subscription-sync.js` (45/45).** Covers: legacy one-time-paid → extpayPaid=true + grandfathered=true + reason=legacy_extpay; active monthly → status=active + plan=monthly + NOT grandfathered; active annual with cancelAt → cancellation_pending + still paid; past_due → status=past_due + paid=true (grace); canceled + no-grandfather + no-license → drops to free; canceled + license-active → stays paid; network error → cf_subscription unchanged (both paid and free preserved); cf_devmode_force_sub_status override (active→past_due, active→canceled, empty-string ignored); pre-fetched user param skips network round-trip; planNickname wins over plan fallback; fresh free user (no signals) stays status=none; end-to-end compose: new subscriber → cancellation_pending → canceled → drops to free + NOT silently grandfathered.
- **Tests.** All 16 v1.4.21-phase1 suites stay green: badge-count 12, blocker-modes 32, cf-stats-migration-real-chrome 49, first-install-race 13, grandfather-migration 41, homepage-redirect 33, license-redeem 54, migration-dryrun 46, onToggle-rapid-click 13, pause-rapid-click 15, show-comments-persist 58, stats-autoplay-counter 24, stats-blocker-counter 20, stats-no-double-count 7, subs-feed-cleanup 29, youtube-music-exempt 21. Grand total: **512 pass / 0 fail** (+45 from v1.4.21-phase1's 467).
- **Manifest.** `version: "1.4.21.0" → "1.4.21.1"`. `version_name: "1.4.21-phase1" → "1.4.21-phase2"`. Zip: `dist/cleanfeed-v1.4.21-phase2.zip`.
- **Diff summary.** `background.js` (+78 lines: new syncSubscriptionFromExtPay helper, new _ensureExtpaySyncAlarm helper, alarm-listener branch for `cf-extpay-sync`, updated extpay.onPaid + cf:get-user handlers, removed v1.4.17 blanket-extpayPaid write from the second onInstalled listener), `manifest.json` (2 lines), `README.md` (this entry), `tests/subscription-sync.js` (new). Zero changes to `popup/`, `options/`, `content/`, `_locales/`, `onboarding/`, `lib/`, `icons/`, `build.py`.
- **Manual verification plan (Phase 2).** Load unpacked from `dist/cleanfeed-v1.4.21-phase2.zip`. (a) On the SW DevTools console, run `await chrome.storage.local.set({cf_devmode_force_sub_status: "active"}); chrome.alarms.get("cf-extpay-sync", a => console.log(a))` — confirm the alarm exists and is scheduled ~6h out. (b) Force-trigger via `chrome.runtime.reload()` then `chrome.storage.local.get(["cf_subscription"], console.log)` — confirm `cf_subscription.status: "active"` (because of the dev override). (c) Set override to `"past_due"` — confirm `paid: true` (grace state). (d) Set override to `"canceled"` — confirm `paid: false` (assuming no grandfather/license). (e) Remove override (`chrome.storage.local.remove(["cf_devmode_force_sub_status"])`) then reload — confirm real ExtPay state takes over. (f) Confirm popup UI is STILL byte-identical to v1.4.20-beta (Phase 3 brings the user-facing pricing cards).

### v1.4.21-phase1 — 2026-05-27 (subscription storage model + grandfather lock-in, backend only, no UI change)
- **Phase 1 of the v1.4.21 pricing pivot ($4.99 lifetime → $1.99/mo or $19.99/yr subscription).** Backend plumbing only — popup, options page, _locales, and all visible copy are byte-identical to v1.4.20-beta. Phase 2 wires ExtPay subscription sync; Phase 3 ships the UI + dashboard + locale updates.
- **New storage keys** (`background.js` install branch + `_migrateForV140`):
  - `cf_grandfathered` (bool, default false) — permanent lifetime-Pro lock. Once true, NEVER overwritten. Granted exactly once for users who held an active license key OR the legacy one-time-paid ExtPay flag at the moment `ensureGrandfather()` first observes them.
  - `cf_grandfathered_at` (ISO string, default null) — when grandfather was granted.
  - `cf_grandfathered_reason` (string, default null) — `"legacy_extpay" | "license_key" | null`. `legacy_extpay` wins precedence when both qualifiers are present.
  - `cf_subscription` (object, default `{ status:"none", plan:null, cancelAt:null, lastSyncAt:0 }`) — Phase 2 will populate from `extpay.getUser()`. Status values: `"none" | "active" | "cancellation_pending" | "past_due" | "canceled"`.
- **New helper: `ensureGrandfather()`.** Idempotent + race-safe via the same double-read pattern as `ensureCfStats` / `ensureInstallId`. Called from both `chrome.runtime.onInstalled` and `chrome.runtime.onStartup` (so dev-mode reloads + post-update browser launches both lock in qualifying users), and from the `chrome.storage.onChanged` listener on `cleanfeed_license`/`extpayPaid` changes (so a newly-redeemed license key in options.js triggers grandfather lock-in on the spot — no restart needed).
- **`recomputePaid()` rewritten.** New derivation: `paid = cf_grandfathered || subActive || extpayPaid || license.active`, where `subActive = cf_subscription.status ∈ {active, cancellation_pending, past_due}`. `past_due` is intentionally treated as paid (ExtPay's automatic-retry grace window — a paid user must NOT lose Pro mid-session while Stripe retries the card). The existing v1.4.16 → v1.4.17 `paid → extpayPaid` migration is preserved exactly.
- **Anti-scope-creep guarantees.** Cloudflare Worker license-server untouched. License keys remain valid forever and grant lifetime Pro on redemption (past, present, future). The 14 (now 17) blocker selectors, v1.4.20 `cf_stats` counter logic, ExtPay SDK (`lib/extpay.js`), and every existing test invariant are unchanged. The new `ensureGrandfather` only ADDS a write path for qualifying users; for free / non-grandfathered users it is a no-op read.
- **New regression sentinel: `tests/grandfather-migration.js` (41/41).** Covers: ensureGrandfather no-op for empty/free storage; grant on active license (reason=license_key); grant on legacy extpayPaid (reason=legacy_extpay); both qualifiers present → extpay wins precedence; idempotency across 3 sequential calls (cf_grandfathered_at unchanged, exactly one write); concurrent-invocation race-safety (final state consistent); recomputePaid for every documented input matrix (grandfather alone, sub=active, sub=cancellation_pending, sub=past_due, sub=canceled+grandfathered → paid, sub=canceled+NOT-grandfathered → free, sub=canceled+license-active → paid); v1.4.16 legacy migration preserved; missing cf_subscription doesn't crash; end-to-end compose: license redemption → grandfather lock-in → later license revocation → grandfather still true (kindness invariant); end-to-end compose: new subscriber lapses → drops to free (NOT silently grandfathered).
- **Tests.** All 15 v1.4.20-beta suites stay green: badge-count 12, blocker-modes 32, cf-stats-migration-real-chrome 49, first-install-race 13, homepage-redirect 33, license-redeem 54, migration-dryrun 46, onToggle-rapid-click 13, pause-rapid-click 15, show-comments-persist 58, stats-autoplay-counter 24, stats-blocker-counter 20, stats-no-double-count 7, subs-feed-cleanup 29, youtube-music-exempt 21. Grand total: **467 pass / 0 fail** (+41 from v1.4.20-beta's 426).
- **Manifest.** `version: "1.4.20.1" → "1.4.21.0"`. `version_name: "1.4.20-beta" → "1.4.21-phase1"`. Zip: `dist/cleanfeed-v1.4.21-phase1.zip`.
- **Diff summary.** `background.js` (+62 lines: new ensureGrandfather helper, updated recomputePaid, new defaults in install seed + migrator, new ensureGrandfather call in both lifecycle listeners + storage.onChanged), `manifest.json` (2 lines), `README.md` (this entry), `tests/grandfather-migration.js` (new). Zero changes to `popup/`, `options/`, `content/`, `_locales/`, `onboarding/`, `lib/`, `icons/`, `build.py`.
- **Manual verification plan (Phase 1).** Load unpacked from `dist/cleanfeed-v1.4.21-phase1.zip`. (a) On a brand-new profile, confirm `chrome.storage.local.get(null, console.log)` includes `cf_grandfathered: false`, `cf_grandfathered_at: null`, `cf_grandfathered_reason: null`, `cf_subscription: { status:"none", plan:null, cancelAt:null, lastSyncAt:0 }`. (b) On a profile that has a previously-redeemed license key, confirm `cf_grandfathered: true` and `cf_grandfathered_reason: "license_key"`. (c) On a profile with legacy `extpayPaid: true`, confirm `cf_grandfathered: true` and `cf_grandfathered_reason: "legacy_extpay"`. (d) Open the popup — it must be byte-identical to v1.4.20-beta (same upsell card, same blocker grid, same upgrade button text). The pricing pivot copy + dashboard arrive in Phase 3.

### v1.4.20-beta — 2026-05-27 (Phase 1 hotfix: cf_stats migration not firing on real Chrome installs)
- **Fixed v1.4.20-alpha bug: `cf_stats` key never seeded in real Chrome.** The user reported that after loading `dist/cleanfeed-v1.4.20-alpha.zip` unpacked, `chrome.storage.local.get(null, …)` returned 22 keys without `cf_stats`. Synthetic tests passed 377/377 because the migration-dryrun test invoked `_migrateForV140` directly, bypassing the listener-dispatch layer that's actually the broken thing in real Chrome.
- **Root cause** (`background.js:_migrateForV140:364-367`): the cf_stats seed was inside the `else if (details.reason === "update")` branch of the second `onInstalled` listener (`background.js:300-308`), invoked from exactly one call site. It was NOT called from `onStartup` (lines 196-202) and NOT called when `onInstalled` fired with any other `details.reason` value — including the dev-mode reload-from-unpacked path, which doesn't reliably fire `onInstalled` with a matching `reason`. The same scenario didn't break `installId` because `ensureInstallId` was already called from BOTH `onInstalled` and `onStartup` at the top level with no reason-gate (`background.js:192,199`).
- **Fix:** new standalone `ensureCfStats()` function (`background.js:111-130`), modeled on `ensureInstallId`'s race-tolerant get→re-check→set shape. Called unconditionally from both lifecycle listeners (`background.js:194,205`). On any `onInstalled` (regardless of `reason`) and on every `onStartup` (browser launch), the seed fires once if cf_stats is absent and no-ops otherwise. The existing `_migrateForV140` cf_stats branch is left in place as defense in depth for the production `onInstalled.update` path.
- **New regression sentinel: `tests/cf-stats-migration-real-chrome.js` (49/49).** Reproduces the user's exact 22-key storage state, runs `ensureCfStats`, asserts cf_stats is now present with correct shape AND none of the other 22 keys were touched. Covers: idempotency across 3 re-runs (`session_started` and counters preserved); empty-storage new-install seeding; concurrent-invocation race (two simultaneous calls converge to one value); pre-seeded storage produces zero writes (defended via an instrumented `set` counter); malformed `cf_stats=null` re-seeds correctly.
- **Tests.** All 14 v1.4.20-alpha suites stay green; new regression sentinel pushes total to **426 pass / 0 fail** (+49 from v1.4.20-alpha's 377).
- **Manifest.** `version: "1.4.20.0" → "1.4.20.1"`. `version_name: "1.4.20-alpha" → "1.4.20-beta"`. Zip: `dist/cleanfeed-v1.4.20-beta.zip`.
- **Anti-scope-creep.** Zero changes to popup, options, _locales, blocker selectors, ExtPay/licensing helpers, or any prior test behavior. Diff: `background.js` +24 lines (new `ensureCfStats` + two two-line listener calls), `manifest.json` 2 lines, `README.md` (this entry), `tests/cf-stats-migration-real-chrome.js` (new).

### v1.4.20-alpha — 2026-05-27 (Phase 1 of analytics dashboard: instrumentation only, no UI yet)
- **Phase 1 only.** No popup, options, or visible UI changes — `git diff popup/ options/ _locales/` is empty against v1.4.19. This release wires up the data collection so Phase 2 (dashboard rendering) has data to read.
- **New persistent storage: `cf_stats`.** Shape: `{ blocked: { "YYYY-MM-DD": { <blocker-id>: <count> } }, autoplay_avoided: { "YYYY-MM-DD": { videos, estimated_minutes } }, session_started: <ms-epoch> }`. Seeded once at install or first-run migration; **never overwritten** by re-runs of the migrator — Phase 2 can trust the counters keep accumulating.
- **Per-blocker daily counter.** `content/content.js` `countBlockedElements` now maintains a per-blocker `WeakSet` (`_perBlockerCounted`) alongside the existing global `_countedEls`. First time a blocker hides an element, the per-day counter increments by 1; MutationObserver re-fires on the same element don't re-count. Overlapping selectors (rare; one DOM element matched by two blockers) credit each blocker — separate WeakSets, by design. Increments accumulate in an in-memory `_statsDelta` map; a single `setTimeout`-coalesced flush every 30 s commits via `chrome.storage.local.set`. `pagehide` also flushes. Failed writes re-merge the snapshot into the next delta (no data loss).
- **Autoplay counterfactual tracker.** On `/watch` pages, `_captureAutoplayContext()` (called on every `applyBlockers` tick, idempotent per video) captures the FIRST `ytd-compact-video-renderer` in the sidebar (videoId via `href` parse, duration via `ytd-thumbnail-overlay-time-status-renderer #text` parse) plus a snapshot of YT's `.ytp-autonav-toggle-button` `aria-checked` state. A delegated click listener marks `STATE.autoplay.userClickedSidebar = true` if any click lands inside `#secondary` / `ytd-watch-next-secondary-results-renderer` / `ytd-compact-video-renderer`. On SPA-nav off the current `/watch?v=<id>` (caught by `maybeNavReset` BEFORE `lastNav` is overwritten) or on `pagehide` from `/watch`, `_evaluateAutoplayAvoided(prev, new)` decides:
  - skip if no candidate captured
  - skip if autoplay was OFF at capture time (per spec)
  - skip if the user clicked the sidebar
  - skip if destination videoId matches the captured candidate (watched it or auto-progressed)
  - **otherwise**: increment `cf_stats.autoplay_avoided.{videos +1, estimated_minutes += duration_min}`. Duration falls back to 10 minutes if parsing failed (per spec). Defensive race-guard: if `STATE.autoplay.watchVideoId !== prevVideoId` (state was overwritten by a faster nav), skip rather than misattribute.
- **Assumptions explicitly marked in code** (each load-bearing one has an "ASSUMPTION:" comment in `content/content.js`): the first sidebar card IS the autoplay candidate; capture autoplay state at the moment of capture, not at nav-away time; pagehide with no observable destination is treated identically to a non-`/watch` SPA-nav destination.
- **Migration.** `_migrateForV140` now seeds `cf_stats` once with `{ blocked: {}, autoplay_avoided: {}, session_started: Date.now() }`. Existing v1.4.19 users get the seed on the next `onInstalled.reason==="update"`. The migrator is idempotent — re-runs do not overwrite existing counters.
- **Tests.** `tests/stats-blocker-counter.js` (20/20: WeakSet dedupe, day rollover, 30 s coalesced flush, merge-without-clobber against pre-existing storage, failed-flush re-merge). `tests/stats-autoplay-counter.js` (24/24: avoided on subs nav, not-avoided on watching captured-next, sidebar-click guard, autoplay-off guard, race guard, duration parsing for MM:SS / H:MM:SS / single-number / garbage). `tests/migration-dryrun.js` extended with cf_stats seed + idempotency assertions (40 → 46). Grand total: **377 pass / 0 fail**. All 12 v1.4.19 suites stay green: badge-count 12/12, first-install-race 13/13, license-redeem 54/54, onToggle-rapid-click 13/13, pause-rapid-click 15/15, show-comments-persist 58/58, stats-no-double-count 7/7, blocker-modes 32/32, homepage-redirect 33/33, subs-feed-cleanup 29/29, youtube-music-exempt 21/21.
- **Manifest.** Chrome's `version` field requires numeric segments only, so the release is recorded as `version: "1.4.20.0"` with display label `version_name: "1.4.20-alpha"`. `build.py` now prefers `version_name` when constructing the dist zip filename (`dist/cleanfeed-v1.4.20-alpha.zip`).
- **Anti-scope-creep.** Zero changes to `popup/`, `options/`, `_locales/`, the 17 blocker selectors, ExtPay / licensing helpers, or any pre-existing test behavior (existing suite line counts unchanged; migration-dryrun grew by additive assertions only).

### v1.4.19 — 2026-05-25
- **YouTube Music smart exemption (Free).** CleanFeed now no-ops completely on `music.youtube.com` — `content.js`'s IIFE returns immediately if `location.hostname` matches `music.youtube.com` or any subdomain, so no `applyBlockers`, no MutationObserver, no time tracker, no body classes, no badge counting, and no custom CSS injection happens on that host. The popup also detects the active tab and renders a single explainer panel ("CleanFeed is paused on YouTube Music") in place of the toggle grid + upgrade card. Detection is pure hostname match — no extra permissions.
- **Homepage → Subscriptions redirect (Free, opt-in toggle, default OFF).** New "Open YouTube on Subscriptions" row above the blocker grid. When ON, bare `youtube.com/` (including tracking-only query strings like `?utm_source=*`, `?gclid=*`) auto-redirects to `youtube.com/feed/subscriptions` via `location.replace`. Fires on the initial page load and on every `yt-navigate-finish` so SPA navigation back to home is also caught. **Critical scope:** does NOT redirect `/watch`, `/results`, `/channel`, `/@handle`, `/shorts`, `/feed/anything-else`, `/playlist`, or any non-bare path. URLs with an in-app hash route (`#/foo`) are also treated as non-bare.
- **Soft-blur / dim render modes per blocker (Free, expands every blocker).** Each blocker (Pro and Free, 16 of 17 — autoplay is a JS handler with no DOM target) now has a Hide / Blur / Dim dropdown next to its toggle in the popup. New per-blocker setting `blockerModes: { "<id>": "hide" | "blur" | "dim" }` stored in `chrome.storage.local`. **Migration:** unmigrated blockers default to `hide` via `_effectiveModeFor()` — existing users see zero behavior change. Blur mode applies `filter: blur(8px) !important; pointer-events: none !important` with a `:hover` rule that lifts both (peek-then-resume). Dim mode uses `opacity: 0.15` with the same hover-restore. Implementation: `content.js` emits a paired `cf-block-{id}` + `cf-mode-{id}-{mode}` body-class pair; new override rules in `styles.css` win via two-class specificity (0,2,1) over the existing one-class hide rules. `applyCommentsManualReveal` extended to set inline `filter: none !important`, `opacity: 1 !important`, `pointer-events: auto !important` alongside `display: block !important` so the v1.4.15 show-comments flow still reveals cleanly when the Comments blocker is set to Blur or Dim.
- **Three new Pro blockers — subscription-feed cleanup (default OFF, Pro-gated).** Brings the blocker count from 14 → 17.
  - **Hide 'Most Relevant' suggestions** — CSS selector targets `ytd-browse[page-subtype="subscriptions"] ytd-rich-section-renderer:has(yt-formatted-string[title="Most Relevant"|"For you"])` and the corresponding `ytd-rich-shelf-renderer`. Scoped to `/feed/subscriptions` via the page-subtype attribute.
  - **Hide members-only videos** — CSS selector targets `ytd-rich-item-renderer:has(ytd-badge-supported-renderer[aria-label="Members only"])` (plus a fallback `[aria-label*="Members only"]` for badge HTML variations).
  - **Hide already-watched (progress > 95 %)** — JS sweep `applyWatchedSweep()` runs on every `applyBlockers` tick when active; it parses the inline `width: N%` on `ytd-thumbnail-overlay-resume-playback-renderer #progress`, climbs to the parent `ytd-rich-item-renderer`, and tags it with `data-cf-watched="1"` so the matching CSS rule hides it. Scoped to `/feed/subscriptions`, Pro-only, strictly `> 95` (95.0 is NOT hidden).
- **i18n.** New keys for all 12 `_locales/` (`ytMusicPaused*`, `redirectHome*`, `mode{Hide,Blur,Dim}`, `blockerSubs{MostRelevant,MembersOnly,Watched}*`, `upsell{Title,Body,AllBlockers}`). de/es/fr/it/pl/pt_BR/ru/tr translated; hi/id/ja keep new strings English pending translator review (existing pattern). Manifest-level `extName` / `extDescription` "14 blockers" bumped to "17 blockers" in hi/id/ja. `popup.html` upsell copy bumped 14 → 17 in two places.
- **Migration.** `_migrateForV140` extended to seed `subs-most-relevant`, `subs-members-only`, `subs-watched` (all `false`) plus `redirectHomeToSubs: false` and `blockerModes: {}` for existing users without clobbering any pre-existing value. Brand-new installs get the same defaults in the `onInstalled.install` branch.
- **New tests.** `tests/youtube-music-exempt.js` (21/21), `tests/homepage-redirect.js` (33/33), `tests/blocker-modes.js` (32/32), `tests/subs-feed-cleanup.js` (29/29). Existing suites updated for the 14 → 17 blocker count: badge-count 12/12 (now asserts all 17 active → 17, free still capped at 2 with the 3 new Pro blockers correctly excluded), first-install-race 13/13 (seed asserts 17 settings keys), migration-dryrun 30 → 40/40 (new assertions for the 3 new blockers + 2 new top-level keys + the unchanged behavior for existing users). Untouched: license-redeem 54/54, onToggle-rapid-click 13/13, pause-rapid-click 15/15, show-comments-persist 58/58, stats-no-double-count 7/7. Grand total: 327/327.
- **Anti-scope-creep guarantees.** No changes to: ExtPay (`lib/extpay.js`), license redemption (`options/options.js` redeem flow, `background.js` `recomputePaid` / `verifyLicenseIfPresent` / `_ensureExtpayApiKey`), screenshots, or the 14 pre-v1.4.19 blocker selectors. Pro detection (`extpayPaid || cleanfeed_license.active`) is the gate for the 3 new Pro blockers via the existing `effectiveActive()` path in `content.js`.

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

- **17 independent blockers**, each toggleable on/off, each with a Hide / Blur / Dim render mode:
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
  15. Hide 'Most Relevant' suggestions on /feed/subscriptions (v1.4.19, Pro)
  16. Hide members-only videos (v1.4.19, Pro)
  17. Hide already-watched videos (progress > 95 %) (v1.4.19, Pro)
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
