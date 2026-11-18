'use strict';

const el = (id) => document.getElementById(id);

let tabId = -1;
let items = [];
let job = null;
let mse = null;
let lastListSig = '';
let seenJob = '';
let pollTimer = 0;
let toastTimer = 0;
let query = '';
let preferPageDownload = false;

const probes = new Map(); // 播放列表地址 -> { variants, subtitles, audio }
const probing = new Set();
const probeFailedAt = new Map(); // 探测失败的时间戳，用于退避重试

const MIME_EXT = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-flv': 'flv',
  'video/mp2t': 'ts',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
  'audio/wav': 'wav',
  'audio/flac': 'flac'
};

init();

async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) {
    showNotice('无法获取当前标签页');
    return;
  }

  tabId = tab.id;
  el('host').textContent = hostOf(tab.url || '');

  try {
    const saved = await chrome.storage.local.get({ preferPageDownload: false });
    preferPageDownload = !!saved.preferPageDownload;
    el('prefer-page').checked = preferPageDownload;
  } catch (e) {
    preferPageDownload = false;
  }

  if (/^(chrome|edge|about|devtools|chrome-extension|view-source):/i.test(tab.url || '')) {
    showNotice('浏览器内部页面不支持媒体检测，请在普通网页中使用。');
  }

  el('btn-scan').addEventListener('click', () => {
    scanPage();
  });
  el('btn-clear').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'clearTab', tabId: tabId }, () => void chrome.runtime.lastError);
    items = [];
    mse = null;
    lastListSig = '';
    renderList();
    renderMse();
    toast('已清空列表');
  });
  el('list').addEventListener('click', onListClick);
  el('search').addEventListener('input', (e) => {
    query = String(e.target.value || '').trim().toLowerCase();
    lastListSig = '';
    renderList();
  });
  el('prefer-page').addEventListener('change', (e) => {
    preferPageDownload = !!e.target.checked;
    chrome.storage.local.set({ preferPageDownload: preferPageDownload });
  });
  el('btn-cancel').addEventListener('click', cancelJob);
  el('mse-start').addEventListener('click', () => mseCommand('start', '已开启捕获，请刷新页面并播放视频'));
  el('mse-save').addEventListener('click', () => mseCommand('save', '正在生成文件…'));
  el('mse-reset').addEventListener('click', () => mseCommand('reset', '已清空捕获数据'));

  await refresh();
  pollTimer = setInterval(refresh, 900);
  window.addEventListener('pagehide', () => clearInterval(pollTimer));
}

/* ---------------- 数据刷新 ---------------- */

async function refresh() {
  if (tabId < 0) return;
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: 'getMedia', tabId: tabId });
  } catch (e) {
    return;
  }
  if (!res || res.error) return;

  items = (res.items || []).slice();
  mse = res.mse || null;

  for (const [key, payload] of Object.entries(res.variants || {})) {
    if (payload) probes.set(key, payload);
  }

  renderList();
  renderMse();
  handleJob(res.job);
  probeMissing();
}

/* 对已检测到的 HLS 条目补全清晰度清单（每个条目只探测一次）。 */
function probeMissing() {
  const now = Date.now();
  for (const item of items) {
    if (item.kind !== 'hls' || probing.has(item.url) || probes.has(item.url)) continue;
    const failedAt = probeFailedAt.get(item.url) || 0;
    if (now - failedAt < 60000) continue; // 失败后 60 秒内不再重试，避免反复请求
    probing.add(item.url);
    chrome.tabs.sendMessage(
      tabId,
      { type: 'vdh:probe', url: item.url, key: item.key },
      { frameId: typeof item.frameId === 'number' ? item.frameId : 0 }
    ).then((res) => {
      probing.delete(item.url);
      if (res && res.ok && res.result) {
        probeFailedAt.delete(item.url);
        probes.set(item.url, res.result);
        lastListSig = '';
        renderList();
      } else {
        probeFailedAt.set(item.url, Date.now());
      }
    }).catch(() => {
      probing.delete(item.url);
      probeFailedAt.set(item.url, Date.now());
    });
  }
}

