const form = document.getElementById('sortForm');
const input = document.getElementById('playlistInput');
const orderSelect = document.getElementById('orderSelect');
const submitBtn = document.getElementById('submitBtn');
const statusEl = document.getElementById('status');
const results = document.getElementById('results');
const playlistTitle = document.getElementById('playlistTitle');
const resultsBody = document.getElementById('resultsBody');
const exportBtn = document.getElementById('exportBtn');

let lastData = null;

function setStatus(msg, isError = false) {
  statusEl.hidden = !msg;
  statusEl.textContent = msg || '';
  statusEl.className = 'status' + (isError ? ' error' : '');
}

function msToClock(ms) {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function render(data) {
  lastData = data;
  playlistTitle.textContent = `${data.playlistName} — ${data.matched}/${data.total} matched`;
  resultsBody.innerHTML = '';

  data.tracks.forEach((t, i) => {
    const tr = document.createElement('tr');
    if (!t.found) tr.classList.add('unmatched');

    tr.innerHTML = `
      <td>${i + 1}</td>
      <td class="bpm-cell">${t.found ? t.bpm : '—'}</td>
      <td>${escapeHtml(t.name)}</td>
      <td>${escapeHtml(t.artists.join(', '))}</td>
      <td>${escapeHtml(t.album)}</td>
      <td>${t.spotifyUrl ? `<a href="${t.spotifyUrl}" target="_blank" rel="noopener">open</a>` : ''}</td>
    `;
    resultsBody.appendChild(tr);
  });

  results.hidden = false;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const playlist = input.value.trim();
  const order = orderSelect.value;
  if (!playlist) return;

  submitBtn.disabled = true;
  results.hidden = true;
  setStatus('Fetching playlist and looking up BPM per track — can take a bit for long playlists…');

  try {
    const res = await fetch(`/api/sort?playlist=${encodeURIComponent(playlist)}&order=${order}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    setStatus(
      data.unmatched
        ? `Done. ${data.unmatched} track(s) had no BPM match and are listed at the bottom.`
        : 'Done.'
    );
    render(data);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    submitBtn.disabled = false;
  }
});

exportBtn.addEventListener('click', () => {
  if (!lastData) return;
  const rows = [
    ['#', 'BPM', 'Title', 'Artist', 'Album', 'Spotify URL'],
    ...lastData.tracks.map((t, i) => [
      i + 1,
      t.found ? t.bpm : '',
      t.name,
      t.artists.join(', '),
      t.album,
      t.spotifyUrl || '',
    ]),
  ];
  const csv = rows
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(lastData.playlistName || 'playlist').replace(/[^a-z0-9]+/gi, '_')}_by_bpm.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});
