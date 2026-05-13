# Chrome Web Store — Submission Procedure

This document walks you through uploading **`cleanfeed-v1.0.0.zip`**
(found in `dist/`) to the Chrome Web Store. Plan ~30 minutes for the
first submission and 3–5 business days for review.

## Prerequisites

- A **Chrome Web Store Developer account** ($5 one-time signup fee at
  <https://chrome.google.com/webstore/devconsole>).
- The **`dist/cleanfeed-v1.0.0.zip`** file produced by `build.py` (see
  README — already in this repo).
- An **ExtensionPay account** for `cleanfeed2342`:
  - Sign in at <https://extensionpay.com>.
  - Create a new extension. **Use exactly `cleanfeed2342`** as the
    extension id when prompted (this matches what's hardcoded in
    `background.js` and `popup.js`).
  - Set the one-time price to **$4.99**.
  - Copy the publishable key into the ExtensionPay dashboard's Stripe
    settings (Stripe handles the actual card processing).

## Step 1 — Verify the build

```bash
unzip -l dist/cleanfeed-v1.0.0.zip
```

You should see:

```
  manifest.json
  background.js
  content/blockers.js
  content/content.js
  content/styles.css
  popup/popup.html
  popup/popup.js
  popup/popup.css
  options/options.html
  options/options.js
  options/options.css
  onboarding/welcome.html
  onboarding/welcome.js
  onboarding/welcome.css
  lib/extpay.js
  icons/icon-16.png
  icons/icon-32.png
  icons/icon-48.png
  icons/icon-128.png
  PRIVACY.md
  LICENSE
```

There should be **no** `node_modules/`, `.git/`, `tests/`, `store-assets/`,
`dist/`, `README.md`, or `SUBMISSION.md` inside the zip — those are
repo-only.

## Step 2 — Test loading the unpacked extension

Before uploading, load the **unzipped** folder once more in a clean
Chrome profile to make sure nothing is broken:

1. `chrome://extensions` → Developer mode → **Load unpacked** → pick
   `cleanfeed/`.
2. Open the Service Worker DevTools (the "service worker" link under
   the CleanFeed card) and verify there are **zero console errors**.
3. Open <https://youtube.com> and check:
   - The CleanFeed toolbar badge says `2`.
   - The homepage feed is hidden; the placeholder text appears.
   - Shorts shelves are hidden.
   - Opening the popup shows the 6 toggles, with the bottom 4 locked
     behind a **PRO** badge.

If any of those fail, fix and re-zip before continuing.

## Step 3 — Upload to the Chrome Web Store

1. Open <https://chrome.google.com/webstore/devconsole>.
2. Click **Add new item** → upload `dist/cleanfeed-v1.0.0.zip`.
3. Wait for the manifest to be parsed. Any manifest errors appear here.
4. Fill in the listing fields:

| Field | Value |
| ----- | ----- |
| **Name** | `CleanFeed — focus on YouTube` (from `store-assets/title.txt`) |
| **Summary** | the contents of `store-assets/short-description.txt` |
| **Description** | the contents of `store-assets/long-description.txt` |
| **Category** | Productivity |
| **Language** | English |
| **Single purpose** | "Hide distracting parts of YouTube to help users focus." |

5. **Privacy practices** tab — declare:
   - Permissions justifications:
     - `storage` → "Store user's blocker toggles and license state locally."
     - `activeTab` → "Send a message to the active YouTube tab when the user flips a toggle."
     - host permission `*://*.youtube.com/*` → "Required to hide YouTube DOM elements."
   - Remote code: **No**.
   - Data collection: **No**.
   - Single purpose: **Yes** (Productivity).
   - Privacy policy URL: paste the contents of `PRIVACY.md` into a
     public Gist or a privacy page on your site, then paste that URL.

6. **Promotional images** — upload from `store-assets/promotional-images/`
   (see the README in that folder for required dimensions):
   - At least one 1280×800 screenshot.
   - Optionally the 440×280 small tile and 1400×560 marquee.

7. **Pricing & distribution** — set to **Free** in the store listing
   (the $4.99 upgrade is handled inside the extension by ExtensionPay,
   not by Google Pay).

8. Click **Submit for review**.

## Step 4 — During review

- Review usually takes 3–5 business days. You'll get email updates.
- If the team flags "broad permissions", point them at the manifest
  — we only request `storage`, `activeTab`, and one host permission.
- If they flag "no privacy policy", make sure the URL you posted is
  publicly reachable and matches the contents of `PRIVACY.md`.
- If they ask about ExtensionPay, the relevant docs:
  <https://extensionpay.com/help> — it's a recognized payment provider
  for Chrome extensions and does not violate store policy.

## Step 5 — Post-publish housekeeping

- Tag the release in git: `git tag v1.0.0 && git push --tags`.
- Bump `version` in `manifest.json` for the next release.
- Monitor reviews / support email — selectors break when YouTube ships
  a redesign; fixing those is the #1 maintenance task.

## Re-building after a fix

```bash
# from repo root
python3 build.py
# produces a fresh dist/cleanfeed-vX.Y.Z.zip from the manifest version
```

The build script:

1. Validates `manifest.json` parses as JSON
2. Validates every icon path in the manifest exists
3. Zips only the files Chrome needs (excludes `tests/`, `store-assets/`,
   `dist/`, `README.md`, `SUBMISSION.md`, and dotfiles)
4. Outputs `dist/cleanfeed-v<manifest.version>.zip`