async function scanPage() {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'vdh:scan' });
  } catch (e) {
    toast('当前页面无法扫描（内容脚本未注入）', true);
  }
  setTimeout(refresh, 150);
}

/* ---------------- 列表渲染 ---------------- */

function renderList() {
  const all = items.filter((item) => item.kind !== 'blob');
  const hasBlob = items.some((item) => item.kind === 'blob');
  const visible = query
    ? all.filter((item) => (displayName(item) + ' ' + item.url).toLowerCase().indexOf(query) >= 0)
    : all;

  const sig = visible
    .map((item) => {
      const probe = probes.get(item.url);
      const extra = probe
        ? (probe.variants ? probe.variants.length : 0) + ':' + (probe.subtitles ? probe.subtitles.length : 0)
        : '-';
      return [item.key, item.kind, item.size, item.title, item.height, item.duration,
        extra, item.drm ? 'drm' : '', item.drmReason || ''].join('~');
    })
    .join('|') + '#' + (hasBlob ? '1' : '0') + '@' + query;

  if (sig === lastListSig) return;
  lastListSig = sig;

  const list = el('list');
  list.innerHTML = '';

  if (!visible.length && !hasBlob) {
    list.appendChild(query ? searchEmpty() : emptyState());
    return;
  }
  if (!visible.length && hasBlob) {
    // 只剩 blob 条目时，列表为空但 MSE 卡片仍可用
    list.appendChild(searchEmpty(true));
    return;
  }

  visible.sort((a, b) => {
    const ka = kindWeight(a.kind);
    const kb = kindWeight(b.kind);
    if (ka !== kb) return ka - kb;
    if ((b.size || 0) !== (a.size || 0)) return (b.size || 0) - (a.size || 0);
    return (a.title || a.url).localeCompare(b.title || b.url);
  });

  const frag = document.createDocumentFragment();
  for (const item of visible) frag.appendChild(itemRow(item));
  list.appendChild(frag);
}

function searchEmpty(quiet) {
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  wrap.innerHTML = '<div class="title">没有匹配的媒体</div>' +
    (quiet ? '' : '<div class="desc">换个关键词试试，或清空搜索框。</div>');
  return wrap;
}

function kindWeight(kind) {
  if (kind === 'hls') return 0;
  if (kind === 'dash') return 1;
  if (kind === 'sub') return 3;
  return 2;
}

function emptyState() {
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  wrap.innerHTML =
    '<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/>' +
    '<path d="M10 9.5l5 2.5-5 2.5z"/></svg>' +
    '<div class="title">未检测到媒体</div>' +
    '<div class="desc">播放页面中的视频后点击右上角刷新；<br>若为 blob 播放器，可用下方 MSE 捕获。</div>';
  return wrap;
}

