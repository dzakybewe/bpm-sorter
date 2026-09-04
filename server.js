require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  GETSONGBPM_API_KEY,
} = process.env;

app.use(express.static('public'));
app.use(express.json());

// ---------- Spotify: Client Credentials token (no user login needed) ----------
let cachedToken = null;
let tokenExpiresAt = 0;

async function getSpotifyToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error('Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env');
  }

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:
        'Basic ' +
        Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Spotify token request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000; // refresh 1min early
  return cachedToken;
}

function extractPlaylistId(input) {
  if (!input) return null;
  const trimmed = input.trim();

  // raw id (22 base62 chars, typical Spotify id length)
  if (/^[A-Za-z0-9]{15,30}$/.test(trimmed)) return trimmed;

  // spotify:playlist:ID
  let m = trimmed.match(/spotify:playlist:([A-Za-z0-9]+)/);
  if (m) return m[1];

  // https://open.spotify.com/playlist/ID?si=...
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

async function fetchPlaylist(playlistId, token) {
  const meta = await spotifyGet(
    `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,owner(display_name),images,tracks.total`,
    token
  );

  const tracks = [];
  let url =
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks` +
    `?limit=100&fields=next,items(track(id,name,duration_ms,external_urls,album(name),artists(name)))`;

  while (url) {
    const page = await spotifyGet(url, token);
    for (const item of page.items) {
      const t = item.track;
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

async function lookupBpm(title, artist) {
  const key = `${normalize(artist)}|||${normalize(title)}`;
  if (bpmCache.has(key)) return bpmCache.get(key);

  if (!GETSONGBPM_API_KEY) {
    throw new Error('Missing GETSONGBPM_API_KEY in .env');
  }

  const lookup = encodeURIComponent(`song:${title} artist:${artist}`);
  const url = `https://api.getsong.co/search/?api_key=${GETSONGBPM_API_KEY}&type=both&lookup=${lookup}`;

  let result = null;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data.search) ? data.search : [];
      if (list.length) {
        const normArtist = normalize(artist);
        const best =
          list.find((r) => normalize(r.artist && r.artist.name) === normArtist) || list[0];
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
    spotifyConfigured: Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET),
    getsongbpmConfigured: Boolean(GETSONGBPM_API_KEY),
  });
});

app.get('/api/sort', async (req, res) => {
  const { playlist, order = 'asc' } = req.query;
  const playlistId = extractPlaylistId(playlist);

  if (!playlistId) {
    return res.status(400).json({ error: 'Could not parse a playlist ID from that link.' });
  }

  try {
    const token = await getSpotifyToken();
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

app.listen(PORT, () => {
  console.log(`BPM sorter running at http://localhost:${PORT}`);
});
