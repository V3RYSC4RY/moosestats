const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const MOOSE_URL = 'https://beta.moose.gg/stats';

const COLUMN_PATTERNS = {
  KDR: [/^kdr$/i],
  'PvP Kills': [/pvp\s*kills/i],
  'PvP Deaths': [/pvp\s*deaths/i],
  Suicides: [/suicides?/i],
  'Shots Fired': [/shots?\s*fired/i],
  'Shots Hit': [/shots?\s*hit/i],
  Headshots: [/headshots?/i],
  'Headshot %': [/(headshot|hs)\s*%/i],
};

const RESOURCE_COLUMN_PATTERNS = {
  Wood: [/^wood$/i],
  Stone: [/^stone$/i],
  'Metal Ore': [/metal\s*ore/i],
  'Sulfur Ore': [/sulfur\s*ore/i, /sufur\s*ore/i],
  'HQM Ore': [/hqm\s*ore/i, /high\s*quality\s*metal\s*ore/i],
};

const PVE_COLUMN_PATTERNS = {
  Scientist: [/scientist/i],
  'Tunnel Dweller': [/tunnel\s*dweller/i],
  Bear: [/^bear$/i],
  'Polar Bear': [/polar\s*bear/i],
  Boar: [/^boar$/i],
  Wolf: [/^wolf$/i],
  Stag: [/^stag$/i],
  Shark: [/^shark$/i],
  Crocodile: [/^crocodile$/i],
  Tiger: [/^tiger$/i],
  Panther: [/^panther$/i],
  Snake: [/^snake$/i],
  'Bradley APC': [/bradley\s*apc/i],
};

const TAB_DEFS = {
  pvp: { label: 'PvP', patterns: COLUMN_PATTERNS },
  pve: { label: 'PvE', patterns: PVE_COLUMN_PATTERNS },
  resources: { label: 'Resources', patterns: RESOURCE_COLUMN_PATTERNS },
  farming: { label: 'Farming', patterns: null },
  building: { label: 'Building', patterns: null },
};

const TAB_HEADER_MARKERS = {
  pvp: ['KDR', 'PvP Kills'],
  pve: ['Scientist', 'Tunnel Dweller', 'Bradley'],
  resources: ['Wood', 'Stone', 'Sulfur Ore'],
  farming: ['Cloth', 'Animal Fat', 'Leather'],
  building: ['Building'],
};

const FALLBACK_AVATAR =
  'https://steamcommunity-a.akamaihd.net/public/shared/images/responsive/share_steam_logo.png';

function steamIdFromUrl(steamUrl) {
  try {
    const u = new URL(steamUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.pop() || null;
  } catch {
    return null;
  }
}

async function resolveSteamId64(page, steamUrl) {
  const direct = steamIdFromUrl(steamUrl);
  if (direct && /^\d{17}$/.test(direct)) return direct;
  try {
    const xmlUrl = steamUrl.replace(/\/$/, '') + '/?xml=1';
    const resp = await page.request.get(xmlUrl, {
      timeout: 5000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
      },
    });
    if (resp.ok()) {
      const txt = await resp.text();
      const m = txt.match(/<steamID64>(\d{17})<\/steamID64>/);
      if (m?.[1]) return m[1];
    }
  } catch {
    // ignore
  }
  return null;
}

async function sampleDominantColor(page, imageUrl) {
  try {
    return await page.evaluate(async (url) => {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      const img = await createImageBitmap(blob);
      const targetW = Math.min(64, Math.max(8, img.width));
      const targetH = Math.max(8, Math.round((img.height / img.width) * targetW));
      const canvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(targetW, targetH)
          : (() => {
              const c = document.createElement('canvas');
              c.width = targetW;
              c.height = targetH;
              return c;
            })();
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, targetW, targetH);
      const { data } = ctx.getImageData(0, 0, targetW, targetH);
      let r = 0,
        g = 0,
        b = 0,
        count = 0;
      const step = Math.max(4, Math.floor(data.length / 800));
      for (let i = 0; i < data.length; i += step) {
        if (i % 4 !== 0) continue;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count += 1;
      }
      if (!count) return null;
      const avg = [r, g, b].map((v) => Math.min(255, Math.round(v / count)));
      const toHex = (v) => v.toString(16).padStart(2, '0');
      return `#${toHex(avg[0])}${toHex(avg[1])}${toHex(avg[2])}`;
    }, imageUrl);
  } catch {
    return null;
  }
}

