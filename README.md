# BPM Sorter

Paste a public Spotify playlist link, get tracks sorted by tempo (BPM).

Spotify's own tempo data (`audio-features`) is blocked for apps created after
Nov 27 2024. This app doesn't touch that endpoint — it reads track/artist
names from Spotify (still open, no user login needed) and looks up BPM via
[GetSongBPM](https://getsongbpm.com/api).

## Setup

1. `npm install`
2. Get Spotify credentials: [dashboard.spotify.com/dashboard](https://dashboard.spotify.com/dashboard) → Create app.
   Redirect URI doesn't matter here (Client Credentials flow, no login). Copy Client ID + Secret.
3. Get a free GetSongBPM key: [getsongbpm.com/api](https://getsongbpm.com/api)
4. `cp .env.example .env` and fill in the three values.
5. `npm start` → open http://localhost:3000

## Notes

- Only works on **public** playlists (Client Credentials has no user context for private ones).
- BPM match quality depends on GetSongBPM's catalog — some tracks (remixes, obscure/local files) may show no match; those are listed at the bottom, dimmed.
- Export CSV button dumps the sorted list.

## Credit

Song BPM data via [GetSongBPM](https://getsongbpm.com).
