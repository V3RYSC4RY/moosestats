const { chromium } = require('playwright');
const { expect } = require('playwright/test');
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

const RETRY_BACKOFFS_MS = [250, 500, 750];

function isRetryableDetachError(err) {
  const message = String(err && err.message ? err.message : err);
  return message.includes('not attached to the DOM') || message.includes('Target closed');
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSearchInput(page) {
  return page
    .locator(
      'input[placeholder="Search" i], input[type="search"], table input[type="text"], input.mud-input-root-outlined, input.mud-input-root, input.mud-input-slot'
    )
    .first();
}

function getListContainer(page) {
  return page.locator('table tbody').first();
}

function escapeForAttrContains(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getPlayerRowLocator(page, key) {
  const safeKey = escapeForAttrContains(key);
  return page
    .locator('table tbody tr', { has: page.locator(`a[href*="${safeKey}"]`) })
    .first();
}

async function withDetachRetry(action, options = {}) {
  const {
    playerName = 'Unknown player',
    actionLabel = 'action',
    attempts = 3,
    backoffs = RETRY_BACKOFFS_MS,
    log,
  } = options;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (err) {
      if (!isRetryableDetachError(err) || attempt === attempts) {
        throw err;
      }
      const waitMs = backoffs[attempt - 1] || backoffs[backoffs.length - 1] || 250;
      const message = `Retry ${attempt}/${attempts} for ${playerName} (${actionLabel})`;
      if (typeof log === 'function') log(message);
      else console.warn(message);
      await delayMs(waitMs);
    }
  }
}

async function safeClick(page, locatorFn, options = {}) {
  const {
    containerLocatorFn,
    playerName = 'Unknown player',
    actionLabel = 'click',
    log,
    clickOptions = {},
    useTrial = true,
  } = options;
  return withDetachRetry(
    async () => {
      if (containerLocatorFn) {
        const container = containerLocatorFn();
        await expect(container).toBeVisible();
        await expect(container).toBeAttached();
      }
      const locator = locatorFn();
      await expect(locator).toBeVisible();
      await expect(locator).toBeAttached();

      let needsScroll = !useTrial;
      if (useTrial) {
        try {
          await locator.click({ trial: true });
        } catch (err) {
          if (isRetryableDetachError(err)) throw err;
          needsScroll = true;
        }
      }

      if (needsScroll) {
        const box = await locator.boundingBox();
        const viewport = page.viewportSize();
        const inViewport =
          box &&
          viewport &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= viewport.width &&
          box.y + box.height <= viewport.height;
        if (!inViewport) {
          await locator.scrollIntoViewIfNeeded();
        }
      }

      await locator.click(clickOptions);
    },
    { playerName, actionLabel, log }
  );
}

async function safeScrollIntoView(page, locatorFn, options = {}) {
  const { containerLocatorFn, playerName = 'Unknown player', actionLabel = 'scroll', log } = options;
  return withDetachRetry(
    async () => {
      if (containerLocatorFn) {
        const container = containerLocatorFn();
        await expect(container).toBeVisible();
        await expect(container).toBeAttached();
      }
      const locator = locatorFn();
      await expect(locator).toBeVisible();
      await expect(locator).toBeAttached();
      const box = await locator.boundingBox();
      const viewport = page.viewportSize();
      const inViewport =
        box &&
        viewport &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width &&
        box.y + box.height <= viewport.height;
      if (!inViewport) {
        await locator.scrollIntoViewIfNeeded();
      }
    },
    { playerName, actionLabel, log }
  );
}

async function safeHover(page, locatorFn, options = {}) {
  const { containerLocatorFn, playerName = 'Unknown player', actionLabel = 'hover', log } = options;
  return withDetachRetry(
    async () => {
      if (containerLocatorFn) {
        const container = containerLocatorFn();
        await expect(container).toBeVisible();
        await expect(container).toBeAttached();
      }
      const locator = locatorFn();
      await expect(locator).toBeVisible();
      await expect(locator).toBeAttached();
      const box = await locator.boundingBox();
      const viewport = page.viewportSize();
      const inViewport =
        box &&
        viewport &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width &&
        box.y + box.height <= viewport.height;
      if (!inViewport) {
        await locator.scrollIntoViewIfNeeded();
      }
      await locator.hover({ force: true });
    },
    { playerName, actionLabel, log }
  );
}

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
  const dropdownLocatorFn = () => page.locator('input.mud-select-input').first();
  report?.('Waiting for server dropdown...');
  await expect(dropdownLocatorFn()).toBeVisible({ timeout: 10000 });
  await expect(dropdownLocatorFn()).toBeAttached({ timeout: 10000 });
  report?.('Opening server dropdown...');
  await safeClick(page, dropdownLocatorFn, {
    actionLabel: 'open server dropdown',
    clickOptions: { force: true },
  });

  const popover = page.locator('.mud-popover').first();
  let popoverVisible = true;
  try {
    await popover.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    popoverVisible = false;
  }
  if (!popoverVisible) {
    const selectRootLocatorFn = () => page.locator('.mud-select').first();
    if ((await selectRootLocatorFn().count()) > 0) {
      await safeClick(page, selectRootLocatorFn, {
        actionLabel: 'open server dropdown fallback',
        clickOptions: { force: true },
      });
    }
    await dropdownLocatorFn().focus();
    await page.keyboard.press('ArrowDown');
    await popover.waitFor({ state: 'visible', timeout: 5000 });
  }

  report?.('Choosing server option...');
  const itemsLocatorFn = () => page.locator('.mud-popover .mud-list-item');
  await expect(itemsLocatorFn().first()).toBeVisible({ timeout: 10000 });
  const desiredIndex = /biweekly/i.test(serverName) ? 6 : 0;
  let optionLocatorFn = () => itemsLocatorFn().nth(desiredIndex);
  if ((await itemsLocatorFn().count()) <= desiredIndex) {
    optionLocatorFn = () => itemsLocatorFn().filter({ hasText: serverName }).first();
  }
  await safeClick(page, optionLocatorFn, {
    actionLabel: 'select server option',
    clickOptions: { force: true },
  });
  await page.waitForTimeout(1500);
  await page.locator('table tbody').first().waitFor({ state: 'visible' });

  return { selectionLabel: serverName, itemsText: [], targetFound: true };
}