function buildSteamProfileUrl(steamUrl, steamId) {
  if (steamUrl && /^https?:\/\//i.test(String(steamUrl))) return steamUrl;
  if (steamId && /^\d{17}$/.test(String(steamId))) {
    return `https://steamcommunity.com/profiles/${steamId}`;
  }
  return null;
}

async function fetchSteamProfile(page, steamUrl, steamIdInput) {
  const profileUrl = buildSteamProfileUrl(steamUrl, steamIdInput);
  const steamId = steamIdFromUrl(profileUrl || steamUrl);
  const request = page.request;
  let displayName = steamId || steamUrl;
  let resolvedSteamId = steamIdInput || steamId;
  let avatarUrl = FALLBACK_AVATAR;
  let color = '#66c0f4';
  try {
    if (!profileUrl) throw new Error('Missing Steam profile URL');
    const resp = await request.get(profileUrl, {
      timeout: 5000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
      },
    });
    if (resp.ok()) {
      const html = await resp.text();
      const idFromScript = html.match(/"steamid"\s*:\s*"(\d{17})"/i);
      if (idFromScript?.[1]) resolvedSteamId = idFromScript[1];
      const viaAvatar = html.match(/playerAvatarAutoSizeInner[^>]*>\s*<img[^>]*src="([^"]+)"/i);
      const viaOg = html.match(/property="og:image"\s+content="([^"]+)"/i);
      const nameFromOg = html.match(/property="og:title"\s+content="Steam Community :: ([^"]+)"/i);
      const nameFromSpan = html.match(/actual_persona_name[^>]*>\s*([^<]+)\s*</i);
      if (nameFromOg?.[1]) displayName = nameFromOg[1].trim();
      else if (nameFromSpan?.[1]) displayName = nameFromSpan[1].trim();
      if (viaAvatar?.[1]) avatarUrl = viaAvatar[1];
      else if (viaOg?.[1]) avatarUrl = viaOg[1];
    }
  } catch {
    // ignore
  }
  if (!resolvedSteamId || !/^\d{17}$/.test(resolvedSteamId)) {
    const resolved = await resolveSteamId64(page, profileUrl || steamUrl);
    if (resolved) resolvedSteamId = resolved;
  }
  const sampled = await sampleDominantColor(page, avatarUrl);
  if (sampled) color = sampled;
  return {
    steamUrl: profileUrl || steamUrl,
    steamId: resolvedSteamId || steamId,
    displayName,
    avatarUrl,
    color,
  };
}

async function selectServer(page, serverName, report) {
  const dropdown = page.locator('input.mud-select-input').first();
  report?.('Waiting for server dropdown...');
  await dropdown.waitFor({ state: 'visible', timeout: 10000 });
  await dropdown.scrollIntoViewIfNeeded();
  report?.('Opening server dropdown...');
  await dropdown.click({ force: true });

  const popover = page.locator('.mud-popover').first();
  let popoverVisible = true;
  try {
    await popover.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    popoverVisible = false;
  }
  if (!popoverVisible) {
    const selectRoot = page.locator('.mud-select').first();
    if ((await selectRoot.count()) > 0) {
      await selectRoot.click({ force: true });
    }
    await dropdown.focus();
    await page.keyboard.press('ArrowDown');
    await popover.waitFor({ state: 'visible', timeout: 5000 });
  }

  report?.('Choosing server option...');
  const items = popover.locator('.mud-list-item');
  await items.first().waitFor({ state: 'visible', timeout: 10000 });
  const desiredIndex = /biweekly/i.test(serverName) ? 6 : 0;
  let option = items.nth(desiredIndex);
  if ((await items.count()) <= desiredIndex) {
    option = items.filter({ hasText: serverName }).first();
  }
  await option.scrollIntoViewIfNeeded();
  await option.click({ force: true });
  await page.waitForTimeout(1500);
  await page.locator('table tbody').first().waitFor({ state: 'visible' });

  return { selectionLabel: serverName, itemsText: [], targetFound: true };
}

