# Site (Multiprise landing page)

One static file, `index.html`. No build step. Preview with `python3 -m http.server 4321 -d site`.

**To update, edit only the `SITE` object at the top of the `<script>` in `index.html`:**
- `links.download`: the public DMG URL. While it is `null`, every Download button is greyed out and the page says "Download available soon". Only set it to a URL that works for a logged-out visitor.
- `links.repo`: the public GitHub repo. The GitHub links stay hidden while it is `null`.
- `version`, `requirements`, `license`: shown under the closing Download button and in the footer.

**Design:** light, Linear-style layout (left-aligned claims, hairline structure, line-art figures). Fonts from Fontshare: General Sans (headings, same face as the wordmark), Switzer (text), JetBrains Mono (code). Colors follow `brand/README.md` (Ink `#1C1917`, Orange `#EA580C`).

**Brand files** (`icon.svg`, `lockup.svg`, `apple-touch-icon.png`, `og.png`) are generated copies of `brand/`: edit the sources there and run `npm run generate:icons`, never the copies here.

**Screenshots** in `img/` are real captures of the running app in its dark theme, 1920 px wide, taken with demo projects (northwind, ledger-rs, pulse-blog, atlas) in a scratch profile; `add.png` is cropped to the Add Projects dialog. In `running.png` and `activity.png` the servers Multiprise did not start and the machine's figures are illustrations, so no real machine shows. Missing files show a placeholder frame. The figures and the ruler's example ports are illustrations; the wiring card uses the ports from the real launch in `img/hero.png` (api :5064, web :5309), so update both together if you recapture.

**Live:** https://multiprise.vercel.app (Vercel project `bountbi/multiprise`).

**Redeploy:** `cd site && vercel deploy --prod --yes`. `site/.vercel/` holds the project link and `.env.local` holds a Vercel token; both are gitignored and `.vercelignore` keeps `.env*` out of deployments.

**Windows waitlist:** the band under the header ("Join the waitlist") posts to `api/waitlist.js`, which stores each address as its own blob in the private Vercel Blob store `multiprise-waitlist` (linked to this project as `BLOB_READ_WRITE_TOKEN`). Only the address and the time it was added are kept; joining twice keeps one entry; a hidden honeypot field turns away simple bots. Set `SITE.windows` to `null` to remove the band.

`privacy.html` tells visitors what is kept, that the list is deleted once the Windows build is announced, and has a **Leave the list** form (`DELETE /api/waitlist`, which answers the same whether or not the address was on it). It is linked from the band and the footer; keep it true if the waitlist changes.

**Rate limits:** the Vercel Firewall rule "Waitlist rate limit" allows 10 requests per IP per 10 minutes on `/api/waitlist` and answers 429 beyond that (Hobby allows one rate-limit rule per project). Check it with `vercel firewall rules list`. The function repeats the same per-IP limit in memory and caps joins and removals at 300 an hour per instance, so preview deployments and a disabled rule still have a ceiling.

To download the list as CSV (the key is in `site/.env.waitlist.local`, which is gitignored and never deployed; it is also set on Vercel as `WAITLIST_ADMIN_KEY`, which is write-only there):

```bash
curl -H "Authorization: Bearer $(cut -d= -f2- site/.env.waitlist.local)" https://multiprise.vercel.app/api/waitlist
```

To rotate the key: `vercel env rm WAITLIST_ADMIN_KEY production`, add a new one with `vercel env add`, update `.env.waitlist.local`, and redeploy.
