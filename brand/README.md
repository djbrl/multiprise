# Multiprise brand assets

The mark is a French wall socket (*prise*) with a shell prompt `>_` in place of the pin holes: one place where local projects plug in.

The SVG files in this folder are the sources. Everything in `png/` and every copy elsewhere in the repo is generated from them:

```bash
npm run generate:icons
```

Edit an SVG here, run the command, commit the results. Never edit a generated copy directly.

## Which file to use

| Need | File |
| --- | --- |
| macOS app icon (Dock, Finder, `.icns`) | `icon.svg`, a 1024 canvas on Apple's 824 px icon grid, with drop shadow |
| App icon on a dark background or alternate listing | `icon-dark.svg` |
| Favicon, small UI logo next to text | `icon-flat.svg`, a full-bleed squircle with no padding or shadow |
| Social avatars (GitHub, X, Discord), `apple-touch-icon` | `icon-square.svg`, square and full-bleed; the platform crops it |
| One-color mark (menu bar, watermarks, print) | `mark.svg` (orange), `mark-ink.svg`, `mark-white.svg` |
| Logo with name, light background | `lockup.svg` |
| Logo with name, dark background | `lockup-white.svg` |
| Name only | `wordmark.svg`, `wordmark-white.svg` |
| Link previews (Open Graph, Twitter/X, GitHub social preview), 1280×640 | `social-card.svg` (dark, default), `social-card-light.svg` |

Rendered PNGs in `png/`: `icon-1024/512/256`, `icon-dark-1024`, `avatar-1024`, `apple-touch-icon` (180), `favicon-32`, `favicon-16`, `lockup`, `lockup-white`, `social-card`, `social-card-light`.

## Generated copies elsewhere in the repo

| Copy | From |
| --- | --- |
| `build/icon.png`, `build/icon.icns` | `icon.svg` |
| `renderer/src/assets/multiprise-icon.svg` (in-app sidebar, README) | `icon.svg` |
| `site/icon.svg` (favicon and nav logo) | `icon-flat.svg` |
| `site/apple-touch-icon.png` | `png/apple-touch-icon.png` |
| `site/og.png`, `.github/social-preview.png` | `png/social-card.png` |

## Color

| Token | Hex | Use |
| --- | --- | --- |
| Orange | `#EA580C` | Mark, accents, "running" state; same as the app's `--live` |
| Orange light | `#FB923C` | Top of gradients |
| Orange deep | `#C2410C` | Bottom of gradients, pressed states |
| Cream | `#FFF7ED` | Socket plate, light surfaces |
| Ink | `#1C1917` | Wordmark on light, prompt strokes |
| Card dark | `#141312` | Social card background |

## Type

The wordmark is **General Sans Semibold** (600), lowercase `multiprise`, tracked −0.03em. It is outlined to paths in every SVG, so no font is needed to use the logo. To set new text in the same face, load it from Fontshare:
`https://api.fontshare.com/v2/css?f[]=general-sans@500,600&display=swap`.

## Rules

- Keep the wordmark lowercase and don't retype it: use the outlined files.
- In the lockup, the mark sits left of the name with a gap of 14/44 of the type size. Don't restack or rescale the parts independently.
- Clear space around the lockup: at least half the mark's height on every side.
- Minimum sizes: app icon 16 px, one-color mark 14 px, lockup 96 px wide.
- On orange backgrounds use `mark-white.svg` / `lockup-white.svg`; never orange on orange.
