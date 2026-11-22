# W-Streamer Server

The API behind the W-Streamer Android app: login and profiles (admin plus kid profiles with PINs and rating limits), an encrypted token vault (TorBox, Real-Debrid, AllDebrid, TMDB, OpenSubtitles…), Stremio addon aggregation (including importing addons from a Stremio account), debrid stream resolution, and P2P torrent streaming.

Express 5 · TypeScript · Prisma 6 · PostgreSQL (Supabase, database only).

## Deploy on Render

1. Render dashboard → **New → Blueprint** → select this repo. `render.yaml` sets everything up.
2. When asked, paste the two database URLs (Supabase → **Connect** → *Session pooler*). URL-encode special characters in the password (`@` → `%40`):
   - `DATABASE_URL` = `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?connection_limit=10`
   - `DIRECT_URL` = the same URL without `?connection_limit=10`
3. Deploy. Render generates the JWT secrets, `VAULT_KEY_V1` and `ADMIN_SETUP_TOKEN`. Copy `ADMIN_SETUP_TOKEN` from the service's **Environment** tab; the app's first-run Setup screen asks for it.
4. Check `https://<your-service>.onrender.com/health`. It should return `{"ok":true,…,"db":"up"}`.

> **Never change `VAULT_KEY_V1` after saving keys in the vault.** The saved keys can't be decrypted without it. To rotate it, add `VAULT_KEY_V2`, set `VAULT_ACTIVE_KEY_VERSION=2`, and keep `VAULT_KEY_V1`.

The free plan sleeps after about 15 minutes idle, so the first request after that takes about 30–60 s. TorBox and debrid streams play straight from the provider and don't go through this server. Only raw magnet (P2P) streaming uses the server's bandwidth.

The database schema is created with `npm run db:push`, run once from a machine that has `DIRECT_URL` set.

## Local development

```bash
cp .env.example .env   # fill in values
npm install
npm run db:push        # first time only
npm run dev            # http://localhost:8787
```

| Script | |
|---|---|
| `npm run dev` | watch mode (tsx) |
| `npm run build` / `npm start` | production build (`dist/`) / run it |
| `npm run typecheck` | TypeScript check |
| `npm run db:push` | sync the Prisma schema to the database |

API reference: [`src/contracts/api.ts`](src/contracts/api.ts). It's the typed contract the app consumes.