async function selectStatsTab(page, tabKey, report) {
  const tabDef = TAB_DEFS[tabKey] || { label: tabKey };
  const tabLabel = tabDef.label || tabKey;
  report?.(`Switching to ${tabLabel} tab...`);
  const tryClick = async (locator) => {
    if ((await locator.count()) === 0) return false;
    await locator.scrollIntoViewIfNeeded();
    await locator.click({ force: true });
    await page.waitForTimeout(500);
    return true;
  };

  const tabByExactText = page.getByRole('tab', { name: tabLabel, exact: true });
  if (await tryClick(tabByExactText)) return;
  const tabByText = page.locator('[role="tab"]', { hasText: tabLabel }).first();
  if (await tryClick(tabByText)) return;
  report?.(`Tab ${tabLabel} not found; continuing.`);
}

async function waitForHeaders(page, markers, timeout = 5000) {
  if (!markers || !markers.length) return;
  try {
    await page.waitForFunction(
      (tokens) => {
        const headers = Array.from(document.querySelectorAll('table thead th')).map((th) =>
          (th.textContent || '').trim()
        );
        return headers.some((h) => tokens.some((t) => h.toLowerCase().includes(t)));
      },
      markers.map((m) => String(m).toLowerCase()),
      { timeout }
    );
    return true;
  } catch {
    return false;
  }
}

async function mapTableColumns(page, columnPatterns) {
  await page.locator('table thead th').first().waitFor({ state: 'visible', timeout: 10000 });
  const headers = await page.locator('table thead th').evaluateAll((ths) =>
    ths.map((th) => (th.textContent || '').trim())
  );
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const columnMap = {};
  if (!columnPatterns) {
    const skip = new Set(['player', 'name', 'steamid', 'steam id']);
    const metrics = headers
      .map((h, idx) => ({ label: norm(h), idx }))
      .filter((h) => h.label && !skip.has(h.label.toLowerCase()));
    metrics.forEach((m) => {
      columnMap[m.label] = m.idx;
    });
    return { columnMap, metrics: metrics.map((m) => m.label) };
  }
  for (const [label, patterns] of Object.entries(columnPatterns)) {
    const idx = headers.findIndex((h) => patterns.some((re) => re.test(norm(h))));
    if (idx >= 0) {
      columnMap[label] = idx;
    }
  }
  return { columnMap, metrics: Object.keys(columnPatterns) };
}

async function mapColumnsByLabel(page, labels) {
  if (!labels || labels.length === 0) return { columnMap: {}, metrics: [] };
  await page.locator('table thead th').first().waitFor({ state: 'visible', timeout: 10000 });
  const headers = await page.locator('table thead th').evaluateAll((ths) =>
    ths.map((th) => (th.textContent || '').trim())
  );
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const headerMap = new Map(headers.map((h, idx) => [norm(h), idx]));
  const columnMap = {};
  labels.forEach((label) => {
    const idx = headerMap.get(norm(label));
    if (idx != null) columnMap[label] = idx;
  });
  return { columnMap, metrics: labels };
}

async function searchPlayerRow(page, profile) {
  const searchInput = page
    .locator(
      'input[placeholder="Search" i], input[type="search"], table input[type="text"], input.mud-input-root-outlined, input.mud-input-root, input.mud-input-slot'
    )
    .first();
  await searchInput.waitFor({ state: 'visible' });

  const rowBase = page.locator('table tbody tr');

  const tryAnchor = async (key) => {
    if (!key) return null;
    const row = rowBase.filter({ has: page.locator(`a[href*="${key}"]`) }).first();
    if ((await row.count()) > 0) {
      await row.first().waitFor();
      return row.first();
    }
    return null;
  };

  // Search by SteamID only; require an anchor match.
  if (profile.steamId) {
    await searchInput.fill(profile.steamId);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const byId = await tryAnchor(profile.steamId);
    if (byId) return byId;
  }

  // Then try searchKey (if provided and different), still requiring anchor match.
  if (profile.searchKey && profile.searchKey !== profile.steamId) {
    await searchInput.fill(profile.searchKey);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const byKey = await tryAnchor(profile.searchKey);
    if (byKey) return byKey;
  }

  // Fallback: try display name if nothing else matched (may be ambiguous).
  if (profile.displayName) {
    await searchInput.fill(profile.displayName);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const rowByName = rowBase.filter({ hasText: profile.displayName }).first();
    if ((await rowByName.count()) > 0) {
      await rowByName.waitFor();
      return rowByName;
    }
  }

  throw new Error(
    `Could not find player row by SteamID/searchKey for ${profile.displayName || profile.fallbackName}`
  );
}

