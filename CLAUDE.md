# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local web app: paste a Spotify playlist link, it sorts the tracks by BPM (tempo). No build step, no framework — a single Express server (`server.js`) serving a static frontend (`public/`).

## Commands

```bash
npm install
npm start        # runs node server.js, listens on http://127.0.0.1:3000
```

There is no lint, test, or build step configured. `npm run dev` is identical to `npm start` (no watch/reload).

Requires `.env` (copy from `.env.example`): `SPOTIFY_CLIENT_ID`, `GETSONGBPM_API_KEY`, optional `PORT` (default 3000). `SPOTIFY_CLIENT_SECRET` is not used (PKCE flow needs no secret) — harmless if left in `.env` but nothing reads it.

## Architecture

**Why the app is shaped the way it is, and why it can't be simpler:**

- Spotify deprecated the `audio-features`/`audio-analysis` endpoints for apps created after Nov 27 2024, so tempo can never come from Spotify's API here — BPM is looked up externally via [GetSongBPM](https://api.getsong.co).
- Spotify also requires a real logged-in user (not just Client Credentials) to read a playlist's track list at all, even for public playlists — and `GET /playlists/{id}/items` (the current, non-deprecated endpoint) only works for playlists the logged-in user owns or collaborates on. Reading someone else's public playlist will 403. This is why the app has a full Spotify login flow even though it never needs to write anything on the read path.
- Login uses Authorization Code + PKCE (`/login` → Spotify consent → `/callback`), not Client Credentials, and not a plain OAuth without PKCE. Sessions are a bare in-memory `Map` (`sessions` in `server.js`) keyed by a random `sid` cookie — no `express-session`/Redis, since this is a single-user local tool. Restarting the server drops all sessions.
- `GET /playlists/{id}/items` nests each track under the key `item`, not `track` (that's only true of the deprecated `/tracks` endpoint). Easy to get wrong by copying examples from Spotify's older docs — see `fetchPlaylist()` in `server.js`.
- GetSongBPM's `lookup` param takes a bare song title with `type=song`. The `lookup=song:X artist:Y` combined syntax that looks documented silently returns `{"search":{"error":"no result"}}` even for real matches — see `lookupBpm()`. Artist filtering is done client-side against the result list instead, and a track is only considered matched if an artist in the results actually matches (no fallback to `list[0]`, which would silently attach the wrong song's tempo).
- GetSongBPM's tempo values can be half/double-time detection errors (e.g. 230 instead of 115) — this is upstream data quality, not something the matching logic here corrects for.

**Request flow for the main feature** (`GET /api/sort?playlist=<url>&order=asc|desc`):
1. `extractPlaylistId()` pulls the playlist ID out of a full URL, `spotify:playlist:` URI, or bare ID.
2. `fetchPlaylist()` paginates `/playlists/{id}/items` with the user's access token.
3. Each track is looked up on GetSongBPM concurrently (`mapWithConcurrency`, limit 5) and cached in-process by normalized `artist|||title` (`bpmCache` — also process-lifetime only).
4. Matched tracks are sorted by BPM; unmatched ones are appended at the end and rendered dimmed in the frontend.

**Playlist creation** (`POST /api/create-playlist`): takes `{ name, uris }` from the frontend (built client-side from the already-sorted `/api/sort` response — the server doesn't re-fetch or re-sort), creates a playlist via `POST /me/playlists`, then adds tracks in batches of 100 (`chunk()`) since that's Spotify's per-request limit on `POST /playlists/{id}/items`. Requires the `playlist-modify-public`/`playlist-modify-private` scopes requested at login — a 403 here is surfaced to the frontend as `needsReauth`, which triggers a re-login rather than a generic error.

**Frontend** (`public/app.js`): no framework, no bundler. Checks `/api/session` on load to gate the Sort button; a 401 from `/api/sort` or `/api/create-playlist` redirects to `/login`.
