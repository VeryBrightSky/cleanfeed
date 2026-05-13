# Promotional images — required specs

The Chrome Web Store needs these images. They aren't shipped inside the
extension; they're uploaded separately in the Developer Dashboard.

## Required

| Type | Size | Quantity | Notes |
| ---- | ---- | -------- | ----- |
| Store icon | 128×128 PNG | 1 | Use `icons/icon-128.png` (already in the build) |
| Screenshots | 1280×800 or 640×400 PNG/JPG | 1–5 | At least one is required |

## Strongly recommended

| Type | Size | Quantity | Purpose |
| ---- | ---- | -------- | ------- |
| Small promo tile | 440×280 | 1 | Featured collection cards |
| Marquee promo tile | 1400×560 | 1 | Front-page feature spot |

## Screenshot script (suggested)

Take 4 screenshots after loading the unpacked extension on a fresh
Chrome profile:

1. **The toolbar popup open**, on a YouTube watch page. Show the
   6 toggles, the FREE badge, and 4 Pro lock icons.

2. **The YouTube homepage**, with the homepage-feed blocker on. The
   empty page with the "Use the search bar above" message visible.

3. **A YouTube watch page**, with sidebar-recommendations + end-screen
   blockers on (Pro). The video centered, no rail of related videos
   on the right.

4. **The Options page**, with a couple of channels in the whitelist
   and some custom CSS in the textarea.

Use a clean Chrome profile (no other extensions visible), system dark
mode on, default browser zoom. Crop to exactly 1280×800.

## Promo tile copy

- Small (440×280): headline "Take YouTube back." + the CleanFeed icon
- Marquee (1400×560): tagline from `promotional-text.txt`

Both should use the brand palette:
- Background: `#0c1420` (dark navy) or `#15202e` (slightly lighter)
- Accent: `#3cc8c8` (teal) for the icon glow / underline
- Text: `#e6edf6` (off-white)
