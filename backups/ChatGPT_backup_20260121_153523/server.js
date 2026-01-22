const express = require('express');
const path = require('path');
const fs = require('fs');
const { scrapePlayers, steamIdFromUrl, FALLBACK_AVATAR } = require('./scripts/moose_scraper');

const DATA_DIR = __dirname;
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const MIN_PLAYERS = 0;
const MIN_COMPARE_PLAYERS = 2;
const MAX_PLAYERS = 10;
const SERVER_NAME = 'US Monthly (Premium)';
const ALLOWED_SERVERS = ['US Monthly (Premium)', 'US Biweekly (Premium)'];
let lastRefreshStatus = { message: 'Idle', at: Date.now() };

function normalizeServerName(serverName) {
  if (!serverName) return SERVER_NAME;
  const trimmed = String(serverName).trim();
  const match = ALLOWED_SERVERS.find((name) => name.toLowerCase() === trimmed.toLowerCase());
  return match || SERVER_NAME;
}

function setRefreshStatus(message) {
  lastRefreshStatus = { message, at: Date.now() };
}

async function fetchSteamProfileSummaryFromUrl(steamUrl) {
  if (!steamUrl) return {};
  try {
    const resp = await fetch(steamUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
      },
    });
    if (!resp.ok) return {};
    const html = await resp.text();
    const nameFromOg = html.match(/property="og:title"\s+content="Steam Community :: ([^"]+)"/i);
    const nameFromSpan = html.match(/actual_persona_name[^>]*>\s*([^<]+)\s*</i);
    const viaAvatar = html.match(/playerAvatarAutoSizeInner[^>]*>\s*<img[^>]*src="([^"]+)"/i);
    const viaOg = html.match(/property="og:image"\s+content="([^"]+)"/i);
    return {
      displayName: nameFromOg?.[1]?.trim() || nameFromSpan?.[1]?.trim() || null,
      avatarUrl: viaAvatar?.[1] || viaOg?.[1] || null,
    };
  } catch {
    return {};
  }
}

function buildSteamUrl(steamUrl, steamId) {
  if (steamUrl && /^https?:\/\//i.test(String(steamUrl))) return steamUrl;
  if (steamId && /^\d{17}$/.test(String(steamId))) {
    return `https://steamcommunity.com/profiles/${steamId}`;
  }
  return null;
}

async function fetchSteamProfileSummary(steamUrl, steamId) {
  const primaryUrl = buildSteamUrl(steamUrl, null);
  const fallbackUrl = buildSteamUrl(null, steamId);
  const primary = await fetchSteamProfileSummaryFromUrl(primaryUrl);
  if (primary.displayName && primary.avatarUrl) return primary;
  if (fallbackUrl && fallbackUrl !== primaryUrl) {
    const fallback = await fetchSteamProfileSummaryFromUrl(fallbackUrl);
    return {
      displayName: primary.displayName || fallback.displayName || null,
      avatarUrl: primary.avatarUrl || fallback.avatarUrl || null,
    };
  }
  return primary;
}

async function resolveSteamId64(steamUrl) {
  if (!steamUrl) return null;
  try {
    const normalized = String(steamUrl).replace(/\/$/, '');
    const vanity = steamIdFromUrl(normalized);
    if (vanity && /^\d{17}$/.test(vanity)) return vanity;

    if (vanity) {
      const lookupUrl = `https://steamid.io/lookup/${encodeURIComponent(vanity)}`;
      const lookupResp = await fetch(lookupUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
        },
      });
      if (lookupResp.ok()) {
        const lookupHtml = await lookupResp.text();
        const tableMatch = lookupHtml.match(/SteamID64<\/td>\s*<td[^>]*>(\d{17})/i);
        const looseMatch = lookupHtml.match(/\b(\d{17})\b/);
        const resolved = tableMatch?.[1] || looseMatch?.[1];
        if (resolved) return resolved;
      }
    }

    const xmlUrl = normalized + '/?xml=1';
    const resp = await fetch(xmlUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
      },
    });
    if (!resp.ok) return null;
    const txt = await resp.text();
    const m = txt.match(/<steamID64>(\d{17})<\/steamID64>/);
    return m?.[1] || null;
  } catch {
    return null;
  }
}