function itemRow(item) {
  const row = document.createElement('div');
  row.className = 'item';
  row.dataset.key = item.key;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (item.poster) {
    thumb.style.backgroundImage = 'url("' + String(item.poster).replace(/(["\\])/g, '\\$1') + '")';
  } else {
    thumb.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5.5l11 6.5-11 6.5z"/></svg>';
  }
  if (item.duration) {
    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = fmtTime(item.duration);
    thumb.appendChild(dur);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = displayName(item);
  name.title = item.url;

  const sub = document.createElement('div');
  sub.className = 'sub';

  const badge = document.createElement('span');
  badge.className = 'badge ' + (item.kind === 'file' ? 'file' : item.kind);
  if (item.drm) badge.classList.add('drm');
  badge.textContent = item.drm ? 'DRM' : badgeText(item);
  sub.appendChild(badge);

  const info = [];
  if (item.height) info.push(item.height + 'p');
  if (item.size) info.push(fmtSize(item.size));
  if (item.duration) info.push(fmtTime(item.duration));
  if (!item.size && item.mime) info.push(item.mime.replace(/^(video|audio)\//, ''));
  if (info.length) {
    const text = document.createElement('span');
    text.textContent = info.join(' · ');
    sub.appendChild(text);
  }

  // 受保护流：显式说明原因，并把下载按钮置灰（点了也只会失败）
  if (item.drm) {
    const warn = document.createElement('div');
    warn.className = 'drm-note';
    warn.textContent = item.drmReason || '该流受 DRM 保护，无法下载';
    sub.appendChild(warn);
  }

  meta.appendChild(name);
  meta.appendChild(sub);

  const extras = buildExtras(item);
  if (extras) meta.appendChild(extras);

  const btns = document.createElement('div');
  btns.className = 'btns';
  const dl = iconButton('download', '下载到本地', ICON.download);
  if (item.drm) {
    dl.disabled = true;
    dl.title = 'DRM 保护，无法下载';
  }
  btns.appendChild(dl);
  btns.appendChild(iconButton('copy', '复制链接', ICON.copy));

  row.appendChild(thumb);
  row.appendChild(meta);
  row.appendChild(btns);
  return row;
}

/* 清晰度下拉框 + 字幕按钮：仅在探测到主播放列表信息后出现。 */
function buildExtras(item) {
  const probe = probes.get(item.url);
  if (!probe) return null;

  const hasVariants = probe.variants && probe.variants.length > 1;
  const subs = probe.subtitles || [];
  if (!hasVariants && !subs.length && !(probe.audio && probe.audio.length > 1)) return null;

  const box = document.createElement('div');
  box.className = 'extras';

  if (hasVariants) {
    const select = document.createElement('select');
    select.className = 'quality';
    select.dataset.key = item.key;
    select.title = '选择下载清晰度';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '最高画质（自动）';
    select.appendChild(auto);
    for (const v of probe.variants) {
      const opt = document.createElement('option');
      opt.value = v.url;
      opt.textContent = v.label + (v.bandwidth ? ' · ' + Math.round(v.bandwidth / 1000) + 'kbps' : '');
      select.appendChild(opt);
    }
    box.appendChild(select);
  }

  for (const sub of subs) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.dataset.sub = sub.url;
    btn.dataset.name = (displayName(item) + (sub.lang ? ' ' + sub.lang : '')) || 'subtitle';
    btn.textContent = '字幕' + (sub.lang ? ' ' + sub.lang.toUpperCase() : '');
    btn.title = sub.url;
    box.appendChild(btn);
  }

  return box;
}

function iconButton(act, title, svg) {  const btn = document.createElement('button');
  btn.className = 'icon-btn';
  btn.dataset.act = act;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = svg;
  return btn;
}

const ICON = {
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v10"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H6a2 2 0 0 0-2 2v7.5A1.5 1.5 0 0 0 5.5 15"/></svg>'
};

function displayName(item) {
  if (item.kind === 'file') {
    const fromUrl = fileFromUrl(item.url);
    if (fromUrl) return fromUrl;
  }
  if (item.title) return item.title;
  return fileFromUrl(item.url) || item.url.slice(0, 70);
}

function badgeText(item) {
  if (item.kind === 'hls') return 'HLS';
  if (item.kind === 'dash') return 'DASH';
  if (item.kind === 'sub') return 'SUB';
  const ext = extOf(item.url);
  return ext ? ext.toUpperCase() : 'MEDIA';
}

/* ---------------- 交互 ---------------- */

function onListClick(event) {
  const subBtn = event.target.closest('button[data-sub]');
  if (subBtn) {
    downloadSubtitle(subBtn.dataset.sub, subBtn.dataset.name);
    return;
  }

  const btn = event.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('.item');
  if (!row) return;
  const item = items.find((entry) => entry.key === row.dataset.key);
  if (!item) return;

  if (btn.dataset.act === 'download') downloadItem(item, row);
  else if (btn.dataset.act === 'copy') copyUrl(item.url);
}

async function downloadSubtitle(url, filename) {
  try {
    const res = await chrome.tabs.sendMessage(
      tabId,
      { type: 'vdh:sub', url: url, filename: filename },
      { frameId: mseFrameId() }
    );
    if (!res || !res.ok) {
      toast((res && res.error) || '字幕下载失败', true);
      return;
    }
    toast('字幕已保存：' + (res.filename || ''));
  } catch (e) {
    toast('字幕下载失败（页面不允许跨域读取）', true);
  }
}

/* 读取该条目在列表中选中的清晰度（未选择时为空，表示自动取最高）。 */
function selectedVariant(item, row) {
  if (!row) return '';
  const select = row.querySelector('select.quality');
  if (!select) return '';
  return select.value || '';
}

async function downloadItem(item, row) {
  const frameId = typeof item.frameId === 'number' ? item.frameId : 0;

  if (item.kind === 'hls' || item.kind === 'dash') {
    const entry = Object.assign({}, item);
    const variantUrl = selectedVariant(item, row);
    if (variantUrl) entry.variantUrl = variantUrl;
    if (item.kind === 'hls') {
      const probe = probes.get(item.url);
      const audio = probe && probe.audio && probe.audio.filter((a) => a.isDefault)[0];
      if (audio && audio.url) entry.audioUrl = audio.url;
    }

    try {
      const res = await chrome.tabs.sendMessage(
        tabId,
        { type: 'vdh:download', entry: entry },
        { frameId: frameId }
      );
      if (!res || !res.ok) {
        toast((res && res.error) || '无法开始下载', true);
        return;
      }
      toast((item.kind === 'hls' ? 'HLS' : 'DASH') + ' 合并下载中，请保持页面打开');
      setTimeout(refresh, 400);
    } catch (e) {
      toast('当前页面无法执行下载（内容脚本未注入）', true);
    }
    return;
  }

  // 防盗链站点常在直链上校验 Referer / Cookie，页内下载可原样带上。
  if (preferPageDownload) {
    try {
      await chrome.tabs.sendMessage(
        tabId,
        { type: 'vdh:fetch-save', url: item.url, filename: nameForFile(item) },
        { frameId: frameId }
      );
      toast('已在页面内下载（保留 Cookie / Referer）');
    } catch (e) {
      toast('页面内下载失败', true);
    }
    return;
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'downloadUrl',
      url: item.url,
      filename: nameForFile(item),
      tabId: tabId,
      frameId: frameId
    });
    if (!res || !res.ok) {
      toast((res && res.error) || '下载失败', true);
      return;
    }
    toast('已加入下载队列');
  } catch (e) {
    toast('下载失败', true);
  }
}

async function copyUrl(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast('链接已复制');
  } catch (e) {
    toast('复制失败', true);
  }
}

async function cancelJob() {
  if (!job) return;
  const frameId = typeof job.frameId === 'number' ? job.frameId : 0;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'vdh:cancel' }, { frameId: frameId });
    toast('正在取消…');
  } catch (e) {
    toast('取消失败', true);
  }
}

