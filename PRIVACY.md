# CleanFeed Privacy Policy

**Effective date:** 2026-05-13

## TL;DR

CleanFeed runs entirely in your browser. We do not collect, sell, or transmit
any of your personal information. The only network call the extension makes
is to **ExtensionPay** to verify whether you've purchased the one-time Pro
upgrade — and even that uses an anonymous, locally-generated identifier.

## 1. Who we are

CleanFeed is built by **Vito Lomonaco**, an independent developer.

If anything in this policy is unclear or you'd like to delete data we hold,
please email **vitowebpro@gmail.com**.

## 2. Data we store locally on your device

All of the items below are stored in `chrome.storage.local` (or, where
noted, `chrome.storage.sync`, which is Google's optional Chrome-profile
sync — nothing in there is visible to us).

| What | Why |
|---|---|
| The on/off state of each of the 10 blocker toggles | so the toggles persist between sessions |
| Pause state (an "active until" timestamp) | so the 1-hour pause survives a browser restart |
| Time tracker — `YYYY-MM-DD → seconds spent on YouTube` for the last 30 days | shown in the popup and options; auto-pruned after 30 days |
| Channel blocklist — handles of channels you right-clicked to block | so blocks persist |
| Channel whitelist (Pro feature) | so blockers turn off on channels you choose, persistently; also mirrored to `chrome.storage.sync` so it follows your Chrome profile |
| Custom CSS string (Pro feature) | the rules you typed in the options page |
| Focus Lock PIN — **stored as `SHA-256(salt ‖ pin)` only, plus a 128-bit random salt** | so we can verify the PIN you type without ever storing it in plaintext |
| Focus Lock state (active / inactive, expiry timestamp) | so the lock survives tab switches and browser restarts |
| Cached "paid" boolean — `true` if you've purchased Pro | so the popup is fast and doesn't have to wait for a network round-trip every time |
| An anonymous UUID required by ExtensionPay | identifies your Pro license without you giving us an email |

**None of this data leaves your device** under any normal use. It is wiped
when you uninstall the extension or click "Reset all settings" in options.

## 3. Data sent over the network

CleanFeed makes network calls **only to ExtensionPay** (`extensionpay.com`),
exclusively from the extension's service worker (not from the popup or
the YouTube pages you're viewing). These calls use the official
ExtensionPay SDK and happen in three situations:

1. **Periodic license check.** Once a minute, while the service worker is
   awake, we send your anonymous UUID to `extensionpay.com` and receive
   `paid: true | false`. No browsing data, no YouTube content, nothing
   except the UUID.
2. **You click "Upgrade — $4.99".** A new tab opens at
   `extensionpay.com/extension/cleanfeed2342/choose-plan/pro?api_key=<UUID>`.
   The checkout happens entirely on ExtensionPay's site (and Stripe's,
   for the card form).
3. **You click "I already paid".** Our branded login page calls the
   ExtensionPay SDK, which opens ExtensionPay's hosted login flow in a
   new tab.

If you do purchase or log in, **ExtensionPay** will collect the email
address you provide; **Stripe** will process the payment. Neither of
those is data CleanFeed sees or stores.

## 4. Third-party services

| Service | What for | Their policy |
|---|---|---|
| ExtensionPay | License verification + payment portal | <https://extensionpay.com/privacy> |
| Stripe | Card processing on ExtensionPay's checkout | <https://stripe.com/privacy> |

We have no other third-party scripts, SDKs, ad networks, analytics
trackers, error reporters, A/B test frameworks, or telemetry endpoints.

## 5. Why we ask for each Chrome permission

| Permission | Reason |
|---|---|
| `storage` | To save the local items listed in §2 above. |
| `activeTab` | So the popup can send a message to the currently-active YouTube tab when you flip a toggle. |
| `contextMenus` | To add the right-click *"Block this channel with CleanFeed"* menu item. The menu only appears on YouTube domains. |
| Host: `*://*.youtube.com/*` | So the content script can hide DOM elements on YouTube. |
| Host: `*://music.youtube.com/*` | So the content script can hide DOM elements on YouTube Music. |

We do **not** request `<all_urls>`, `tabs`, `history`, `webRequest`,
`cookies`, `bookmarks`, `downloads`, or any other broad permission.

## 6. What we explicitly do NOT do

- We do **not** collect analytics, telemetry, crash reports, A/B test
  bucketing, or any usage metrics.
- We do **not** load advertising networks, tracking pixels, or any
  third-party JavaScript outside the ExtensionPay SDK.
- We do **not** read your browsing history outside YouTube.
- We do **not** read other browser tabs, your search queries, video
  content, comments, or anything you've watched.
- We do **not** send any data to the developer.
- We do **not** sell, rent, or share any data with third parties.

## 7. Data retention

- Locally-stored data persists until you uninstall the extension, click
  "Reset all settings" in the options page, or clear the extension's
  storage in Chrome.
- Time tracker data is **automatically pruned** to the most recent 30
  days on every write.
- The cached "paid" flag is refreshed whenever the service worker polls
  ExtensionPay; if you uninstall, it is gone.
- ExtensionPay retains your license record according to **their** policy;
  see the link in §4.

## 8. Your rights — how to delete your data

- **All local data:** open `chrome://extensions`, click **Remove** next
  to CleanFeed. Chrome wipes the extension's storage on uninstall.
- **Just stats / settings:** open CleanFeed's options page, click
  **Reset all settings** (settings) or **Reset time history** (tracker).
- **Your ExtensionPay record:** because ExtensionPay handles billing
  data on our behalf, deletion requests for that data should be sent
  to ExtensionPay support per their privacy policy linked in §4.

## 9. Children's privacy

CleanFeed is not directed to children under 13, and we do not knowingly
collect personal information from anyone under 13. If you believe a
child has provided information through CleanFeed, contact us at
**vitowebpro@gmail.com** and we will work with you to delete it.

## 10. Changes to this policy

If the way CleanFeed handles data changes meaningfully, this document
will be updated and the **Effective date** at the top will reflect the
change. The latest version is always at the public URL where this
document is hosted.

## 11. Contact

Questions or concerns? Email **vitowebpro@gmail.com**.

---

**Limited Use disclosure.** CleanFeed's use of information received from
any Google API will adhere to the Chrome Web Store User Data Policy,
including the Limited Use requirements.

<!--
TO PUBLISH:
1. Replace Vito Lomonaco with your name or business name
2. Replace vitowebpro@gmail.com with your support contact email
3. Confirm 2026-05-13 matches today
4. Host this file publicly (GitHub raw URL works perfectly)
5. Add the URL to your Chrome Web Store listing
-->