async function resetTableSearch(page) {
  const searchInput = page
    .locator(
      'input[placeholder="Search" i], input[type="search"], table input[type="text"], input.mud-input-root-outlined, input.mud-input-root, input.mud-input-slot'
    )
    .first();
  if ((await searchInput.count()) === 0) return;
  await searchInput.fill('');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
}

async function extractStatsFromRow(row, columnMap, page, metricLabels) {
  const tds = row.locator('td');

  async function getNumeric(cell) {
    const text = (await cell.innerText()).trim();
    const numeric = text.replace(/[^\d.]/g, '');
    return Number(numeric || 0);
  }

  async function getTooltipNumber(cell) {
    try {
      await cell.hover({ force: true });
      await page.waitForTimeout(250);
      const popVals = await page.evaluate(() => {
        const selectors = [
          '.mud-popover-cascading-value',
          '[id*="popover"]',
          '.mud-tooltip-root',
          '.mud-tooltip-inline',
          '.mud-tooltip',
          '[role="tooltip"]',
        ];
        const nodes = selectors.flatMap((sel) => Array.from(document.querySelectorAll(sel)));
        return nodes.map((n) => n.textContent || '');
      });
      for (const val of popVals) {
        const cleaned = String(val || '').replace(/[^\d.]/g, '');
        if (cleaned) return Number(cleaned);
      }
    } catch {
      // ignore
    }
    return null;
  }

  async function getCol(label) {
    const idx = columnMap[label];
    if (idx == null) {
      if (label === 'Headshot %' && columnMap.Headshots != null) {
        const hsCell = tds.nth(columnMap.Headshots);
        const tooltip = await getTooltipNumber(hsCell);
        if (tooltip != null) return tooltip;
      }
      return 0;
    }
    const cell = tds.nth(idx);
    if (label === 'Headshot %') {
      const tooltip = await getTooltipNumber(cell);
      if (tooltip != null) return tooltip;
    }
    return getNumeric(cell);
  }

  const labels = metricLabels && metricLabels.length ? metricLabels : Object.keys(columnMap || {});
  const stats = {};
  for (const label of labels) {
    stats[label] = await getCol(label);
  }
  if (labels.includes('Headshot %') && stats['Shots Hit'] > 0 && stats.Headshots >= 0) {
    stats['Headshot %'] = Number(((stats.Headshots / stats['Shots Hit']) * 100).toFixed(2));
  }
  return stats;
}

async function getPlayerStats(page, profile, columnMap, metricLabels) {
  const row = await searchPlayerRow(page, profile);
  if (metricLabels && metricLabels.includes('Scientist') && columnMap?.Scientist != null) {
    const scientistCell = row.locator('td').nth(columnMap.Scientist);
    try {
      await scientistCell.waitFor({ state: 'visible', timeout: 4000 });
      await page.waitForFunction(
        (el) => /\d/.test((el && el.textContent) || ''),
        scientistCell,
        { timeout: 4000 }
      );
    } catch {
      // continue even if PvE cell doesn't resolve quickly
    }
  }
  return extractStatsFromRow(row, columnMap, page, metricLabels);
}

