# Site (Multiprise landing page)

One static file, `index.html`. No build step. Preview with `python3 -m http.server 4321 -d site`.

**To update, edit only the `SITE` object at the top of the `<script>` in `index.html`:**
- `links.download`: the public DMG URL. While it is `null`, every Download button is greyed out and the page says "Download available soon". Only set it once the URL works for a logged-out visitor (the GitHub repo and release are private today).
- `links.repo`: the public GitHub repo. The GitHub links stay hidden while it is `null`.
- `version`, `requirements`, `license`: shown under the closing Download button and in the footer.

**Screenshots** in `img/` are real captures of the running app (demo projects in a scratch profile), 1920 px wide, 16:10. Missing files show a placeholder frame. The hero, the terminal-tabs scene and the port numbers on the ruler are illustrations; the wiring section uses the ports from the real launch in `img/launch.png`.

**Live:** https://multiprise.vercel.app (Vercel project `bountbi/multiprise`).

**Redeploy:** `cd site && vercel deploy --prod --yes`. `site/.vercel/` holds the project link and `.env.local` holds a Vercel token; both are gitignored and `.vercelignore` keeps `.env*` out of deployments.
