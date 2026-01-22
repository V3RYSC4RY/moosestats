const express = require('express');
const path = require('path');
const fs = require('fs');
const pkg = require('./package.json');
const { scrapePlayers, steamIdFromUrl, FALLBACK_AVATAR } = require('./scripts/moose_scraper');

const DATA_DIR = __dirname;
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const CACHE_FILE = path.join(DATA_DIR, 'data.json');
const MIN_PLAYERS = 0;
const MIN_COMPARE_PLAYERS = 2;
const MAX_PLAYERS = 10;
const SERVER_NAME = 'US Monthly (Premium)';
const ALLOWED_SERVERS = ['US Monthly (Premium)', 'US Biweekly (Premium)'];
let lastRefreshStatus = { message: 'Idle', at: Date.now() };

function isValidSteamId(steamId) {
  return /^\d{17}$/.test(String(steamId || ''));
}

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

function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveCache(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

function loadCacheStore() {
  const raw = loadCache();
  if (!raw) return { servers: {} };
  if (raw.servers) return raw;
  if (raw.serverName) {
    const name = normalizeServerName(raw.serverName);
    return { servers: { [name]: raw } };
  }
  return { servers: {} };
}

function getServerCache(store, serverName) {
  if (!store || !store.servers) return null;
  return store.servers[serverName] || null;
}

function setServerCache(store, serverName, cache) {
  if (!store.servers) store.servers = {};
  store.servers[serverName] = cache;
  saveCache(store);
}

function buildFallbackResponse(serverName, players) {
  const profiles = (players || []).map((player) => ({
    steamUrl: player.steamUrl,
    steamId: player.steamId,
    displayName: player.displayName || player.steamId || player.steamUrl,
    fallbackName: player.displayName || player.steamId || player.steamUrl,
    avatarUrl: player.avatarUrl || FALLBACK_AVATAR,
    needsSteam64: !!(
      !isValidSteamId(player.steamId) &&
      (player.steamId || /steamcommunity\.com\/id\/[^/]+/i.test(player.steamUrl || ''))
    ),
  }));
  return {
    serverName,
    metrics: [],
    stats: {},
    profiles: attachPlayerIds(profiles, players),
    tabs: {},
    missing: [],
    serverInfo: null,
    updatedAt: null,
    cached: false,
  };
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
let refreshInFlight = false;
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

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    version: pkg.version || '0.0.0',
  });
});

app.post('/api/players', async (req, res) => {
  const { steamUrl, serverName } = req.body || {};
  if (!steamUrl) return res.status(400).json({ error: 'steamUrl required' });
  const players = loadPlayers();
  if (players.length >= MAX_PLAYERS) return res.status(400).json({ error: 'Max 10 players' });
  if (players.some((p) => p.steamUrl === steamUrl)) return res.status(400).json({ error: 'Player already added' });
  const normalized = await normalizePlayer(steamUrl);
  players.push(normalized);
  savePlayers(players);
  try {
    const server = normalizeServerName(serverName);
    if (!isValidSteamId(normalized.steamId)) {
      const store = loadCacheStore();
      const cache = getServerCache(store, server);
      const hydrated = await hydratePlayers(players);
      return res.json(buildResponseFromCache(cache, hydrated) || buildFallbackResponse(server, hydrated));
    }
    const result = await scrapePlayers([normalized], server, setRefreshStatus);
    const store = loadCacheStore();
    const serverCache = mergePlayerStats(getServerCache(store, server), {
      serverName: server,
      profiles: result.profiles || [],
      tabs: result.tabs || {},
      missing: result.missing || [],
      serverInfo: result.serverInfo || null,
    });
    setServerCache(store, server, serverCache);
    const response = buildResponseFromCache(serverCache, await hydratePlayers(players));
    res.json(response);
  } catch (err) {
    console.error(err);
    const store = loadCacheStore();
    const server = normalizeServerName(serverName);
    const response = buildResponseFromCache(getServerCache(store, server), await hydratePlayers(players));
    if (response) return res.json(response);
    res.status(500).json({ error: err.message || 'Failed to add player' });
  }
});

