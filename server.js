require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
// Netlify (and most hosts) run this behind HTTPS on a domain we don't control locally —
// SPOTIFY_REDIRECT_URI overrides the 127.0.0.1 default used for local dev. Must match
// exactly what's registered in the Spotify dashboard.
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;
const IS_HTTPS = REDIRECT_URI.startsWith('https://');

const { SPOTIFY_CLIENT_ID, GETSONGBPM_API_KEY, SESSION_SECRET } = process.env;

app.use(express.static('public'));
app.use(express.json());

// ---------- signed-cookie session helpers ----------
// No server-side session store: serverless hosts (Netlify, Vercel, ...) don't guarantee
// the same process handles /login and /callback, so state that only lived in an in-memory
// Map would vanish between requests. Everything needed to resume login or stay logged in
// travels in the cookie itself, HMAC-signed so it can't be forged or tampered with from
// the browser. Values are still opaque to JS (HttpOnly) and only sent over HTTPS in
// production (Secure, gated on IS_HTTPS so local http://127.0.0.1 dev still works).

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getSessionSecret() {
  if (!SESSION_SECRET) {
    throw new Error('Missing SESSION_SECRET in .env — required to sign session cookies.');
  }
  return SESSION_SECRET;
}

function sign(payload) {
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  const mac = base64url(crypto.createHmac('sha256', getSessionSecret()).update(body).digest());
  return `${body}.${mac}`;
}

function unsign(value) {
  if (!value) return null;
  const [body, mac] = value.split('.');
  if (!body || !mac) return null;
  const expectedMac = base64url(crypto.createHmac('sha256', getSessionSecret()).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header.split(';').filter(Boolean).map((p) => {
      const idx = p.indexOf('=');
      return [p.slice(0, idx).trim(), decodeURIComponent(p.slice(idx + 1).trim())];
    })
  );
}

function setCookie(res, name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (IS_HTTPS) parts.push('Secure');
  const existing = res.getHeader('Set-Cookie');
  const header = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  header.push(parts.join('; '));
  res.setHeader('Set-Cookie', header);
}

function clearCookie(res, name) {
  setCookie(res, name, '', 0);
}

// ---------- Spotify: Authorization Code + PKCE (user login required for playlist items) ----------
async function exchangeToken(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Spotify token request failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function getUserAccessToken(req, res) {
  const cookies = parseCookies(req);
  const session = unsign(cookies.session);
  if (!session) return null;

  if (Date.now() < session.expiresAt) return session.accessToken;

  if (!session.refreshToken) return null;

  try {
    const data = await exchangeToken({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
      client_id: SPOTIFY_CLIENT_ID,
    });
    const updated = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || session.refreshToken, // Spotify may rotate it
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };
    setCookie(res, 'session', sign(updated), 60 * 60 * 24 * 30);
    return updated.accessToken;
  } catch (e) {
    clearCookie(res, 'session');
    return null;
  }
}

function extractPlaylistId(input) {
  if (!input) return null;
  const trimmed = input.trim();

  if (/^[A-Za-z0-9]{15,30}$/.test(trimmed)) return trimmed;

  let m = trimmed.match(/spotify:playlist:([A-Za-z0-9]+)/);
  if (m) return m[1];

  m = trimmed.match(/open\.spotify\.com\/(?:intl-\w+\/)?playlist\/([A-Za-z0-9]+)/);
  if (m) return m[1];

  return null;
}

async function spotifyGet(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Spotify API error (${res.status}) on ${url}: ${body}`);
  }
  return res.json();
}

async function spotifyPost(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Spotify API error (${res.status}) on ${url}: ${errBody}`);
  }
  return res.json();
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchPlaylist(playlistId, token) {
  const meta = await spotifyGet(
    `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,owner(display_name),images,tracks.total`,
    token
  );

  const tracks = [];
  let url =
    `https://api.spotify.com/v1/playlists/${playlistId}/items` +
    `?limit=100&fields=next,items(item(id,name,duration_ms,external_urls,album(name),artists(name)))`;

  while (url) {
    const page = await spotifyGet(url, token);
    for (const entry of page.items) {
      const t = entry.item; // /items nests the track under "item", not "track" like the deprecated /tracks did
      if (!t) continue; // local/unavailable tracks can be null
      tracks.push({
        id: t.id,
        name: t.name,
        artists: (t.artists || []).map((a) => a.name),
        album: t.album ? t.album.name : '',
        durationMs: t.duration_ms,
        spotifyUrl: t.external_urls ? t.external_urls.spotify : null,
      });
    }
    url = page.next;
  }

  return { name: meta.name, owner: meta.owner ? meta.owner.display_name : '', tracks };
}

// ---------- GetSongBPM lookup ----------
const bpmCache = new Map(); // key: "artist|||title" -> { bpm, matched } | null

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '') // drop (feat...), (remaster), etc.
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanTitleForSearch(title) {
  return (title || '')
    .replace(/\(feat\.?[^)]*\)/gi, '')
    .replace(/\(with[^)]*\)/gi, '')
    .replace(/\s*-\s*.*(remix|edit|version|mix|remaster).*$/i, '')
    .trim();
}

