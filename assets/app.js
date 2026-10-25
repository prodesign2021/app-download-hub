/**
 * 应用下载站 · 前端逻辑
 *
 * 数据流：
 *   data/apps.json  →  渲染卡片
 *   GitHub API      →  解析 latest release 里真实存在的安装包文件名
 *   解析失败 / 限流  →  按钮回退到 Releases 发布页（不让用户点到死链）
 */

const API = 'https://api.github.com';
const CACHE_PREFIX = 'apphub:rel:v1:';
const CACHE_TTL = 30 * 60 * 1000; // 30 分钟
const RESOLVE_CONCURRENCY = 4;

const PLATFORM_LABEL = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  android: 'Android',
};

const state = {
  owner: '',
  repo: '',
  apps: [],
  query: '',
  category: 'all',
  platform: 'all',
  resolved: new Map(), // repo -> release | {status:'rate-limited'|'error'}
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------------------------ 工具 */

const esc = (str) =>
  String(str ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));

function formatSize(bytes) {
  if (!bytes || bytes < 0) return '';
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const releasesPage = (repo) => `https://github.com/${repo}/releases`;
const latestReleasePage = (repo) => `${releasesPage(repo)}/latest`;

/* ------------------------------------------------------------------ 主题 */

function initTheme() {
  const saved = localStorage.getItem('apphub:theme');
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.dataset.theme = saved;
  }

  $('#theme-toggle')?.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme
      || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('apphub:theme', next);
    } catch { /* 隐私模式下忽略 */ }
  });
}

/* ------------------------------------------------- 发布信息解析 + 缓存 */

function readCache(repo) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + repo);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || Date.now() - entry.ts > CACHE_TTL) return null;
    return entry.value;
  } catch {
    return null;
  }
}

function writeCache(repo, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + repo, JSON.stringify({ ts: Date.now(), value }));
  } catch { /* 配额满了就跳过缓存 */ }
}