app.delete('/api/players/:id', (req, res) => {
  const steamId = req.params.id;
  const steamUrl = req.query?.steamUrl;
  const serverName = normalizeServerName(req.query?.serverName);
  const byIndex = req.query?.byIndex === '1';
  const players = loadPlayers();
  const targets = [steamId, steamIdFromUrl(steamUrl)].filter(Boolean);
  let removed = null;
  if (byIndex && Number.isInteger(Number(steamId))) {
    const index = Number(steamId);
    if (index >= 0 && index < players.length) {
      removed = players[index];
      players.splice(index, 1);
    }
  }
  if (!removed) {
    const next = players.filter((p) => {
      const key = p.steamId || steamIdFromUrl(p.steamUrl);
      return !targets.includes(key);
    });
    if (next.length === players.length) return res.json(withPlayerIds(players));
    removed = players.find((p) => {
      const key = p.steamId || steamIdFromUrl(p.steamUrl);
      return targets.includes(key);
    });
    players.length = 0;
    players.push(...next);
  }
  savePlayers(players);
  const store = loadCacheStore();
  Object.keys(store.servers || {}).forEach((name) => {
    const updated = removePlayerFromCache(store.servers[name], removed);
    if (updated) store.servers[name] = updated;
  });
  saveCache(store);
  const response = buildResponseFromCache(getServerCache(store, serverName), players);
  if (response) return res.json(response);
  res.json(withPlayerIds(players));
});

app.put('/api/players/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid player id' });
  const { steamUrl, steamId, steamName, serverName } = req.body || {};
  const nextUrl = steamUrl != null ? String(steamUrl).trim() : null;
  const nextId = steamId != null ? String(steamId).trim() : null;
  const nextName = steamName != null ? String(steamName).trim() : null;
  if (!nextUrl && !nextId && !nextName) {
    return res.status(400).json({ error: 'steamName, steamUrl, or steamId required' });
  }

  const players = loadPlayers();
  if (id < 0 || id >= players.length) return res.status(404).json({ error: 'Player not found' });

  const resolvedId = !nextId && nextUrl ? await resolveSteamId64(nextUrl) : null;
  const finalId = nextId || resolvedId || players[id].steamId;
  const normalizedUrl = buildSteamUrl(nextUrl, finalId || players[id].steamId);
  const updated = {
    ...players[id],
    steamUrl: normalizedUrl || nextUrl || players[id].steamUrl,
    steamId: finalId || players[id].steamId,
    displayName: nextName || players[id].displayName,
  };
  players[id] = updated;
  savePlayers(players);
  const hydrated = await hydratePlayers(players);
  const store = loadCacheStore();
  Object.keys(store.servers || {}).forEach((name) => {
    const cache = store.servers[name];
    if (!cache) return;
    cache.profiles = mergeCachedProfiles(cache.profiles || [], hydrated);
    cache.updatedAt = Date.now();
  });
  saveCache(store);
  const response = buildResponseFromCache(getServerCache(store, normalizeServerName(serverName)), hydrated);
  if (response) return res.json(response);
  res.json(withPlayerIds(hydrated));
});

