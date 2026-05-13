# Fresh-install simulation — CleanFeed v1.3.0

Walk-through of five canonical user scenarios. Each step lists the storage
keys that should exist and the UI state the user should see. No browser
was actually run — this is a code-trace audit.

## Scenario 1 — First-time install

1. User clicks **Add to Chrome** → Chrome installs the extension.
2. `chrome.runtime.onInstalled` fires with `details.reason === "install"`.
   - **`background.js:34-65`** opens `onboarding/welcome.html` in a new
     tab and seeds defaults into `chrome.storage.local`.

After install, `chrome.storage.local` contains:

| Key | Initial value |
|---|---|
| `settings` | `{home-feed:true, shorts:true, watch-sidebar:false, end-screen:false, comments:false, explore:false, live-chat:false, autoplay:false, thumbnails:false, subs-algo:false}` |
| `paid` | `false` |
| `whitelistedChannels` | `[]` |
| `customCSS` | `""` |
| `sessionStats` | `{total: 0, perBlocker: {}}` |
| `pausedUntil` | `0` |
| `blockedChannels` | `[]` |
| `focusLock` | `{pinSet: false, activeUntil: 0, pinHash: "", pinSalt: ""}` |
| `timeTracking` | `{}` |

(Mirror to `chrome.storage.sync` for `settings` + `whitelistedChannels`.)

`background.js:66-71` also kicks off `extpay.getUser()` so the cached
`paid` flag is correct from the very first opening of the popup.

User opens popup (`popup/popup.html`):
- **Tier badge** — reads `STATE.paid === false` → shows `FREE`.
- **Stats** — `sessionStats.total === 0` → "0 elements blocked this session".
- **Time-tracker mini-bar** — `timeTracking[today]` undefined → renders "0m" today, "0m" this week.
- **Pause button** — `pausedUntil < now` → "Pause for 1 hour".
- **Focus banner** — `activeUntil === 0` → hidden (v1.2.3 fix ensures the `[hidden]` attribute actually applies).
- **10 toggle rows** — first two on (home-feed + shorts), other eight show `PRO` badge + disabled switch.
- **Upgrade card** — visible (paid:false).
- **Footer** — Options · Help · v1.3.0.

**Action items the user can take:** flip a free toggle, click a Pro toggle (triggers modal), pause, upgrade.

## Scenario 2 — Toggle a free blocker

1. User flips off "Shorts everywhere".
2. `popup.js:onToggle` runs:
   - Not pro-locked, not over free cap → proceeds.
   - `STATE.settings["shorts"] = false`.
   - `chrome.storage.local.set({settings: STATE.settings})` (`popup.js:136`).
   - `pushSettingsToTabs()` → `cf:push-settings` to background → background forwards to every `*.youtube.com` tab.
3. **Content script** receives `cf:settings-changed`, updates STATE, calls `applyBlockers()`. The body class `cf-block-shorts` is removed → Shorts shelves re-appear within ~100ms.
4. **Badge** updates: `background.js:storage.onChanged` → `updateBadge()` → text drops from `2` to `1`.

No race conditions observed. The popup's render and the content-script application both read from the same `chrome.storage.local.settings` key.

## Scenario 3 — Click a PRO-locked toggle

1. User clicks "Sidebar recommendations" toggle.
2. `popup.js:onToggle` runs with `blocker.tier === "pro"` and `STATE.paid === false`.
3. Guard at line ~256: `inputEl.checked = false; openUpsellModal(); return;` — no storage write, no message sent. Toggle visibly snaps back to off.
4. Modal slides up with 4 ticked benefits + Upgrade CTA + "Already paid? Log in" link.
5. **Dismissal paths verified:**
   - X close button → `data-cf-close-modal` → `closeUpsellModal()`
   - Backdrop click → `data-cf-close-modal` → `closeUpsellModal()`
   - `Escape` key → `keydown` listener fires once → `closeUpsellModal()` and listener self-removes

## Scenario 4 — Upgrade → pay → unlock

1. User clicks "Upgrade — $4.99" (popup CTA OR modal CTA).
2. `cf:open-payment` → `background.js:228` → `extpay.openPaymentPage("pro")`.
3. SDK fetches an API key (creating one if necessary) and opens a new tab at `extensionpay.com/extension/cleanfeed2342/choose-plan/pro?api_key=<UUID>`.
4. User completes Stripe checkout. ExtPay redirects to `/paid`.
5. The `lib/extpay.js` content script registered on `extensionpay.com/*` fires `extpay-fetch-user` → background's `extpay.startBackground` listener handles it → calls `poll_user_paid()`.
6. SDK fetches `/api/v2/user`, sees `paid:true`, fires every `paid_callbacks` entry.
7. Our registered `extpay.onPaid` callback (`background.js:20`) writes `paid:true` + `paidAt` to `chrome.storage.local` and broadcasts `cf:paid-changed`.
8. **Badge** flips via `storage.onChanged` → `updateBadge()`.

User re-opens popup:
- `loadState()` reads `paid:true` → tier badge = `PRO`.
- All 10 toggles unlock; modal hidden (`renderUpgrade()`).
- Free-cap guards bypassed; user can switch on as many as they want.

## Scenario 5 — Close and reopen browser next day

1. User quits Chrome.
2. **Persistence:** `chrome.storage.local` survives browser restarts. All keys above remain.
3. Re-launching Chrome:
   - Service worker eventually wakes (lazy in MV3) on any of: action click, content-script message, `chrome.action.onClicked`, `chrome.runtime.onStartup`.
   - `background.js:298` — `_registerContextMenu()` re-runs on SW boot. `removeAll` then `create` is idempotent.
   - `background.js:343` — `updateBadge()` runs at SW boot, restoring `🔒` / `⏸` / number badge from storage.
4. User navigates to YouTube. Content script auto-injects at `document_start`, reads storage, applies hiding rules within a frame or two.
5. Time tracker resumes. Day rollover handled by `background.js:_recordTime`'s date-comparison flush (line 145).

## Edge cases verified

- **Service worker asleep when popup opens:** `cf:get-paid` callback now (v1.3.0 F3 fix) checks `chrome.runtime.lastError` and falls back to cached state — no broken popup.
- **Focus Lock auto-expiry:** popup ticks every 1 s; if `activeUntil <= Date.now()` it resets and re-renders. Background also schedules its own re-badge via `setTimeout(updateBadge, ms)` (background.js:90).
- **Pause auto-resume:** content script has a 30 s interval that clears `pausedUntil` on expiry (content.js).
- **Storage sync mirror failures:** `chrome.storage.sync.set(...).catch(() => {})` everywhere — silent fallback if user has sync disabled.

## Open items (none ship-blocking)

Listed in `TODO.md`. All ship-blockers resolved.
