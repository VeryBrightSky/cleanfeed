# CleanFeed for YouTube

A single-purpose Chrome extension that hides the parts of YouTube designed
to keep you scrolling — homepage feed, Shorts, sidebar recommendations,
end-screen suggestions, comments, the Trending / Explore menu, live chat,
and autoplay — so you only see what you intentionally search for.

Manifest V3. Vanilla JavaScript. No build step. No telemetry.

![CleanFeed icon](icons/icon-128.png)

## Changelog

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