async function resolveRepo(repo) {
  const cached = readCache(repo);
  if (cached) return cached;

  try {
    const res = await fetch(`${API}/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });

    if (!res.ok) {
      const limited = res.status === 403 || res.status === 429;
      return { status: limited ? 'rate-limited' : 'error' };
    }

    const data = await res.json();
    const value = {
      status: 'ok',
      tag: data.tag_name || '',
      url: data.html_url || releasesPage(repo),
      publishedAt: data.published_at || '',
      assets: (data.assets || []).map((asset) => ({
        name: asset.name,
        size: asset.size,
        url: asset.browser_download_url,
      })),
    };
    writeCache(repo, value);
    return value;
  } catch {
    return { status: 'error' };
  }
}

/** 按正则从 release 资产里挑出目标安装包 */
function pickAsset(release, download) {
  if (!release || release.status !== 'ok' || !download.match) return null;
  let pattern;
  try {
    pattern = new RegExp(download.match);
  } catch {
    return null;
  }
  const hit = release.assets.find((asset) => pattern.test(asset.name));
  return hit || null;
}

/** 有限并发地解析所有仓库，避免打爆 API 限流 */
async function resolveAll(repos) {
  const queue = [...new Set(repos)];
  const workers = Array.from({ length: Math.min(RESOLVE_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const repo = queue.shift();
      const value = await resolveRepo(repo);
      state.resolved.set(repo, value);
      updateCardDownloads(repo, value);
    }
  });
  await Promise.all(workers);
  updateStats();
  if ([...state.resolved.values()].some((rel) => rel.status === 'rate-limited')) {
    showNotice('GitHub API 触发匿名限流（每小时 60 次），部分下载已回退到发布页。稍后刷新页面即可自动重试。');
  }
}

/* ----------------------------------------------------------------- 渲染 */

function visibleApps() {
  const query = state.query.trim().toLowerCase();
  return state.apps.filter((app) => {
    if (state.category !== 'all' && app.category !== state.category) return false;
    if (state.platform !== 'all'
      && !(app.downloads || []).some((d) => d.platform === state.platform)) return false;
    if (!query) return true;
    return `${app.name} ${app.tagline} ${app.description} ${(app.keywords || []).join(' ')}`
      .toLowerCase()
      .includes(query);
  });
}

function renderCategoryChips() {
  const holder = $('#category-filter');
  if (!holder) return;
  const categories = [...new Set(state.apps.map((app) => app.category).filter(Boolean))];
  holder.innerHTML = ['<button type="button" class="chip" data-category="all">全部</button>']
    .concat(categories.map((category) =>
      `<button type="button" class="chip" data-category="${esc(category)}">${esc(category)}</button>`))
    .join('');
  syncChipState();
}

function syncChipState() {
  $$('#category-filter .chip').forEach((chip) => {
    chip.classList.toggle('is-active', chip.dataset.category === state.category);
  });
  $$('#platform-filter .chip').forEach((chip) => {
    chip.classList.toggle('is-active', chip.dataset.platform === state.platform);
  });
}

function downloadButtonHTML(app, download, index) {
  const release = state.resolved.get(app.repo);
  const asset = pickAsset(release, download);
  const platform = PLATFORM_LABEL[download.platform] || download.platform;

  if (asset) {
    return `
      <a class="dl" data-app="${esc(app.id)}" data-idx="${index}"
         href="${esc(asset.url)}" target="_blank" rel="noopener"
         title="${esc(asset.name)}">
        <span class="plat">${esc(platform)}</span>
        <span class="lbl">${esc(download.label)}</span>
        <span class="size">${esc(formatSize(asset.size))}</span>
      </a>`;
  }

  if (release && release.status !== 'pending') {
    return `
      <a class="dl" data-app="${esc(app.id)}" data-idx="${index}" data-fallback="1"
         href="${esc(latestReleasePage(app.repo))}" target="_blank" rel="noopener"
         title="未能自动识别安装包，前往发布页手动选择">
        <span class="plat">${esc(platform)}</span>
        <span class="lbl">${esc(download.label)}</span>
        <span class="size">发布页</span>
      </a>`;
  }

  return `
    <a class="dl is-loading" data-app="${esc(app.id)}" data-idx="${index}"
       href="${esc(latestReleasePage(app.repo))}" target="_blank" rel="noopener">
      <span class="plat">${esc(platform)}</span>
      <span class="lbl">${esc(download.label)}</span>
      <span class="spinner" aria-hidden="true"></span>
    </a>`;
}

function cardHTML(app) {
  const downloads = (app.downloads || []).map((d, i) => downloadButtonHTML(app, d, i)).join('');
  const release = state.resolved.get(app.repo);
  const version = release && release.status === 'ok'
    ? `<span class="card-meta-item">最新 <strong>${esc(release.tag)}</strong></span>`
    : '';

  return `
    <article class="card" data-app="${esc(app.id)}">
      <div class="card-head">
        <span class="icon-tile" style="--tile:${esc(app.accent || '#4f8cff')}" aria-hidden="true">${esc(app.icon || '📦')}</span>
        <div class="card-title">
          <h2>
            ${esc(app.name)}
            ${app.featured ? '<span class="badge">推荐</span>' : ''}
          </h2>
          <p class="tagline">${esc(app.tagline)}</p>
        </div>
      </div>

      <p class="card-desc">${esc(app.description)}</p>

      <div class="card-meta">
        <a href="${esc(`https://github.com/${app.repo}`)}" target="_blank" rel="noopener">${esc(app.repo)}</a>
        ${version}
        <span class="card-meta-item dot">${esc(app.category || '')}</span>
      </div>

      <div class="downloads">${downloads}</div>
    </article>`;
}

function renderGrid() {
  const grid = $('#grid');
  const empty = $('#empty');
  if (!grid || !empty) return;

  const apps = visibleApps();
  const featuredFirst = [...apps].sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)));
  grid.innerHTML = featuredFirst.map(cardHTML).join('');
  empty.hidden = apps.length > 0;
}

function updateCardDownloads(repo, release) {
  $$(`.dl[data-app]`).forEach((btn) => {
    const app = state.apps.find((item) => item.id === btn.dataset.app);
    if (!app || app.repo !== repo) return;
    const download = app.downloads[Number(btn.dataset.idx)];
    if (!download) return;
    const asset = pickAsset(release, download);
    const platform = PLATFORM_LABEL[download.platform] || download.platform;

    btn.classList.remove('is-loading');
    if (asset) {
      btn.href = asset.url;
      btn.title = asset.name;
      btn.innerHTML = `<span class="plat">${esc(platform)}</span>
        <span class="lbl">${esc(download.label)}</span>
        <span class="size">${esc(formatSize(asset.size))}</span>`;
    } else if (release && release.status !== 'pending') {
      btn.href = latestReleasePage(repo);
      btn.dataset.fallback = '1';
      btn.title = '未能自动识别安装包，前往发布页手动选择';
      btn.innerHTML = `<span class="plat">${esc(platform)}</span>
        <span class="lbl">${esc(download.label)}</span>
        <span class="size">发布页</span>`;
    }
  });

  updateCardVersion(repo, release);
}

function updateCardVersion(repo, release) {
  if (!release || release.status !== 'ok') return;
  state.apps
    .filter((app) => app.repo === repo)
    .forEach((app) => {
      const card = $(`.card[data-app="${app.id}"] .card-meta`);
      if (!card || card.querySelector('.js-version')) return;
      const span = document.createElement('span');
      span.className = 'card-meta-item js-version';
      span.innerHTML = `最新 <strong>${esc(release.tag)}</strong>`;
      card.appendChild(span);
    });
}

function updateStats() {
  const platforms = new Set(state.apps.flatMap((app) => (app.downloads || []).map((d) => d.platform)));
  const dates = state.apps
    .map((app) => state.resolved.get(app.repo))
    .filter((release) => release && release.status === 'ok' && release.publishedAt)
    .map((release) => release.publishedAt)
    .sort();

  $('#stat-apps')?.replaceChildren(String(state.apps.length));
  $('#stat-platforms')?.replaceChildren(String(platforms.size));
  $('#stat-updated')?.replaceChildren(dates.length ? formatDate(dates[dates.length - 1]) : '—');
}

function renderSkeletons(count = 6) {
  const grid = $('#grid');
  const tpl = $('#card-skeleton');
  if (!grid || !tpl) return;
  grid.innerHTML = Array.from({ length: count }, () => tpl.innerHTML).join('');
}

function showNotice(text) {
  const notice = $('#notice');
  if (!notice) return;
  notice.textContent = text;
  notice.hidden = false;
}

/* ------------------------------------------------------------------ 交互 */

function initFilters() {
  document.addEventListener('click', (event) => {
    const categoryChip = event.target.closest('#category-filter .chip');
    if (categoryChip) {
      state.category = categoryChip.dataset.category;
      syncChipState();
      renderGrid();
      return;
    }
    const platformChip = event.target.closest('#platform-filter .chip');
    if (platformChip) {
      state.platform = platformChip.dataset.platform;
      syncChipState();
      renderGrid();
    }
  });

  $('#reset-filter')?.addEventListener('click', () => {
    state.query = '';
    state.category = 'all';
    state.platform = 'all';
    const input = $('#search');
    if (input) input.value = '';
    syncChipState();
    renderGrid();
  });

  const input = $('#search');
  let timer = 0;
  input?.addEventListener('input', (event) => {
    const value = event.target.value;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      state.query = value;
      renderGrid();
    }, 120);
  });

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement
      && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (event.key === '/' && !typing) {
      event.preventDefault();
      input?.focus();
    }
    if (event.key === 'Escape' && typing) input?.blur();
  });
}

function applyRepoLabels() {
  const repoSlug = `${state.owner}/${state.repo}`;
  $$('[data-repo-link]').forEach((el) => { el.href = `https://github.com/${repoSlug}`; });
  $$('[data-repo-label]').forEach((el) => { el.textContent = repoSlug; });
}

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  initTheme();
  initFilters();
  renderSkeletons();

  let payload;
  try {
    const res = await fetch('data/apps.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`apps.json ${res.status}`);
    payload = await res.json();
  } catch (error) {
    $('#grid')?.replaceChildren();
    showNotice(`应用清单加载失败（${error.message}），请刷新页面重试。`);
    return;
  }

  state.owner = payload.owner || 'prodesign2021';
  state.repo = payload.repo || 'app-download-hub';
  state.apps = (payload.apps || []).map((app) => ({ ...app, downloads: app.downloads || [] }));

  applyRepoLabels();
  renderCategoryChips();
  renderGrid();
  updateStats();

  await resolveAll(state.apps.map((app) => app.repo));
  renderGrid(); // 用解析结果重绘，保证版本徽标与真实资产一致
}

boot();