async function lookupBpm(title, artist) {
  const key = `${normalize(artist)}|||${normalize(title)}`;
  if (bpmCache.has(key)) return bpmCache.get(key);

  if (!GETSONGBPM_API_KEY) {
    throw new Error('Missing GETSONGBPM_API_KEY in .env');
  }

  // GetSongBPM's lookup param takes a bare title with type=song — the documented-looking
  // "song:X artist:Y" combined syntax silently returns "no result" for real matches.
  const lookup = encodeURIComponent(cleanTitleForSearch(title) || title);
  const url = `https://api.getsong.co/search/?api_key=${GETSONGBPM_API_KEY}&type=song&lookup=${lookup}`;

  let result = null;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data.search) ? data.search : [];
      if (list.length) {
        const normArtist = normalize(artist);
        // require a real artist match (exact, or one containing the other) — falling back to
        // list[0] regardless of artist silently attaches the wrong song's BPM to the track
        const best = list.find((r) => {
          const ra = normalize(r.artist && r.artist.name);
          return ra && (ra === normArtist || ra.includes(normArtist) || normArtist.includes(ra));
        });
        if (best && best.tempo) {
          result = { bpm: Math.round(Number(best.tempo)), matched: best.title || title };
        }
      }
    }
  } catch (e) {
    // swallow — treated as "not found" below
  }

  bpmCache.set(key, result);
  return result;
}

// tiny sequential-with-concurrency-limit runner so we don't hammer the free API tier
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- Routes ----------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    spotifyConfigured: Boolean(SPOTIFY_CLIENT_ID),
    getsongbpmConfigured: Boolean(GETSONGBPM_API_KEY),
  });
});

app.get('/api/session', async (req, res) => {
  const token = await getUserAccessToken(req, res);
  res.json({ loggedIn: Boolean(token) });
});

app.get('/login', (req, res) => {
  if (!SPOTIFY_CLIENT_ID) {
    return res.status(500).send('Missing SPOTIFY_CLIENT_ID in .env');
  }

  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'pkce', sign({ verifier, state }), 600); // 10 min to complete login

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: 'playlist-modify-public playlist-modify-private',
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.status(400).send(`Spotify login failed: ${error}`);

  const pending = unsign(parseCookies(req).pkce);
  clearCookie(res, 'pkce');
  if (!pending || pending.state !== state) {
    return res.status(400).send('Login expired or invalid state, try again.');
  }

  try {
    const data = await exchangeToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: SPOTIFY_CLIENT_ID,
      code_verifier: pending.verifier,
    });

    setCookie(
      res,
      'session',
      sign({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in - 60) * 1000,
      }),
      60 * 60 * 24 * 30
    );

    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send(`Login failed: ${err.message}`);
  }
});

app.get('/api/sort', async (req, res) => {
  const { playlist, order = 'asc' } = req.query;
  const playlistId = extractPlaylistId(playlist);

  if (!playlistId) {
    return res.status(400).json({ error: 'Could not parse a playlist ID from that link.' });
  }

  const token = await getUserAccessToken(req, res);
  if (!token) {
    return res.status(401).json({ error: 'login_required' });
  }

  try {
    const { name, owner, tracks } = await fetchPlaylist(playlistId, token);

    const withBpm = await mapWithConcurrency(tracks, 5, async (t) => {
      const artist = t.artists[0] || '';
      const bpmResult = await lookupBpm(t.name, artist);
      return {
        ...t,
        bpm: bpmResult ? bpmResult.bpm : null,
        found: Boolean(bpmResult),
      };
    });

    const found = withBpm.filter((t) => t.found);
    const notFound = withBpm.filter((t) => !t.found);

    found.sort((a, b) => (order === 'desc' ? b.bpm - a.bpm : a.bpm - b.bpm));

    res.json({
      playlistName: name,
      owner,
      total: tracks.length,
      matched: found.length,
      unmatched: notFound.length,
      order,
      tracks: [...found, ...notFound],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/create-playlist', async (req, res) => {
  const { name, uris } = req.body || {};

  if (!name || !Array.isArray(uris) || uris.length === 0) {
    return res.status(400).json({ error: 'Missing name or uris.' });
  }

  const token = await getUserAccessToken(req, res);
  if (!token) {
    return res.status(401).json({ error: 'login_required' });
  }

  try {
    const playlist = await spotifyPost('https://api.spotify.com/v1/me/playlists', token, {
      name,
      public: true,
      description: 'Sorted by BPM — created by BPM Sorter',
    });

    for (const batch of chunk(uris, 100)) {
      await spotifyPost(`https://api.spotify.com/v1/playlists/${playlist.id}/items`, token, {
        uris: batch,
      });
    }

    res.json({
      playlistUrl: playlist.external_urls ? playlist.external_urls.spotify : null,
      name: playlist.name,
    });
  } catch (err) {
    console.error(err);
    const insufficientScope = /403/.test(err.message);
    res.status(500).json({
      error: insufficientScope
        ? 'Missing playlist-write permission — reconnect Spotify to grant it.'
        : err.message,
      needsReauth: insufficientScope,
    });
  }
});

// Only bind a port for local dev / a real Node host. On Netlify this file is required by
// netlify/functions/server.js instead, which wraps `app` with serverless-http — no listen().
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`BPM sorter running at ${REDIRECT_URI.replace('/callback', '')}`);
  });
}

module.exports = app;
