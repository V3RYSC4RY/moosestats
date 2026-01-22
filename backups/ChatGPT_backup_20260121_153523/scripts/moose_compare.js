/**
 * Compare Moose stats for configured players and render a Chart.js bar chart.
 * Requires Playwright (`npm install playwright`) and downloads Chromium via `npx playwright install chromium`.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const MOOSE_URL = 'https://beta.moose.gg/stats';
const SERVER_OPTIONS = ['US Monthly (Premium)', 'US Biweekly (Premium)'];

function resolveServerName() {
  const args = process.argv.slice(2);
  let candidate = null;
  const serverFlagIndex = args.indexOf('--server');
  if (serverFlagIndex >= 0 && args[serverFlagIndex + 1]) {
    candidate = args[serverFlagIndex + 1];
  } else if (process.env.MOOSE_SERVER) {
    candidate = process.env.MOOSE_SERVER;
  }
  if (candidate) {
    const match = SERVER_OPTIONS.find(
      (name) => name.toLowerCase() === String(candidate).trim().toLowerCase()
    );
    if (match) return match;
  }
  return SERVER_OPTIONS[0];
}

const SELECTED_SERVER = resolveServerName();
const SERVER_NAME = `Rusty Moose |${SELECTED_SERVER}| Stats Comparison`;
const FALLBACK_AVATAR =
  'https://steamcommunity-a.akamaihd.net/public/shared/images/responsive/share_steam_logo.png';

// Players to compare; Steam profile drives current display name and avatar.
const PLAYER_CONFIG = [
  {
    steamUrl: 'https://steamcommunity.com/profiles/76561198062944336',
    steamId: '76561198062944336',
    fallbackName: 'VeryScary',
    color: '#66c0f4',
  },
  {
    steamUrl: 'https://steamcommunity.com/profiles/76561198880952190',
    steamId: '76561198880952190',
    fallbackName: 'DAVE',
    color: '#b3e0ff',
  },
];

// Column header patterns used to find relevant data columns dynamically.
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

async function selectServer(page, serverName) {
  // OG MudSelect flow: click input, then select option by text.
  const dropdown = page.locator('input.mud-select-input').first();
  await dropdown.waitFor({ state: 'visible', timeout: 10000 });
  await dropdown.click();

  const popover = page.locator('.mud-popover').first();
  await popover.waitFor({ state: 'visible', timeout: 10000 });
  const option = popover.locator('.mud-list-item', { hasText: serverName }).first();
  await option.waitFor({ state: 'visible' });
  await option.click();
}

async function searchPlayerAndGetRow(page, profile) {
  const searchInput = page
    .locator(
      'input[placeholder="Search" i], input[type="search"], table input[type="text"], input.mud-input-root-outlined, input.mud-input-root, input.mud-input-slot'
    )
    .first();
  await searchInput.waitFor({ state: 'visible' });

  const queries = [
    profile.searchKey,
    profile.steamId,
    profile.displayName,
    profile.fallbackName,
  ].filter(Boolean);

  const rowBase = page.locator('table tbody tr');
  const anchorMatch = (key) =>
    rowBase.filter({ has: page.locator(`a[href*="${key}"]`) }).first();

  // Try display name first (Moose search matches names reliably).
  if (profile.displayName) {
    await searchInput.fill('');
    await searchInput.fill(String(profile.displayName));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    const rowByName = rowBase.filter({ hasText: profile.displayName }).first();
    if ((await rowByName.count()) > 0) {
      await rowByName.waitFor();
      return rowByName;
    }
  }

  for (const query of queries) {
    await searchInput.fill('');
    await searchInput.fill(String(query));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    // Prefer matching rows that contain the Steam ID in a link.
    if (profile.steamId || profile.searchKey) {
      const key = profile.steamId || profile.searchKey;
      const rowById = anchorMatch(key);
      if ((await rowById.count()) > 0) {
        await rowById.first().waitFor();
        return rowById.first();
      }
    }

    const rowByText = rowBase.filter({ hasText: query }).first();
    if ((await rowByText.count()) > 0) {
      await rowByText.waitFor();
      return rowByText;
    }
  }

  throw new Error(`Could not find player row for ${profile.displayName || profile.fallbackName}`);
}

async function extractStatsFromRow(row, columnMap, page) {
  const tds = row.locator('td');

  async function getNumericFromCell(cell) {
    const text = (await cell.innerText()).trim();
    const numeric = text.replace(/[^\d.]/g, '');
    return Number(numeric || 0);
  }

  async function getTooltipNumber(cell, page) {
    const candidates = await cell.evaluate((el) => {
      const vals = [];
      const ids = [];
      const take = (v) => {
        if (v && typeof v === 'string') vals.push(v);
      };
      take(el.getAttribute && el.getAttribute('title'));
      take(el.getAttribute && el.getAttribute('aria-label'));
      const ref = el.getAttribute && el.getAttribute('aria-describedby');
      if (ref) {
        const o = document.getElementById(ref);
        if (o) take(o.textContent || '');
        ids.push(ref);
      }
      if (el.id) ids.push(el.id);
      const popovers = el.querySelectorAll
        ? el.querySelectorAll('[id*="popover"], .mud-popover-cascading-value')
        : [];
      popovers.forEach((p) => {
        if (p.id) ids.push(p.id);
        take(p.textContent || '');
      });
      const nested = el.querySelectorAll
        ? el.querySelectorAll('[title],[aria-label],[data-tooltip],[data-tip]')
        : [];
      nested.forEach((n) => {
        take(n.getAttribute && n.getAttribute('title'));
        take(n.getAttribute && n.getAttribute('aria-label'));
        const r = n.getAttribute && n.getAttribute('aria-describedby');
        if (r) {
          const t = document.getElementById(r);
          if (t) take(t.textContent || '');
          ids.push(r);
        }
        if (n.dataset) {
          take(n.dataset.tooltip);
          take(n.dataset.tip);
        }
      });
      if (el.dataset) {
        take(el.dataset.tooltip);
        take(el.dataset.tip);
      }
      return { vals, ids };
    });

    const parseList = (list) => {
      for (const val of list) {
        if (!val) continue;
        const cleaned = String(val).replace(/[^\d.]/g, '');
        if (cleaned) return Number(cleaned);
      }
      return null;
    };

    const primary = parseList(candidates.vals || []);
    if (primary != null) return primary;

    if (page) {
      await cell.hover({ force: true });
      await page.waitForTimeout(300);

      // First, check any specific popover IDs found inside the cell and wait for their text.
      for (const id of candidates.ids || []) {
        if (!id) continue;
        try {
          const tipText = await page.evaluate(
            async (tipId) => {
              const el = document.getElementById(tipId);
              if (!el) return '';
              return el.textContent || '';
            },
            id
          );
          const cleaned = String(tipText || '').replace(/[^\d.]/g, '');
          if (cleaned) return Number(cleaned);

          // Wait briefly for text to populate.
          const later = await page.waitForFunction(
            (tipId) => {
              const el = document.getElementById(tipId);
              return el && /\d/.test(el.textContent || '');
            },
            { timeout: 500 },
            id
          );
          if (later) {
            const laterText = await page.evaluate(
              (tipId) => {
                const el = document.getElementById(tipId);
                return el ? el.textContent || '' : '';
              },
              id
            );
            const laterClean = String(laterText || '').replace(/[^\d.]/g, '');
            if (laterClean) return Number(laterClean);
          }
        } catch (_) {
          continue;
        }
      }

      // Fallback: grab any visible popover/tooltip text after hover.
      const popVals = await page.evaluate(() => {
        const selectors = [
          '.mud-popover-cascading-value',
          '[id*=\"popover\"]',
          '.mud-tooltip-root',
          '.mud-tooltip-inline',
          '.mud-tooltip',
          '[role=\"tooltip\"]',
        ];
        const nodes = selectors.flatMap((sel) => Array.from(document.querySelectorAll(sel)));
        return nodes.map((n) => n.textContent || '');
      });
      const popParsed = parseList(popVals);
      if (popParsed != null) return popParsed;
    }
    return null;
  }

  async function getCol(label) {
    const idx = columnMap[label];
    if (idx == null) {
      // If there's no dedicated column for Headshot %, try to read a tooltip on the headshots cell.
      if (label === 'Headshot %' && columnMap.Headshots != null) {
        const hsCell = tds.nth(columnMap.Headshots);
        const tooltip = await getTooltipNumber(hsCell);
        return tooltip ?? 0;
      }
      return 0;
    }
    const cell = tds.nth(idx);
    // Headshot % may live in a tooltip/title; prefer tooltip content if present.
    if (label === 'Headshot %') {
      const tooltip = await getTooltipNumber(cell);
      if (tooltip != null) return tooltip;
    }
    return getNumericFromCell(cell);
  }

  const stats = {};
  for (const label of Object.keys(COLUMN_PATTERNS)) {
    stats[label] = await getCol(label);
  }
  return stats;
}

function deriveSearchKey(config) {
  if (config.steamId) return config.steamId;
  const fallbackName = config.fallbackName;
  const steamUrl = config.steamUrl || '';
  try {
    const url = new URL(steamUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    return last || fallbackName;
  } catch {
    return fallbackName;
  }
}

async function getPlayerStats(page, profile, columnMap) {
  const row = await searchPlayerAndGetRow(page, profile);
  if (columnMap.Headshots != null) {
    try {
      const hsCell = row.locator('td').nth(columnMap.Headshots);
      const hsDebug = await hsCell.evaluate((el) => ({
        text: el.textContent,
        title: el.getAttribute && el.getAttribute('title'),
        aria: el.getAttribute && el.getAttribute('aria-label'),
        describedby: el.getAttribute && el.getAttribute('aria-describedby'),
        html: el.innerHTML,
      }));
      console.log('Headshot cell debug:', hsDebug);
    } catch (_) {
      // ignore debug errors
    }
  }
  const stats = await extractStatsFromRow(row, columnMap, page);
  // Derive headshot % from counts to avoid duplicating raw headshot totals.
  if (stats['Shots Hit'] > 0 && stats.Headshots >= 0) {
    stats['Headshot %'] = Number(((stats.Headshots / stats['Shots Hit']) * 100).toFixed(2));
  }
  return stats;
}

async function fetchSteamAvatar(request, steamUrl) {
  try {
    const resp = await request.get(steamUrl, {
      timeout: 5000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
      },
    });
    if (!resp.ok()) return null;
    const html = await resp.text();
    const viaAvatarBox = html.match(
      /playerAvatarAutoSizeInner[^>]*>\s*<img[^>]*src="([^"]+)"/i
    );
    if (viaAvatarBox?.[1]) return viaAvatarBox[1];
    const viaOg = html.match(/property="og:image"\s+content="([^"]+)"/i);
    if (viaOg?.[1]) return viaOg[1];
    return null;
  } catch (err) {
    return null;
  }
}

async function fetchSteamDisplayName(request, steamUrl) {
  try {
    const resp = await request.get(steamUrl, {
      timeout: 5000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
      },
    });
    if (!resp.ok()) return null;
    const html = await resp.text();
    const fromOg = html.match(/property="og:title"\s+content="Steam Community :: ([^"]+)"/i);
    if (fromOg?.[1]) return fromOg[1].trim();
    const fromSpan = html.match(/actual_persona_name[^>]*>\s*([^<]+)\s*</i);
    if (fromSpan?.[1]) return fromSpan[1].trim();
    return null;
  } catch (err) {
    return null;
  }
}

async function resolvePlayerProfiles(page) {
  const { request } = page;

  const profiles = await Promise.all(
    PLAYER_CONFIG.map(async (cfg) => {
    const steamUrl = cfg.steamUrl;
    let avatarUrl = FALLBACK_AVATAR;
    let displayName = cfg.fallbackName;
    const searchKey = deriveSearchKey(cfg);

      if (steamUrl) {
        const fetched = await fetchSteamAvatar(request, steamUrl);
        if (fetched) avatarUrl = fetched;
        const nameFromSteam = await fetchSteamDisplayName(request, steamUrl);
        if (nameFromSteam) displayName = nameFromSteam;
      }

      let sampledColor = null;
      if (avatarUrl) {
        sampledColor = await sampleDominantColor(page, avatarUrl);
      }

    return {
      steamUrl,
      steamId: cfg.steamId || null,
      avatarUrl,
      displayName,
      fallbackName: cfg.fallbackName,
      searchKey,
      color: sampledColor || cfg.color || '#66c0f4',
    };
  })
  );

  return profiles;
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
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      // Sample every nth pixel to keep it quick.
      const step = Math.max(4, Math.floor(data.length / 800));
      for (let i = 0; i < data.length; i += step) {
        if ((i % 4) !== 0) continue; // stay on red channel to align sampling
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
  } catch (err) {
    return null;
  }
}

async function mapTableColumns(page) {
  const headers = await page.locator('table thead th').evaluateAll((ths) =>
    ths.map((th) => (th.textContent || '').trim())
  );
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const columnMap = {};
  for (const [label, patterns] of Object.entries(COLUMN_PATTERNS)) {
    const idx = headers.findIndex((h) => patterns.some((re) => re.test(norm(h))));
    if (idx >= 0) {
      columnMap[label] = idx;
    }
  }
  return columnMap;
}

function buildChartHtml(playerStats, playerProfiles) {
  const metrics = Object.keys(COLUMN_PATTERNS);
  const labels = metrics;
  const datasetLabels = Object.keys(playerStats);

  const datasets = datasetLabels.map((playerName) => {
    const stats = playerStats[playerName];
    const meta = playerProfiles[playerName] || {};
    const color = meta.color || '#66c0f4';
    const bg = hexToRgba(color, 0.35);
    const border = color;
    const realValues = metrics.map((metric) => stats[metric] ?? 0);
    const dataValues = realValues.map((val) => (val > 0 ? val : 0.1)); // keep log scale happy
    return {
      label: playerName,
      data: dataValues,
      realValues,
      backgroundColor: bg,
      borderColor: border,
      borderWidth: 2,
      avatarUrl: meta.avatarUrl || FALLBACK_AVATAR,
    };
  });

  const profileData = datasetLabels.map((name) => ({
    name,
    steamUrl: playerProfiles[name]?.steamUrl || '',
    avatarUrl: playerProfiles[name]?.avatarUrl || FALLBACK_AVATAR,
    color: playerProfiles[name]?.color || '#66c0f4',
  }));

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${SERVER_NAME} Stats Comparison</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js"></script>
  <style>
    :root {
      --steam-bg: #0f1a24;
      --steam-panel: #0b141d;
      --steam-accent: #66c0f4;
      --text-primary: #e5f1ff;
      --text-secondary: #9bb6cc;
      --card-border: rgba(102, 192, 244, 0.25);
    }
    * { box-sizing: border-box; }
    body {
      font-family: "Segoe UI", Roboto, system-ui, -apple-system, sans-serif;
      background: radial-gradient(circle at 20% 20%, rgba(102,192,244,0.08), transparent 30%),
                  radial-gradient(circle at 80% 0%, rgba(102,192,244,0.08), transparent 30%),
                  var(--steam-bg);
      color: var(--text-primary);
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px;
    }
    .panel {
      background: linear-gradient(135deg, rgba(20,33,44,0.8), rgba(12,20,28,0.95));
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      width: min(1200px, 98vw);
      box-shadow: 0 20px 50px rgba(0,0,0,0.45);
    }
    h1 {
      margin: 0;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    h2 {
      margin: 4px 0 16px 0;
      font-weight: 400;
      color: var(--text-secondary);
      font-size: 14px;
    }
    .players {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .player-card {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 10px;
    }
    .avatar {
      width: 42px;
      height: 42px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.08);
      object-fit: cover;
      background: #091017;
    }
    .player-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .player-name {
      font-weight: 600;
      color: var(--text-primary);
    }
    .player-link {
      color: var(--steam-accent);
      text-decoration: none;
      font-size: 12px;
      opacity: 0.85;
    }
    .chart-wrap {
      height: min(70vh, 760px);
      min-height: 420px;
      width: 100%;
    }
    canvas {
      width: 100% !important;
      height: 100% !important;
    }
    .meta {
      margin-top: 12px;
      font-size: 13px;
      color: var(--text-secondary);
    }
  </style>
</head>
<body>
  <div class="panel">
    <h1>${SERVER_NAME} Stats Comparison</h1>
    <h2>${datasetLabels.join(' vs ')}</h2>

    <div class="players">
      ${profileData
        .map(
          (p) => `<div class="player-card" style="border-color:${hexToRgba(
            p.color,
            0.35
          )};">
            <img class="avatar" src="${p.avatarUrl}" alt="${p.name} avatar" />
            <div class="player-meta">
              <span class="player-name" style="color:${p.color}">${p.name}</span>
              ${
                p.steamUrl
                  ? `<a class="player-link" href="${p.steamUrl}" target="_blank" rel="noreferrer">Steam Profile</a>`
                  : ''
              }
            </div>
          </div>`
        )
        .join('')}
    </div>

    <div class="chart-wrap">
      <canvas id="statsChart"></canvas>
    </div>
  </div>
  <script>
    const ctx = document.getElementById('statsChart').getContext('2d');
    const formatNumber = (n) => {
      const abs = Math.abs(n);
      if (abs >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'm';
      if (abs >= 1e3) return (n / 1e3).toFixed(2).replace(/\.?0+$/, '') + 'k';
      return Number.isInteger(n) ? n.toString() : n.toFixed(2);
    };

    const data = {
      labels: ${JSON.stringify(labels)},
      datasets: ${JSON.stringify(datasets)},
    };
    const barValuePlugin = {
      id: 'barValuePlugin',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        const font = { size: 12, weight: '700', family: 'Segoe UI' };
        chart.data.datasets.forEach((dataset, i) => {
          const meta = chart.getDatasetMeta(i);
          meta.data.forEach((bar, index) => {
            const real = dataset.realValues ? dataset.realValues[index] : dataset.data[index];
            const label = formatNumber(real ?? 0);
            const pos = bar.tooltipPosition();
            ctx.save();
            ctx.font = font.weight + ' ' + font.size + 'px ' + font.family;
            ctx.fillStyle = dataset.borderColor || '#fff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(label, pos.x, pos.y - 4);
            ctx.restore();
          });
        });
      },
    };
    new Chart(ctx, {
      type: 'bar',
      data,
      options: {
        maintainAspectRatio: false,
        responsive: true,
        scales: {
          x: { stacked: false, grid: { display: false } },
          y: {
            type: 'logarithmic',
            min: 0.1,
            grace: '20%',
            ticks: {
              callback: () => '',
            },
            grid: { display: false },
          },
        },
        layout: {
          padding: { top: 20 },
        },
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            enabled: false,
            external: (context) => {
              const { chart, tooltip } = context;
              let el = document.getElementById('chartjs-external-tooltip');
              if (!el) {
                el = document.createElement('div');
                el.id = 'chartjs-external-tooltip';
                el.style.position = 'absolute';
                el.style.pointerEvents = 'none';
                el.style.zIndex = '9999';
                document.body.appendChild(el);
              }
              if (!tooltip || !tooltip.dataPoints || !tooltip.dataPoints.length) {
                el.style.opacity = '0';
                return;
              }
              const dp = tooltip.dataPoints[0];
              const dataset = chart.data.datasets[dp.datasetIndex];
              const value =
                (dataset.realValues && dataset.realValues[dp.dataIndex]) ??
                dp.parsed.y ??
                dp.raw ??
                0;
              const color = dataset.borderColor || '#66c0f4';
              const avatar = dataset.avatarUrl || '${FALLBACK_AVATAR}';
              el.innerHTML = '' +
                '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;' +
                'background: rgba(12,16,24,0.95);' +
                'border: 1px solid rgba(102,192,244,0.35);' +
                'border-left: 3px solid ' + color + ';' +
                'border-radius: 10px;' +
                'box-shadow: 0 10px 30px rgba(0,0,0,0.4);' +
                'color: #cce7ff;' +
                'min-width: 180px;">' +
                  '<img src="' + avatar + '" alt="' + dataset.label + ' avatar" style="' +
                    'width:38px;height:38px;border-radius:6px;' +
                    'border:1px solid rgba(255,255,255,0.1);object-fit:cover;' +
                    'background:#0b141d;" />' +
                  '<div style="display:flex;flex-direction:column;line-height:1.2;">' +
                    '<div style="font-size:11px;font-weight:600;color:#cce7ff;opacity:0.85;">' +
                      dataset.label +
                    '</div>' +
                    '<div style="font-size:12px;font-weight:600;color:#cce7ff;">' +
                      dp.label + ':' +
                    '</div>' +
                    '<div style="font-size:18px;font-weight:800;color:' + color + ';">' +
                      formatNumber(value) +
                    '</div>' +
                  '</div>' +
                '</div>';
              const { offsetLeft: positionX, offsetTop: positionY } = chart.canvas;
              el.style.opacity = '1';
              el.style.left = positionX + tooltip.caretX + 10 + 'px';
              el.style.top = positionY + tooltip.caretY + 10 + 'px';
            },
          },
          zoom: {
            pan: { enabled: true, mode: 'xy' },
            zoom: {
              wheel: { enabled: true, modifierKey: 'ctrl' },
              pinch: { enabled: true },
              drag: { enabled: false },
              mode: 'xy',
            },
          },
        },
      },
      plugins: [barValuePlugin],
    });
  </script>
</body>
</html>`;
}

function hexToRgba(hex, alpha) {
  if (!hex) return `rgba(102,192,244,${alpha})`;
  const clean = hex.replace('#', '');
  const expanded = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const bigint = parseInt(expanded, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

async function main() {
  const browser = await chromium.launch({ headless: false }); // show browser for troubleshooting
  const page = await browser.newPage();

  console.log('Opening Moose stats…');
  await page.goto(MOOSE_URL, { waitUntil: 'networkidle' });

  console.log(`Selecting server: ${SELECTED_SERVER}`);
  const serverInfo = await selectServer(page, SELECTED_SERVER);
  await page.waitForTimeout(1500); // allow table to reload after server switch

  const profiles = await resolvePlayerProfiles(page);
  const profileMap = {};
  for (const p of profiles) {
    const nameKey = p.displayName || p.fallbackName;
    profileMap[nameKey] = p;
    console.log('Steam profile:', p.displayName || p.fallbackName, '->', p.steamUrl);
  }

  // Map table headers to columns dynamically.
  const columnMap = await mapTableColumns(page);
  console.log('Column map:', columnMap);
  console.log('Server selection info:', serverInfo);

  const playerStats = {};
  for (const profile of profiles) {
    const playerLabel = profile.displayName || profile.fallbackName;
    const searchKey = profile.searchKey || playerLabel;
    console.log('Fetching stats for:', playerLabel, `(search: ${searchKey})`);
    playerStats[playerLabel] = await getPlayerStats(page, profile, columnMap);
    console.log(playerLabel, playerStats[playerLabel]);
  }

  const html = buildChartHtml(playerStats, profileMap);
  const outPath = path.resolve('moose_stats_chart.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log('Chart written to:', outPath);

  // Also emit to Windows path if available (for easy viewing from host)
  const windowsOut = '/mnt/c/Users/Dubz/dev/ChatGPT/moose_stats_chart.html';
  try {
    if (fs.existsSync('/mnt/c/Users/Dubz/dev/ChatGPT')) {
      fs.writeFileSync(windowsOut, html, 'utf8');
      console.log('Chart mirrored to:', windowsOut);
    }
  } catch (_) {
    // ignore copy errors
  }

  const chartPage = await browser.newPage();
  await chartPage.goto('file://' + outPath);

  // Keep browser open for review
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
