# Site (Multiprise landing page)

One static file, `index.html`. No build step. Preview with `python3 -m http.server 4321 -d site`.

**To update, edit only the `SITE` object at the top of the `<script>` in `index.html`:**
- `links.download`: the public DMG URL. While it is `null`, every Download button is greyed out and the page says "Download available soon". Only set it once the URL works for a logged-out visitor (the GitHub repo and release are private today).
- `links.repo`: the public GitHub repo. The GitHub links stay hidden while it is `null`.
- `version`, `requirements`, `license`: shown under the closing Download button and in the footer.

**Design:** light, Linear-style layout (left-aligned claims, hairline structure, line-art figures). Fonts from Fontshare: General Sans (headings, same face as the wordmark), Switzer (text), JetBrains Mono (code). Colors follow `brand/README.md` (Ink `#1C1917`, Orange `#EA580C`).

**Brand files** (`icon.svg`, `lockup.svg`, `apple-touch-icon.png`, `og.png`) are generated copies of `brand/`: edit the sources there and run `npm run generate:icons`, never the copies here.

**Screenshots** in `img/` are real captures of the running app in its light theme (demo projects in a scratch profile), 1920 px wide; `add.png` is the same kind of capture cropped to the Add Projects dialog. Missing files show a placeholder frame. The figures and the ruler's example ports are illustrations; the wiring card uses the ports from the real launch in `img/launch.png` (api :5064, web :5309), so update both together if you recapture.

**Live:** https://multiprise.vercel.app (Vercel project `bountbi/multiprise`).

**Redeploy:** `cd site && vercel deploy --prod --yes`. `site/.vercel/` holds the project link and `.env.local` holds a Vercel token; both are gitignored and `.vercelignore` keeps `.env*` out of deployments.
