# Deferred work — not ship-blocking

These items were identified during the v1.3.0 QA pass and intentionally
left for a future release. None of them affect Chrome Web Store
submission readiness.

## P2 — cosmetic / polish

- `background.js` top-of-file docstring lists the v1.0–v1.1 message
  handlers; could be refreshed to enumerate the v1.3.0 set
  (`cf:get-user`, `cf:open-payment`, `cf:open-payment-page`,
  `cf:open-login`, `cf:open-extpay-login`, `cf:open-login-page`,
  `cf:get-paid`, `cf:refresh-paid`, `cf:force-refresh-paid`,
  `cf:push-settings`, `cf:track-time`).
- `README.md` features section could explicitly call out "no broad
  permissions" — useful for privacy-conscious users browsing the
  source.
- Promotional images in `store-assets/promotional-images/` are still
  the README'd specs only — actual PNGs (1280×800 screenshots, 440×280
  small tile, 1400×560 marquee) need to be produced before submission.

## Future feature ideas (not in scope for any current sprint)

- Stats dashboard summarising blocked-element counts over time
- Light / dark theme switch
- Keyboard shortcut to pause / unpause
- Multi-PIN profile support for Focus Lock
- Sync time-tracker across devices via `chrome.storage.sync`
- Optional "scheduled focus" — Focus Lock that auto-activates at
  specific times of day

None of the above are needed for the initial Chrome Web Store launch.