async function selectStatsTab(page, tabKey, report) {
  const tabDef = TAB_DEFS[tabKey] || { label: tabKey };
  const tabLabel = tabDef.label || tabKey;
  report?.(`Switching to ${tabLabel} tab...`);
  const tryClick = async (locatorFn) => {
    if ((await locatorFn().count()) === 0) return false;
    await safeClick(page, locatorFn, {
      actionLabel: `tab ${tabLabel}`,
      clickOptions: { force: true },
    });
    await page.waitForTimeout(500);
    return true;
  };

  const tabByExactText = () => page.getByRole('tab', { name: tabLabel, exact: true });
  if (await tryClick(tabByExactText)) return;
  const tabByText = () => page.locator('[role="tab"]', { hasText: tabLabel }).first();
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
  const searchInput = getSearchInput(page);
  await expect(searchInput).toBeVisible({ timeout: 10000 });
  await expect(searchInput).toBeAttached({ timeout: 10000 });
  const listContainerFn = () => getListContainer(page);
  await expect(listContainerFn()).toBeVisible({ timeout: 10000 });
  await expect(listContainerFn()).toBeAttached({ timeout: 10000 });

  const tryAnchor = async (key) => {
    if (!key) return null;
    const rowLocatorFn = () => getPlayerRowLocator(page, key);
    if ((await rowLocatorFn().count()) > 0) {
      await expect(rowLocatorFn()).toBeVisible({ timeout: 10000 });
      await expect(rowLocatorFn()).toBeAttached({ timeout: 10000 });
      return key;
    }
    return null;
  };

  // Search by SteamID only; require an anchor match.
  const id64 =
    (profile.steamId && /^\d{17}$/.test(String(profile.steamId)) && String(profile.steamId)) ||
    (profile.searchKey && /^\d{17}$/.test(String(profile.searchKey)) && String(profile.searchKey)) ||
    null;
  if (id64) {
    await searchInput.fill(id64);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const byId = await tryAnchor(id64);
    if (byId) return byId;
  }

  // Then try searchKey (if provided and different), still requiring anchor match.
  if (profile.steamId && String(profile.steamId) !== String(id64)) {
    await searchInput.fill(profile.steamId);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const byId = await tryAnchor(profile.steamId);
    if (byId) return byId;
  }

  if (profile.searchKey && String(profile.searchKey) !== String(id64)) {
    await searchInput.fill(profile.searchKey);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const byKey = await tryAnchor(profile.searchKey);
    if (byKey) return byKey;
  }

  throw new Error(
    `Could not find player row by SteamID/searchKey for ${profile.displayName || profile.fallbackName}`
  );
}