app.post('/api/players/reorder', async (req, res) => {
  const order = Array.isArray(req.body?.order) ? req.body.order.map(String) : [];
  const serverName = normalizeServerName(req.body?.serverName);
  if (!order.length) return res.status(400).json({ error: 'order required' });
  const players = loadPlayers();
  const byId = new Map();
  players.forEach((player) => {
    const id = player.steamId ? String(player.steamId) : steamIdFromUrl(player.steamUrl);
    if (id) byId.set(id, player);
  });
  const ordered = order.map((id) => byId.get(String(id))).filter(Boolean);
  const remainder = players.filter((player) => {
    const id = player.steamId ? String(player.steamId) : steamIdFromUrl(player.steamUrl);
    return !order.includes(String(id));
  });
  const next = [...ordered, ...remainder];
  savePlayers(next);
  const hydrated = await hydratePlayers(next);
  const store = loadCacheStore();
  Object.keys(store.servers || {}).forEach((name) => {
    const cache = store.servers[name];
    if (!cache || !Array.isArray(cache.profiles)) return;
    const byCacheId = new Map();
    cache.profiles.forEach((profile) => {
      const id = profile.steamId ? String(profile.steamId) : steamIdFromUrl(profile.steamUrl);
      if (id) byCacheId.set(id, profile);
    });
    const orderedProfiles = order.map((id) => byCacheId.get(String(id))).filter(Boolean);
    const restProfiles = cache.profiles.filter((profile) => {
      const id = profile.steamId ? String(profile.steamId) : steamIdFromUrl(profile.steamUrl);
      return !order.includes(String(id));
    });
    cache.profiles = [...orderedProfiles, ...restProfiles];
    cache.updatedAt = Date.now();
  });
  saveCache(store);
  const response = buildResponseFromCache(getServerCache(store, serverName), hydrated);
  if (response) return res.json(response);
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

function mergeCachedProfiles(profiles, players) {
  const bySteamId = new Map();
  const bySteamUrl = new Map();
  players.forEach((player) => {
    if (player.steamId) bySteamId.set(String(player.steamId), player);
    if (player.steamUrl) bySteamUrl.set(String(player.steamUrl), player);
  });
  return (profiles || [])
    .map((profile) => {
      const match =
        (profile.steamId && bySteamId.get(String(profile.steamId))) ||
        (profile.steamUrl && bySteamUrl.get(String(profile.steamUrl))) ||
        null;
      if (!match) return profile;
      return {
        ...profile,
        steamUrl: match.steamUrl || profile.steamUrl,
        steamId: match.steamId || profile.steamId,
        displayName: match.displayName || profile.displayName,
        avatarUrl: match.avatarUrl || profile.avatarUrl,
      };
    })
    .filter((profile) => {
      const id = profile.steamId ? String(profile.steamId) : null;
      const url = profile.steamUrl ? String(profile.steamUrl) : null;
      return (id && bySteamId.has(id)) || (url && bySteamUrl.has(url));
    });
}

function filterStatsToProfiles(tabs, profiles) {
  const keys = new Set(
    (profiles || []).map((p) => p.displayName || p.fallbackName || p.steamId || p.steamUrl).filter(Boolean)
  );
  const nextTabs = {};
  Object.entries(tabs || {}).forEach(([tabKey, tabData]) => {
    const nextStats = {};
    Object.entries(tabData?.stats || {}).forEach(([statKey, values]) => {
      if (keys.has(statKey)) nextStats[statKey] = values;
    });
    nextTabs[tabKey] = {
      ...tabData,
      stats: nextStats,
    };
  });
  return nextTabs;
}

function buildResponseFromCache(cache, players) {
  if (!cache) return null;
  const mergedProfiles = mergeCachedProfiles(cache.profiles || [], players);
  const mergedIds = new Set(
    (mergedProfiles || [])
      .map((p) => p.steamId || steamIdFromUrl(p.steamUrl))
      .filter(Boolean)
      .map(String)
  );
  const missingProfiles = (players || [])
    .filter((player) => {
      const id = player.steamId || steamIdFromUrl(player.steamUrl);
      return id && !mergedIds.has(String(id));
    })
    .map((player) => ({
      steamUrl: player.steamUrl,
      steamId: player.steamId,
      displayName: player.displayName || player.steamId || player.steamUrl,
      fallbackName: player.displayName || player.steamId || player.steamUrl,
      avatarUrl: player.avatarUrl || FALLBACK_AVATAR,
    }));
  const combinedProfiles = [...mergedProfiles, ...missingProfiles];
  const profilesWithIds = attachPlayerIds(combinedProfiles, players).map((profile) => {
    const candidateId = profile.steamId || profile.storedSteamId || null;
    const needsSteam64 =
      !isValidSteamId(candidateId) &&
      (candidateId || /steamcommunity\.com\/id\/[^/]+/i.test(profile.steamUrl || profile.storedSteamUrl || ''));
    return {
      ...profile,
      needsSteam64,
    };
  });
  const tabs = filterStatsToProfiles(cache.tabs || {}, combinedProfiles);
  return {
    serverName: cache.serverName || SERVER_NAME,
    metrics: tabs?.pvp?.metrics || [],
    stats: tabs?.pvp?.stats || {},
    profiles: profilesWithIds,
    tabs,
    missing: cache.missing || [],
    serverInfo: cache.serverInfo || null,
    updatedAt: cache.updatedAt || null,
  };
}

function mergePlayerStats(cache, playerResult) {
  const next = cache ? { ...cache } : { tabs: {} };
  next.serverName = playerResult.serverName || cache?.serverName || SERVER_NAME;
  next.serverInfo = playerResult.serverInfo || cache?.serverInfo || null;
  next.updatedAt = Date.now();
  next.missing = Array.isArray(cache?.missing) ? [...cache.missing] : [];
  const newProfiles = playerResult.profiles || [];
  const existingProfiles = cache?.profiles || [];
  const mergedProfiles = [...existingProfiles];
  newProfiles.forEach((profile) => {
    const matchIndex = mergedProfiles.findIndex(
      (p) =>
        (profile.steamId && p.steamId && String(profile.steamId) === String(p.steamId)) ||
        (profile.steamUrl && p.steamUrl && String(profile.steamUrl) === String(p.steamUrl))
    );
    if (matchIndex >= 0) {
      mergedProfiles[matchIndex] = { ...mergedProfiles[matchIndex], ...profile };
    } else {
      mergedProfiles.push(profile);
    }
  });
  next.profiles = mergedProfiles;
  Object.entries(playerResult.tabs || {}).forEach(([tabKey, tabData]) => {
    const existingTab = next.tabs[tabKey] || {};
    const mergedStats = { ...(existingTab.stats || {}) };
    Object.entries(tabData?.stats || {}).forEach(([statKey, values]) => {
      mergedStats[statKey] = values;
    });
    next.tabs[tabKey] = {
      ...existingTab,
      ...tabData,
      stats: mergedStats,
      metrics: tabData?.metrics?.length ? tabData.metrics : existingTab.metrics || [],
    };
  });
  return next;
}

function removePlayerFromCache(cache, player) {
  if (!cache) return null;
  const id = player?.steamId ? String(player.steamId) : null;
  const url = player?.steamUrl ? String(player.steamUrl) : null;
  const displayName = player?.displayName || null;
  const next = { ...cache };
  next.profiles = (cache.profiles || []).filter((p) => {
    if (id && p.steamId && String(p.steamId) === id) return false;
    if (url && p.steamUrl && String(p.steamUrl) === url) return false;
    return true;
  });
  Object.entries(next.tabs || {}).forEach(([tabKey, tabData]) => {
    const stats = { ...(tabData?.stats || {}) };
    if (displayName && stats[displayName]) delete stats[displayName];
    if (id && stats[id]) delete stats[id];
    if (url && stats[url]) delete stats[url];
    next.tabs[tabKey] = { ...tabData, stats };
  });
  next.missing = (cache.missing || []).filter((item) => {
    const itemId = item?.steamId ? String(item.steamId) : null;
    const itemUrl = item?.steamUrl ? String(item.steamUrl) : null;
    if (id && itemId && itemId === id) return false;
    if (url && itemUrl && itemUrl === url) return false;
    return true;
  });
  next.updatedAt = Date.now();
  return next;
}

app.post('/api/refresh', async (req, res) => {
  const players = await hydratePlayers(loadPlayers());
  if (players.length < MIN_COMPARE_PLAYERS) {
    return res.status(400).json({ error: 'Add at least 2 players' });
  }
  try {
    const serverName = normalizeServerName(req.body?.serverName);
    const strategy = req.body?.strategy;
    if (refreshInFlight) {
      return res.status(429).json({ error: 'Refresh already in progress' });
    }
    refreshInFlight = true;
    setRefreshStatus('Starting refresh...');
    const startedAt = Date.now();
    console.log(`[refresh] start server=${serverName} players=${players.length} strategy=${strategy || 'perTab'}`);
    const result = await scrapePlayers(players, serverName, setRefreshStatus, { strategy });
    const profiles = attachPlayerIds(result.profiles, players);
    const response = {
      serverName,
      metrics: result.tabs?.pvp?.metrics || [],
      stats: result.tabs?.pvp?.stats || {},
      profiles,
      tabs: result.tabs || {},
      missing: result.missing || [],
      serverInfo: result.serverInfo || null,
      timings: result.timings || null,
    };
    const store = loadCacheStore();
    setServerCache(store, serverName, {
      serverName,
      profiles,
      tabs: result.tabs || {},
      missing: result.missing || [],
      serverInfo: result.serverInfo || null,
      updatedAt: Date.now(),
    });
    res.json(response);
    const elapsed = Date.now() - startedAt;
    if (result.timings) {
      console.log(`[refresh timing] ${result.timings.strategy}: ${result.timings.durationMs}ms`);
    }
    console.log(`[refresh] done in ${elapsed}ms`);
    setRefreshStatus('Refresh complete.');
  } catch (err) {
    console.error('[refresh] error', err?.stack || err);
    setRefreshStatus(`Refresh error: ${err.message || 'Failed'}`);
    res.status(500).json({ error: err.message || 'Failed to refresh' });
  } finally {
    refreshInFlight = false;
  }
});

app.get('/api/data', async (req, res) => {
  const players = await hydratePlayers(loadPlayers());
  const serverName = normalizeServerName(req.query?.serverName);
  const store = loadCacheStore();
  const cache = getServerCache(store, serverName);
  const response = buildResponseFromCache(cache, players);
  if (response) return res.json(response);
  if (players.length >= MIN_COMPARE_PLAYERS) {
    try {
      setRefreshStatus('Starting refresh...');
      const startedAt = Date.now();
      console.log(`[data] cache miss, scraping server=${serverName} players=${players.length}`);
      const result = await scrapePlayers(players, serverName, setRefreshStatus);
      const profiles = attachPlayerIds(result.profiles, players);
      const nextCache = {
        serverName,
        profiles,
        tabs: result.tabs || {},
        missing: result.missing || [],
        serverInfo: result.serverInfo || null,
        updatedAt: Date.now(),
      };
      setServerCache(store, serverName, nextCache);
      console.log(`[data] scrape done in ${Date.now() - startedAt}ms`);
      return res.json(buildResponseFromCache(nextCache, players));
    } catch (err) {
      console.error('[data] refresh error', err?.stack || err);
      return res.status(500).json({ error: err.message || 'Failed to refresh' });
    }
  }
  res.json(buildFallbackResponse(serverName, players));
});

app.get('/api/refresh-status', (req, res) => {
  res.json(lastRefreshStatus);
});

app.post('/api/resolve-steam', async (req, res) => {
  const { steamUrl, steamId } = req.body || {};
  const nextUrl = steamUrl != null ? String(steamUrl).trim() : null;
  const nextId = steamId != null ? String(steamId).trim() : null;
  if (!nextUrl && !nextId) {
    return res.status(400).json({ error: 'steamUrl or steamId required' });
  }
  try {
    const resolvedId = nextId && /^\d{17}$/.test(nextId) ? nextId : await resolveSteamId64(nextUrl);
    const normalizedUrl = buildSteamUrl(nextUrl, resolvedId);
    res.json({ steamId: resolvedId || nextId || null, steamUrl: normalizedUrl || nextUrl || null });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Resolve failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on 0.0.0.0:${PORT}`);
});
