# Home Library

A personal library app for English and Tamil books. It runs in Chrome on your phone and installs like a normal app.

## Files

Upload all of these to the same place (the top level of your GitHub repository, not inside a folder):

- `index.html`, `app.js`, `style.css` — the app
- `manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` — install and offline support
- `supabase-setup.sql` — paste this into Supabase once; it is not used by the app itself
- `README.md` — this file

## Setup in short

1. **Supabase** (free database): create a project, run `supabase-setup.sql` in the SQL Editor, and copy the Project URL and the publishable (anon) key.
2. **GitHub Pages** (free hosting): create a public repository, upload the files, then Settings → Pages → Deploy from branch `main`, folder `/ (root)`.
3. **Supabase → Authentication → URL Configuration**: set Site URL to your GitHub Pages address, and add it under Redirect URLs.
4. Open your GitHub Pages address in Chrome, paste the Supabase values, create your account, confirm the email, and sign in.
5. Chrome menu → **Add to Home screen**.
6. Optional: **Settings → Claude features**. Paste a Claude API key from platform.claude.com (create it in the Default workspace). Add credit and a monthly limit in the Console.
7. Move your books in: download a backup from the old app, then here **Settings → Choose backup file → Import**. Covers from the old app need adding again.

## Where things are kept

- Books, wishlist, passages and backup date: your Supabase database, private to your account.
- Cover photos: your Supabase storage. Anyone who has a cover's exact web address can view that image; nothing else is public.
- Your Claude API key: only on the phone where you typed it.
- A copy of your library on the phone, so it opens offline. Changes made offline sync when you're back online.

## Good to know

- Supabase may pause a free project after a week with little use. Open supabase.com, choose the project and tap **Resume project**. Your data is kept.
- To update the app later, upload the new files to GitHub over the old ones. The app picks them up next time it opens online.
