# BPM Sorter

Paste a Spotify playlist link, get tracks sorted by tempo (BPM).

Spotify's own tempo data (`audio-features`) is blocked for apps created after
Nov 27 2024, so this app never touches that endpoint — it looks up BPM via
[GetSongBPM](https://getsongbpm.com/api) instead. Reading a playlist's tracks
(even a public one) also requires a real logged-in Spotify user now, not just
an app token — so the app has a Spotify login step.

## Setup

1. `npm install`
2. Get a Spotify Client ID: [dashboard.spotify.com/dashboard](https://dashboard.spotify.com/dashboard) → Create app.
   Set the Redirect URI to `http://127.0.0.1:3000/callback` (must match `PORT` below exactly — Spotify allows plain HTTP only for `127.0.0.1`, not `localhost`).
   Uses Authorization Code + PKCE, so only the Client ID is needed — no secret.
3. Get a free GetSongBPM key: [getsongbpm.com/api](https://getsongbpm.com/api) (a backlink to getsongbpm.com is required to activate it — see the Credit section below).
4. `cp .env.example .env` and fill in `SPOTIFY_CLIENT_ID` and `GETSONGBPM_API_KEY`.
5. `npm start` → open **http://127.0.0.1:3000** (not `localhost`, must match the redirect URI).

## Usage

1. Click **Connect Spotify** and authorize — required to read any playlist's tracks, including public ones.
2. Paste a playlist link. Only works for playlists **you own or collaborate on** — Spotify blocks reading track lists on playlists that aren't yours, even public ones.
3. Click **Sort**. Matched tracks are sorted by BPM; tracks GetSongBPM couldn't match are listed at the bottom, dimmed.
4. **Save as Spotify playlist** creates a new playlist in your account with the tracks in sorted order (public, named "`<original name>` (by BPM)"). **Export CSV** downloads the same list as a file.

## Notes

- Only works on playlists you own or collaborate on (Spotify API restriction, not this app's choice).
- BPM match quality depends on GetSongBPM's catalog — some tracks (remixes, obscure/local files) have no entry and show no match. Occasionally a matched BPM is 2x or 0.5x the real tempo (a known half/double-time detection quirk in automated BPM tools) — GetSongBPM's data, not something this app corrects.
- Login session is in-memory; restarting the server logs you out.

## Credit

Song BPM data via [GetSongBPM](https://getsongbpm.com).