function loadPlayers() {
  try {
    const raw = fs.readFileSync(PLAYERS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function withPlayerIds(players) {
  return players.map((player, index) => ({ id: index, ...player }));
}

function savePlayers(players) {
  fs.writeFileSync(PLAYERS_FILE, JSON.stringify(players, null, 2));
}

async function normalizePlayer(steamUrl) {
  const resolved = await resolveSteamId64(steamUrl);
  const normalizedUrl = buildSteamUrl(steamUrl, resolved);
  const profile = await fetchSteamProfileSummary(normalizedUrl || steamUrl, resolved);
  return {
    steamUrl: normalizedUrl || steamUrl,
    steamId: resolved || steamIdFromUrl(steamUrl),
    displayName: profile.displayName || null,
    avatarUrl: profile.avatarUrl || null,
  };
}

async function hydratePlayers(players) {
  let changed = false;
  const hydrated = await Promise.all(
    players.map(async (player) => {
      const needsId = !player.steamId || !/^\d{17}$/.test(player.steamId);
      const needsProfile = !player.displayName || !player.avatarUrl;
      if (!needsId && !needsProfile) return player;
      const normalizedUrl = buildSteamUrl(player.steamUrl, player.steamId);
      const resolvedId = needsId ? await resolveSteamId64(normalizedUrl || player.steamUrl) : null;
      const profile = needsProfile
        ? await fetchSteamProfileSummary(normalizedUrl || player.steamUrl, resolvedId || player.steamId)
        : {};
      const next = {
        ...player,
        steamUrl: normalizedUrl || player.steamUrl,
        steamId: player.steamId && /^\d{17}$/.test(player.steamId) ? player.steamId : resolvedId || player.steamId,
        displayName: player.displayName || profile.displayName || null,
        avatarUrl: player.avatarUrl || profile.avatarUrl || null,
      };
      if (next.displayName !== player.displayName || next.avatarUrl !== player.avatarUrl) {
        changed = true;
      }
      if (next.steamId !== player.steamId) {
        changed = true;
      }
      return next;
    })
  );
  if (changed) savePlayers(hydrated);
  return hydrated;
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(__dirname));

app.get('/api/players', async (req, res) => {
  const players = await hydratePlayers(loadPlayers());
  res.json(withPlayerIds(players));
});

app.post('/api/players', async (req, res) => {
  const { steamUrl } = req.body || {};
  if (!steamUrl) return res.status(400).json({ error: 'steamUrl required' });
  const players = loadPlayers();
  if (players.length >= MAX_PLAYERS) return res.status(400).json({ error: 'Max 10 players' });
  if (players.some((p) => p.steamUrl === steamUrl)) return res.status(400).json({ error: 'Player already added' });
  players.push(await normalizePlayer(steamUrl));
  savePlayers(players);
  res.json(withPlayerIds(players));
});

app.delete('/api/players/:id', (req, res) => {
  const steamId = req.params.id;
  const steamUrl = req.query?.steamUrl;
  const players = loadPlayers();
  const targets = [steamId, steamIdFromUrl(steamUrl)].filter(Boolean);
  const next = players.filter((p) => {
    const key = p.steamId || steamIdFromUrl(p.steamUrl);
    return !targets.includes(key);
  });
  if (next.length === players.length) return res.json(players);
  savePlayers(next);
  res.json(withPlayerIds(next));
});

app.put('/api/players/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid player id' });
  const { steamUrl, steamId } = req.body || {};
  const nextUrl = steamUrl != null ? String(steamUrl).trim() : null;
  const nextId = steamId != null ? String(steamId).trim() : null;
  if (!nextUrl && !nextId) return res.status(400).json({ error: 'steamUrl or steamId required' });

  const players = loadPlayers();
  if (id < 0 || id >= players.length) return res.status(404).json({ error: 'Player not found' });

  const normalizedUrl = buildSteamUrl(nextUrl, nextId || players[id].steamId);
  const updated = {
    ...players[id],
    steamUrl: normalizedUrl || nextUrl || players[id].steamUrl,
    steamId: nextId || players[id].steamId,
  };
  players[id] = updated;
  savePlayers(players);
  const hydrated = await hydratePlayers(players);
  res.json(withPlayerIds(hydrated));
});

function attachPlayerIds(profiles, players) {
  const bySteamId = new Map();
  const bySteamUrl = new Map();
  players.forEach((player, index) => {
    const id = player.steamId ? String(player.steamId) : null;
    const url = player.steamUrl ? String(player.steamUrl) : null;
    if (id) bySteamId.set(id, { index, player });
    if (url) bySteamUrl.set(url, { index, player });
  });
  return profiles.map((profile) => {
    const match =
      (profile.steamId && bySteamId.get(String(profile.steamId))) ||
      (profile.steamUrl && bySteamUrl.get(String(profile.steamUrl))) ||
      null;
    if (!match) return profile;
    return {
      ...profile,
      playerId: match.index,
      storedSteamUrl: match.player.steamUrl || null,
      storedSteamId: match.player.steamId || null,
    };
  });
}

app.post('/api/refresh', async (req, res) => {
  const players = await hydratePlayers(loadPlayers());
  if (players.length < MIN_COMPARE_PLAYERS) {
    return res.status(400).json({ error: 'Add at least 2 players' });
  }
  try {
    const serverName = normalizeServerName(req.body?.serverName);
    setRefreshStatus('Starting refresh...');
    const result = await scrapePlayers(players, serverName, setRefreshStatus);
    const profiles = attachPlayerIds(result.profiles, players);
    const response = {
      serverName,
      metrics: result.tabs?.pvp?.metrics || [],
      stats: result.tabs?.pvp?.stats || {},
      profiles,
      tabs: result.tabs || {},
      missing: result.missing || [],
      serverInfo: result.serverInfo || null,
    };
    res.json(response);
    setRefreshStatus('Refresh complete.');
  } catch (err) {
    console.error(err);
    setRefreshStatus(`Refresh error: ${err.message || 'Failed'}`);
    res.status(500).json({ error: err.message || 'Failed to refresh' });
  }
});

app.get('/api/data', async (req, res) => {
  const players = await hydratePlayers(loadPlayers());
  if (players.length < MIN_COMPARE_PLAYERS) {
    return res.status(400).json({ error: 'Add at least 2 players' });
  }
  try {
    const serverName = normalizeServerName(req.query?.serverName);
    const result = await scrapePlayers(players, serverName, setRefreshStatus);
    const profiles = attachPlayerIds(result.profiles, players);
    res.json({
      serverName,
      metrics: result.tabs?.pvp?.metrics || [],
      stats: result.tabs?.pvp?.stats || {},
      profiles,
      tabs: result.tabs || {},
      missing: result.missing || [],
      serverInfo: result.serverInfo || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to fetch data' });
  }
});

app.get('/api/refresh-status', (req, res) => {
  res.json(lastRefreshStatus);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