/* ---------------- 任务进度 ---------------- */

function handleJob(next) {
  if (!next) {
    job = null;
    renderJob(null);
    return;
  }

  if (next.state === 'running') {
    job = next;
    renderJob(next);
    return;
  }

  const key = next.id + ':' + next.state;
  if (seenJob !== key) {
    seenJob = key;
    if (next.state === 'done') {
      toast(next.phase && next.phase !== '已完成' ? next.phase : '下载完成，已保存到下载目录');
    } else if (next.state === 'cancelled') {
      toast('已取消下载');
    } else {
      toast('下载失败：' + (next.error || next.phase || '未知错误'), true);
    }
  }

  job = null;
  renderJob(null);
  chrome.runtime.sendMessage({ type: 'clearJob', tabId: tabId }, () => void chrome.runtime.lastError);
}

function renderJob(current) {
  const card = el('job-card');
  if (!current) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  el('job-title').textContent = current.title || '下载中';

  const pct = current.total
    ? Math.min(99, Math.round((current.done / current.total) * 100))
    : 6;
  el('job-bar').style.width = pct + '%';
  el('job-phase').textContent = current.phase || '下载中';
  el('job-stat').textContent = current.bytes ? fmtSize(current.bytes) : '';
  el('btn-cancel').disabled = current.state !== 'running';
}