async function scrapePlayers(players, serverName = 'US Monthly (Premium)', onStatus, options = {}) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const report = (message) => {
    if (typeof onStatus === 'function') onStatus(message);
  };
  try {
    report('Opening Moose stats...');
    await page.goto(MOOSE_URL, { waitUntil: 'networkidle' });
    report(`Selecting server: ${serverName}`);
    const serverInfo = await selectServer(page, serverName, report);

    report('Loading player profiles...');
    const profiles = [];
    for (const p of players) {
      const needsProfile =
        !p.displayName ||
        !p.avatarUrl ||
        !p.steamId ||
        !/^\d{17}$/.test(String(p.steamId)) ||
        !p.color;
      const steamProfile = needsProfile
        ? await fetchSteamProfile(page, p.steamUrl, p.steamId)
        : {
            steamUrl: p.steamUrl,
            steamId: p.steamId,
            displayName: p.displayName,
            avatarUrl: p.avatarUrl,
            color: p.color || '#66c0f4',
          };
      const numericStoredId = p.steamId && /^\d{17}$/.test(String(p.steamId)) ? String(p.steamId) : null;
      const numericFetchedId =
        steamProfile.steamId && /^\d{17}$/.test(String(steamProfile.steamId))
          ? String(steamProfile.steamId)
          : null;
      const resolvedSteamId = numericFetchedId || numericStoredId || steamProfile.steamId;
      const displayName =
        p.displayName &&
        (steamProfile.displayName === steamProfile.steamId ||
          steamProfile.displayName === p.steamId ||
          steamProfile.displayName === p.steamUrl)
          ? p.displayName
          : steamProfile.displayName;
      const avatarUrl =
        steamProfile.avatarUrl === FALLBACK_AVATAR && p.avatarUrl
          ? p.avatarUrl
          : steamProfile.avatarUrl;
      const sampledColor = null;
      profiles.push({
        ...steamProfile,
        steamId: resolvedSteamId,
        displayName,
        avatarUrl,
        fallbackName: p.fallbackName || displayName || p.steamId || p.steamUrl,
        searchKey: resolvedSteamId || steamIdFromUrl(p.steamUrl) || p.steamUrl,
        color: sampledColor || steamProfile.color || p.color || '#66c0f4',
      });
    }

    const tabsToScrape = Array.isArray(options.tabs) && options.tabs.length ? options.tabs : null;
    const tabEntries = Object.entries(TAB_DEFS).filter(([key]) => !tabsToScrape || tabsToScrape.includes(key));
    const tabs = {};
    const missing = [];
    const missingIndexes = new Set();
    const scrapePvp = tabEntries.some(([key]) => key === 'pvp');
    report(`Scraping tabs: ${tabEntries.map(([key]) => key).join(', ')}`);
    for (const [tabKey, tabDef] of tabEntries) {
      await selectStatsTab(page, tabKey, report);
      const markers = TAB_HEADER_MARKERS[tabKey];
      if (markers && markers.length) {
        const ok = await waitForHeaders(page, markers, 8000);
        if (!ok) report?.(`${tabDef.label} headers not detected after tab switch.`);
      }
      await resetTableSearch(page);
      await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });
      report('Mapping table columns...');
      let { columnMap, metrics } = await mapTableColumns(page, tabDef.patterns);
      if (tabDef.patterns && Object.keys(columnMap).length === 0) {
        report(`No ${tabDef.label} columns matched. Retrying tab selection...`);
        await selectStatsTab(page, tabKey, report);
        if (markers && markers.length) {
          await waitForHeaders(page, markers, 8000);
        }
        await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });
        ({ columnMap, metrics } = await mapTableColumns(page, tabDef.patterns));
      }
      if (tabDef.patterns && Object.keys(columnMap).length === 0) {
        report(`No ${tabDef.label} columns matched after retry. Mapping by header labels...`);
        ({ columnMap, metrics } = await mapColumnsByLabel(page, Object.keys(tabDef.patterns)));
      }
      const stats = {};
      for (const [index, profile] of profiles.entries()) {
        if (scrapePvp && missingIndexes.has(index) && tabKey !== 'pvp') continue;
        const label = profile.displayName || profile.fallbackName;
        try {
          report(`Scraping ${label}...`);
          stats[label] = await getPlayerStats(page, profile, columnMap, metrics);
          if (tabKey === 'pvp') {
            // success on the primary tab
          }
        } catch (err) {
          if (tabKey === 'pvp') {
            missingIndexes.add(index);
            missing.push({
              label,
              steamId: profile.steamId,
              steamUrl: profile.steamUrl,
              reason: err.message || 'Missing player stats',
            });
          } else {
            report?.(`Failed ${tabDef.label} for ${label}: ${err.message || 'Unknown error'}`);
          }
        }
      }
      tabs[tabKey] = { metrics, stats, columnMap };
    }

    const profilesWithStatus = profiles.map((p, index) => {
      if (!scrapePvp) return { ...p, missing: false };
      const found = !missingIndexes.has(index);
      return { ...p, missing: !found };
    });

    report('Scrape complete.');
    return { profiles: profilesWithStatus, tabs, missing, serverInfo };
  } finally {
    await browser.close();
  }
}

module.exports = {
  scrapePlayers,
  steamIdFromUrl,
  FALLBACK_AVATAR,
  COLUMN_PATTERNS,
  TAB_DEFS,
};