async function resetTableSearch(page) {
  const searchInput = getSearchInput(page);
  if ((await searchInput.count()) === 0) return;
  await expect(searchInput).toBeVisible();
  await expect(searchInput).toBeAttached();
  await searchInput.fill('');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
}

async function extractStatsFromRow(rowLocatorFn, columnMap, page, metricLabels, options = {}) {
  const { playerName = 'Unknown player', listContainerFn, log } = options;
  const cellLocatorFn = (idx) => rowLocatorFn().locator('td').nth(idx);

  async function getNumeric(cellLocator) {
    const cell = cellLocator();
    const text = (await cell.innerText()).trim();
    const numeric = text.replace(/[^\d.]/g, '');
    return Number(numeric || 0);
  }

  async function getTooltipNumber(cellLocator, label) {
    try {
      await safeHover(page, cellLocator, {
        containerLocatorFn: listContainerFn,
        playerName,
        actionLabel: `${label} tooltip`,
        log,
      });
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
        const tooltip = await getTooltipNumber(
          () => cellLocatorFn(columnMap.Headshots),
          label
        );
        if (tooltip != null) return tooltip;
      }
      return 0;
    }
    if (label === 'Headshot %') {
      const tooltip = await getTooltipNumber(() => cellLocatorFn(idx), label);
      if (tooltip != null) return tooltip;
    }
    return getNumeric(() => cellLocatorFn(idx));
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
  const label =
    profile.displayName || profile.fallbackName || profile.steamId || profile.steamUrl || 'Unknown player';
  const rowKey = await searchPlayerRow(page, profile);
  const listContainerFn = () => getListContainer(page);
  const rowLocatorFn = () => getPlayerRowLocator(page, rowKey);
  const retryLog = (message) => console.warn(message);

  return withDetachRetry(
    async () => {
      await expect(listContainerFn()).toBeVisible();
      await expect(listContainerFn()).toBeAttached();
      const row = rowLocatorFn();
      await expect(row).toBeVisible();
      await expect(row).toBeAttached();
      await safeScrollIntoView(page, rowLocatorFn, {
        containerLocatorFn: listContainerFn,
        playerName: label,
        actionLabel: 'player row',
        log: retryLog,
      });

      if (metricLabels && metricLabels.includes('Scientist') && columnMap?.Scientist != null) {
        const scientistCell = rowLocatorFn().locator('td').nth(columnMap.Scientist);
        try {
          await expect(scientistCell).toBeVisible({ timeout: 4000 });
          await page.waitForFunction(
            (el) => /\d/.test((el && el.textContent) || ''),
            scientistCell,
            { timeout: 4000 }
          );
        } catch {
          // continue even if PvE cell doesn't resolve quickly
        }
      }

      return extractStatsFromRow(rowLocatorFn, columnMap, page, metricLabels, {
        playerName: label,
        listContainerFn,
        log: retryLog,
      });
    },
    { playerName: label, actionLabel: 'read stats', log: retryLog }
  );
}