/* ---------------- MSE 捕获 ---------------- */

function renderMse() {
  const hasBlob = items.some((item) => item.kind === 'blob');
  const bytes = (mse && mse.bytes) || 0;
  const active = !!(mse && mse.active);
  const tracks = (mse && mse.tracks) || [];
  const show = hasBlob || bytes > 0 || active;

  el('mse-card').hidden = !show;
  if (!show) return;

  const meta = [];
  meta.push(bytes ? '已捕获 ' + fmtSize(bytes) : (active ? '等待数据…' : '尚未捕获'));
  if (tracks.length) meta.push(tracks.length + ' 轨');
  if (mse && mse.truncated) meta.push('已达容量上限');
  el('mse-meta').textContent = meta.join(' · ');

  el('mse-start').textContent = active ? '捕获中' : '开始捕获';
  el('mse-start').disabled = active;
  el('mse-save').disabled = bytes === 0;
  el('mse-reset').disabled = !bytes && !active;

  const hasStream = items.some((item) => item.kind === 'hls' || item.kind === 'dash');
  const hint = el('mse-hint');
  hint.textContent = hasStream
    ? '本页检测到 HLS/DASH 条目，优先下载对应条目可获得完整视频；MSE 捕获只能保存播放器已加载的数据。'
    : '先点「开始捕获」，再刷新页面并播放视频；播放完成后点「保存」。仅能保存播放器已加载的数据，未播放部分无法获取。';
}

function mseFrameId() {
  const blob = items.find((item) => item.kind === 'blob');
  return blob && typeof blob.frameId === 'number' ? blob.frameId : 0;
}

async function mseCommand(action, tip) {
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { type: 'vdh:mse', action: action },
      { frameId: mseFrameId() }
    );
    if (tip) toast(tip);
    setTimeout(refresh, 400);
  } catch (e) {
    toast('操作失败，当前页面可能不支持捕获', true);
  }
}

/* ---------------- 工具函数 ---------------- */

function hostOf(url) {
  try {
    return new URL(url).hostname || url;
  } catch (e) {
    return url || '—';
  }
}

function fileFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    return name;
  } catch (e) {
    return '';
  }
}

function extOf(url) {
  const m = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(url || '');
  return m ? m[1].toLowerCase() : '';
}

function nameForFile(item) {
  let name = fileFromUrl(item.url);
  if (!name) name = item.title || 'video';
  name = String(name).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim();

  const mimeExt = MIME_EXT[(item.mime || '').toLowerCase()] || '';
  const ext = extOf(item.url) || mimeExt;
  if (ext && !new RegExp('\\.' + ext + '$', 'i').test(name)) name += '.' + ext;
  return name || 'video';
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return (value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[index];
}

function fmtTime(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return m + ':' + String(s).padStart(2, '0');
}

function showNotice(text) {
  const notice = el('notice');
  notice.textContent = text;
  notice.hidden = false;
}

function toast(text, isError) {
  const box = el('toast');
  box.textContent = text;
  box.classList.toggle('error', !!isError);
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, 2600);
}

/* 供自动化自测使用：把弹窗指向指定标签页，并读取当前渲染结果。 */
globalThis.__VDH_POPUP__ = {
  focus: (id) => {
    tabId = id;
    lastListSig = '';
    return refresh();
  },
  state: () => ({
    tabId: tabId,
    items: items.length,
    probes: [...probes.keys()],
    rows: document.querySelectorAll('#list .item').length,
    qualities: [...document.querySelectorAll('select.quality')]
      .map((s) => [...s.options].map((o) => o.textContent))
  })
};