async function scrapePlayers(players, serverName = 'US Monthly (Premium)', onStatus, options = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  const report = (message) => {
    if (typeof onStatus === 'function') onStatus(message);
  };
  const timingStart = Date.now();
  const strategy = options.strategy === 'perPlayer' ? 'perPlayer' : 'perTab';
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
      profiles.push({
        ...steamProfile,
        steamId: resolvedSteamId,
        displayName,
        avatarUrl,
        fallbackName: p.fallbackName || displayName || p.steamId || p.steamUrl,
        searchKey: resolvedSteamId || steamIdFromUrl(p.steamUrl) || p.steamUrl,
        color: steamProfile.color || p.color || '#66c0f4',
      });
    }

    const tabsToScrape = Array.isArray(options.tabs) && options.tabs.length ? options.tabs : null;
    const tabEntries = Object.entries(TAB_DEFS).filter(([key]) => !tabsToScrape || tabsToScrape.includes(key));
    const tabs = {};
    const missing = [];
    const missingIndexes = new Set();
    const scrapePvp = tabEntries.some(([key]) => key === 'pvp');
    report(`Scraping tabs: ${tabEntries.map(([key]) => key).join(', ')} (${strategy})`);
    const totalTabs = tabEntries.length || 1;
    const tabCache = {};

    const ensureTabReady = async (tabKey, tabDef, reportProgress) => {
      if (tabCache[tabKey]) return tabCache[tabKey];
      await selectStatsTab(page, tabKey, reportProgress);
      const markers = TAB_HEADER_MARKERS[tabKey];
      if (markers && markers.length) {
        const ok = await waitForHeaders(page, markers, 8000);
        if (!ok) reportProgress(`${tabDef.label} headers not detected after tab switch.`);
      }
      await resetTableSearch(page);
      await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });
      reportProgress(`${tabDef.label}: Mapping table columns...`);
      let { columnMap, metrics } = await mapTableColumns(page, tabDef.patterns);
      if (tabDef.patterns && Object.keys(columnMap).length === 0) {
        reportProgress(`No ${tabDef.label} columns matched. Retrying tab selection...`);
        await selectStatsTab(page, tabKey, reportProgress);
        if (markers && markers.length) {
          await waitForHeaders(page, markers, 8000);
        }
        await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });
        ({ columnMap, metrics } = await mapTableColumns(page, tabDef.patterns));
      }
      if (tabDef.patterns && Object.keys(columnMap).length === 0) {
        reportProgress(`No ${tabDef.label} columns matched after retry. Mapping by header labels...`);
        ({ columnMap, metrics } = await mapColumnsByLabel(page, Object.keys(tabDef.patterns)));
      }
      tabCache[tabKey] = { columnMap, metrics };
      tabs[tabKey] = { metrics, stats: {}, columnMap };
      return tabCache[tabKey];
    };

    if (strategy === 'perPlayer') {
      for (const [profileIndex, profile] of profiles.entries()) {
        const label = profile.displayName || profile.fallbackName;
        for (const [tabIndex, [tabKey, tabDef]] of tabEntries.entries()) {
          if (scrapePvp && missingIndexes.has(profileIndex) && tabKey !== 'pvp') continue;
          const progressPrefix = `Loading... (${tabIndex + 1}/${totalTabs})`;
          const reportProgress = (detail) => report?.(`${progressPrefix}||${detail}`);
          const { columnMap, metrics } = await ensureTabReady(tabKey, tabDef, reportProgress);
          await resetTableSearch(page);
          await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });
          try {
            reportProgress(`${tabDef.label}: Scraping ${label}...`);
            const stats = await getPlayerStats(page, profile, columnMap, metrics);
            tabs[tabKey].stats[label] = stats;
          } catch (err) {
            if (tabKey === 'pvp') {
              missingIndexes.add(profileIndex);
              missing.push({
                label,
                steamId: profile.steamId,
                steamUrl: profile.steamUrl,
                reason: err.message || 'Missing player stats',
              });
            } else {
              reportProgress(`Failed ${tabDef.label} for ${label}: ${err.message || 'Unknown error'}`);
            }
          }
        }
      }
    } else {
      for (const [index, [tabKey, tabDef]] of tabEntries.entries()) {
        const progressPrefix = `Loading... (${index + 1}/${totalTabs})`;
        const reportProgress = (detail) => report?.(`${progressPrefix}||${detail}`);
        const { columnMap, metrics } = await ensureTabReady(tabKey, tabDef, reportProgress);
        const stats = {};
        for (const [profileIndex, profile] of profiles.entries()) {
          if (scrapePvp && missingIndexes.has(profileIndex) && tabKey !== 'pvp') continue;
          const label = profile.displayName || profile.fallbackName;
          try {
            reportProgress(`${tabDef.label}: Scraping ${label}...`);
            stats[label] = await getPlayerStats(page, profile, columnMap, metrics);
          } catch (err) {
            if (tabKey === 'pvp') {
              missingIndexes.add(profileIndex);
              missing.push({
                label,
                steamId: profile.steamId,
                steamUrl: profile.steamUrl,
                reason: err.message || 'Missing player stats',
              });
            } else {
              reportProgress(`Failed ${tabDef.label} for ${label}: ${err.message || 'Unknown error'}`);
            }
          }
        }
        tabs[tabKey] = { metrics, stats, columnMap };
      }
    }

    const profilesWithStatus = profiles.map((p, index) => {
      if (!scrapePvp) return { ...p, missing: false };
      const found = !missingIndexes.has(index);
      return { ...p, missing: !found };
    });

    const durationMs = Date.now() - timingStart;
    report(`Scrape complete (${strategy}, ${durationMs}ms).`);
    return { profiles: profilesWithStatus, tabs, missing, serverInfo, timings: { strategy, durationMs } };
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
