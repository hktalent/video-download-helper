'use strict';

/*
 * 后台 Service Worker（Chrome）/ 事件页（Firefox）：
 * 1. 通过 webRequest 监听页面发起的媒体请求（直链 / m3u8 / mpd）；
 * 2. 汇总内容脚本上报的 <video>/<audio>、HLS 清晰度清单与 MSE 捕获状态；
 * 3. 提供弹窗所需的数据，并负责直链文件的下载（失败时回退到页内下载）。
 */

const MEDIA_EXT = new Set([
  'mp4', 'm4v', 'm4a', 'webm', 'mkv', 'mov', 'flv', 'f4v', 'avi',
  'ts', 'm2ts', 'm3u8', 'mpd', 'mp3', 'aac', 'ogg', 'oga', 'opus',
  'wav', 'flac', 'weba', '3gp', 'ogv', 'vtt', 'srt'
]);

// 这些扩展名通常是流媒体分片，不单独展示（其播放列表会被检测到）
const SKIP_EXT = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'cmft', 'key']);

const HLS_MIME_RE = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl)|audio\/(mpegurl|x-mpegurl|vnd\.apple\.mpegurl))/i;
const DASH_MIME_RE = /^application\/dash\+xml/i;
const MEDIA_MIME_RE = /^(video|audio)\//i;
const SUB_MIME_RE = /^(text\/(vtt|x-ssa-ass|x-ass)|application\/(x-subrip|ttml\+xml)|text\/plain)/i;

const MAX_ITEMS_PER_TAB = 300;
const tabStore = new Map(); // tabId -> { items: Map, job, mseFrames: Map, variants: Map, pageUrl }
const persistTimers = new Map();
const pendingDownloads = new Map(); // downloadId -> { tabId, frameId, url, filename, retried }

let restorePromise = null;

/* ---------------- 基础工具 ---------------- */

function extOf(url) {
  try {
    const path = new URL(url).pathname;
    const m = /\.([a-z0-9]{2,5})$/i.exec(path);
    return m ? m[1].toLowerCase() : '';
  } catch (e) {
    return '';
  }
}

function normalizeKey(url) {
  const i = url.indexOf('#');
  return i >= 0 ? url.slice(0, i) : url;
}

function safeFilename(name) {
  const s = String(name || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return (s || 'video').slice(0, 150);
}

function headersToMap(headers) {
  const map = {};
  for (const h of headers || []) {
    if (!h || !h.name) continue;
    map[h.name.toLowerCase()] = h.value || '';
  }
  return map;
}

function tabState(tabId) {
  let st = tabStore.get(tabId);
  if (!st) {
    st = { items: new Map(), job: null, mseFrames: new Map(), variants: new Map(), pageUrl: '' };
    tabStore.set(tabId, st);
  }
  return st;
}

/* ---------------- MSE 多帧汇总 ---------------- */

/*
 * 页面里的播放器可能位于 iframe 中，每个帧各有一条捕获状态。
 * 这里按 frameId 分别保存，再汇总成一份给弹窗使用，避免子帧数据覆盖父帧。
 */
function mergeMseState(st, frameId, state) {
  if (!st.mseFrames) st.mseFrames = new Map();
  if (!state) {
    st.mseFrames.delete(frameId);
    return;
  }
  st.mseFrames.set(frameId, {
    active: !!state.active,
    bytes: state.bytes || 0,
    truncated: !!state.truncated,
    tracks: Array.isArray(state.tracks) ? state.tracks : []
  });
}

function aggregateMse(st) {
  const frames = st.mseFrames instanceof Map ? st.mseFrames : new Map();
  if (!frames.size) return null;

  let bytes = 0;
  let active = false;
  let truncated = false;
  let hasData = false;
  const tracks = new Map();

  for (const state of frames.values()) {
    bytes += state.bytes || 0;
    if (state.active) active = true;
    if (state.truncated) truncated = true;
    for (const track of state.tracks || []) {
      if (!track) continue;
      hasData = true;
      const mime = track.mime || 'application/octet-stream';
      const prev = tracks.get(mime) || { mime: mime, bytes: 0, segments: 0 };
      prev.bytes += track.bytes || 0;
      prev.segments += track.segments || 0;
      tracks.set(mime, prev);
    }
  }

  if (!hasData && !bytes && !active) return null;

  return {
    active: active,
    bytes: bytes,
    truncated: truncated,
    frames: frames.size,
    tracks: [...tracks.values()]
  };
}

/* ---------------- 徽标 ---------------- */

function updateBadge(tabId) {
  const st = tabStore.get(tabId);
  const running = !!(st && st.job && st.job.state === 'running');

  let count = 0;
  if (st) {
    for (const item of st.items.values()) {
      if (item.kind !== 'blob') count++;
    }
  }

  try {
    if (running) {
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#34c98b' });
      chrome.action.setBadgeText({ tabId, text: '↓' });
      return;
    }
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f6cff' });
    chrome.action.setBadgeText({ tabId, text: count ? String(Math.min(count, 99)) : '' });
  } catch (e) {
    /* 标签页可能已关闭 */
  }
}

/* ---------------- 会话存储（避免 SW 休眠后列表丢失） ---------------- */

async function restoreFromSession() {
  let all;
  try {
    all = await chrome.storage.session.get(null);
  } catch (e) {
    return;
  }
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('tab_') || !value || !Array.isArray(value.items)) continue;
    const tabId = parseInt(key.slice(4), 10);
    if (!Number.isFinite(tabId)) continue;
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      tab = null;
    }
    if (!tab) {
      chrome.storage.session.remove(key).catch(() => {});
      continue;
    }
    if (tabStore.has(tabId)) continue;
    const st = tabState(tabId);
    st.pageUrl = value.pageUrl || tab.url || '';
    for (const item of value.items) {
      if (item && item.key) st.items.set(item.key, item);
    }
    updateBadge(tabId);
  }
}

function ensureRestored() {
  if (!restorePromise) restorePromise = restoreFromSession();
  return restorePromise;
}

function persistTab(tabId) {
  clearTimeout(persistTimers.get(tabId));
  persistTimers.set(tabId, setTimeout(() => {
    persistTimers.delete(tabId);
    const st = tabStore.get(tabId);
    if (!st) return;
    const payload = {
      pageUrl: st.pageUrl,
      items: [...st.items.values()]
    };
    chrome.storage.session.set({ ['tab_' + tabId]: payload }).catch(() => {});
  }, 500));
}

/* ---------------- 媒体识别与入库 ---------------- */

function classify(details) {
  const url = details.url || '';
  if (!/^(https?|wss?):/i.test(url)) return null;

  const headers = headersToMap(details.responseHeaders);
  const mime = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = extOf(url);

  const isHls = HLS_MIME_RE.test(mime) || ext === 'm3u8';
  const isDash = DASH_MIME_RE.test(mime) || ext === 'mpd';
  const isMediaMime = MEDIA_MIME_RE.test(mime);
  const isMediaExt = MEDIA_EXT.has(ext);

  if (!isHls && !isDash && !isMediaMime && !isMediaExt) return null;

  // 字幕文件单独归类，方便在弹窗中作为独立条目下载
  const isSub = !isHls && !isDash && SUB_MIME_RE.test(mime) && /^(vtt|srt|ass|ssa)$/i.test(ext);

  // m3u8 / mpd 之外的流分片不单独入库
  if (!isHls && !isDash && !isSub) {
    if (SKIP_EXT.has(ext) || mime === 'video/mp2t') return null;
    if (details.type === 'xmlhttprequest' && !isMediaMime && !isMediaExt) return null;
  }

  // 206 的 content-length 只是本次返回的分片长度，总大小必须从 Content-Range 的 "0-1/1234567" 取
  const rangeTotal = contentRangeTotal(headers['content-range']);
  let size = rangeTotal || (parseInt(headers['content-length'] || '0', 10) || 0);
  const ranges = String(headers['accept-ranges'] || '').toLowerCase().indexOf('bytes') >= 0 ||
    !!headers['content-range'];

  const kind = isHls ? 'hls' : isDash ? 'dash' : isSub ? 'sub' : 'file';
  return { url: url, kind: kind, mime: mime, size: size, ranges: ranges };
}

/* Content-Range: bytes 0-1/1234567 → 1234567（拿不到时返 0） */
function contentRangeTotal(value) {
  if (!value) return 0;
  const m = /\/(\d+)\s*$/.exec(String(value));
  return m ? parseInt(m[1], 10) || 0 : 0;
}

function addNetworkItem(details) {
  const info = classify(details);
  if (!info) return;

  const tabId = details.tabId;
  const st = tabState(tabId);
  const key = normalizeKey(info.url);
  const prev = st.items.get(key);

  if (details.type === 'main_frame' && details.url) {
    st.pageUrl = details.url;
  }

  if (prev) {
    prev.mime = info.mime || prev.mime;
    prev.size = Math.max(prev.size || 0, info.size || 0);
    prev.kind = prev.kind === 'file' && info.kind !== 'file' ? info.kind : prev.kind;
    if (info.ranges) prev.ranges = true;
    prev.ts = Date.now();
  } else {
    st.items.set(key, {
      key: key,
      tabId: tabId,
      frameId: details.frameId,
      url: info.url,
      kind: info.kind,
      mime: info.mime,
      size: info.size,
      ranges: !!info.ranges,
      title: '',
      poster: '',
      duration: 0,
      width: 0,
      height: 0,
      source: 'network',
      ts: Date.now()
    });
    trimItems(st);
  }

  persistTab(tabId);
  updateBadge(tabId);
}

function trimItems(st) {
  if (st.items.size <= MAX_ITEMS_PER_TAB) return;
  const list = [...st.items.values()].sort((a, b) => a.ts - b.ts);
  const removeCount = st.items.size - MAX_ITEMS_PER_TAB;
  for (let i = 0; i < removeCount; i++) {
    if (list[i]) {
      st.items.delete(list[i].key);
      if (st.variants) st.variants.delete(list[i].key);
    }
  }
}

function inferKind(url) {
  if (/\.m3u8(?:$|\?)/i.test(url) || /[?&]format=m3u8/i.test(url)) return 'hls';
  if (/\.mpd(?:$|\?)/i.test(url)) return 'dash';
  return 'file';
}

function mergeDomItem(tabId, frameId, item) {
  if (!item || !item.url) return;
  const st = tabState(tabId);

  if (item.kind === 'blob') {
    const key = 'blob:' + (item.id || item.url.slice(0, 64));
    const prev = st.items.get(key) || {};
    st.items.set(key, {
      ...prev,
      key: key,
      tabId: tabId,
      frameId: frameId,
      url: item.url,
      kind: 'blob',
      title: item.title || prev.title || '',
      poster: item.poster || prev.poster || '',
      duration: item.duration || prev.duration || 0,
      width: item.width || prev.width || 0,
      height: item.height || prev.height || 0,
      mime: prev.mime || '',
      size: prev.size || 0,
      source: 'dom',
      ts: Date.now()
    });
  } else {
    const key = normalizeKey(item.url);
    const prev = st.items.get(key);
    if (prev) {
      prev.title = item.title || prev.title;
      prev.poster = item.poster || prev.poster;
      prev.duration = item.duration || prev.duration;
      prev.width = item.width || prev.width;
      prev.height = item.height || prev.height;
      prev.ts = Date.now();
    } else {
      st.items.set(key, {
        key: key,
        tabId: tabId,
        frameId: frameId,
        url: item.url,
        kind: inferKind(item.url),
        mime: '',
        size: 0,
        title: item.title || '',
        poster: item.poster || '',
        duration: item.duration || 0,
        width: item.width || 0,
        height: item.height || 0,
        source: 'dom',
        ts: Date.now()
      });
      trimItems(st);
    }
  }

  persistTab(tabId);
  updateBadge(tabId);
}

function clearTab(tabId, keepPageUrl) {
  const st = tabStore.get(tabId);
  if (st) {
    st.items.clear();
    st.job = null;
    if (st.mseFrames) st.mseFrames.clear();
    if (st.variants) st.variants.clear();
    if (!keepPageUrl) st.pageUrl = '';
  }
  clearTimeout(persistTimers.get(tabId));
  persistTimers.delete(tabId);
  chrome.storage.session.remove('tab_' + tabId).catch(() => {});
  updateBadge(tabId);
}

/* ---------------- 清晰度 / 音轨清单缓存 ---------------- */

function setVariants(tabId, key, payload) {
  const st = tabState(tabId);
  if (!st.variants) st.variants = new Map();
  if (!payload) st.variants.delete(key);
  else st.variants.set(key, payload);
}

function getVariants(tabId) {
  const st = tabStore.get(tabId);
  if (!st || !st.variants) return {};
  const out = {};
  for (const [key, value] of st.variants.entries()) out[key] = value;
  return out;
}

/* ---------------- 下载 ---------------- */

/* downloads API 在 Firefox 上仍是回调式，这里统一包成 Promise */
function downloadsDownload(options) {
  return new Promise((resolve, reject) => {
    try {
      const ret = chrome.downloads.download(options, (id) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(id);
      });
      // Chrome 上若不传回调会返回 Promise；传了回调则返回 undefined
      if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

async function startDirectDownload(url, filename, tabId, frameId, retried) {
  const downloadId = await downloadsDownload({
    url: url,
    filename: safeFilename(filename),
    conflictAction: 'uniquify',
    saveAs: false
  });
  pendingDownloads.set(downloadId, { tabId, frameId, url, filename, retried: !!retried });
  if (pendingDownloads.size > 50) {
    const oldest = pendingDownloads.keys().next().value;
    pendingDownloads.delete(oldest);
  }
  return downloadId;
}


chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;
  const info = pendingDownloads.get(delta.downloadId);
  if (!info) return;

  if (delta.state.current === 'complete') {
    pendingDownloads.delete(delta.downloadId);
    return;
  }

  if (delta.state.current === 'interrupted') {
    pendingDownloads.delete(delta.downloadId);
    let errorName = '';
    try {
      const [item] = await chrome.downloads.search({ id: delta.downloadId });
      errorName = (item && item.error) || '';
    } catch (e) {
      /* ignore */
    }
    if (errorName === 'USER_CANCELED') return;
    // 直链下载被拒绝（常见于防盗链 / 需要 Referer / Cookie），回退到页面内 fetch 保存。
    // 每个下载只回退一次，避免页面内也失败时反复重试。
    if (info.tabId >= 0 && !info.retried) {
      chrome.tabs.sendMessage(
        info.tabId,
        { type: 'vdh:fetch-save', url: info.url, filename: info.filename },
        { frameId: info.frameId || 0 }
      ).catch(() => {});
    }
  }
});

/* ---------------- 消息处理 ---------------- */

async function handleMessage(msg, sender) {
  await ensureRestored();

  const senderTabId = sender && sender.tab ? sender.tab.id : -1;

  switch (msg && msg.type) {
    case 'getMedia': {
      const tabId = typeof msg.tabId === 'number' ? msg.tabId : senderTabId;
      let st = tabStore.get(tabId);
      if (!st) {
        let pageUrl = '';
        try {
          const tab = await chrome.tabs.get(tabId);
          pageUrl = tab ? tab.url || '' : '';
        } catch (e) {
          pageUrl = '';
        }
        return { items: [], job: null, mse: null, pageUrl: pageUrl, variants: {} };
      }
      return {
        items: [...st.items.values()],
        job: st.job,
        mse: aggregateMse(st),
        pageUrl: st.pageUrl,
        variants: getVariants(tabId)
      };
    }

    case 'domMedia': {
      if (senderTabId < 0) return { ok: false };
      const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
      for (const item of msg.items || []) {
        mergeDomItem(senderTabId, frameId, item);
      }
      return { ok: true };
    }

    case 'mseState': {
      if (senderTabId < 0) return { ok: false };
      const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
      mergeMseState(tabState(senderTabId), frameId, msg.state || null);
      return { ok: true };
    }

    case 'vdh:progress': {
      if (senderTabId < 0) return { ok: false };
      const st = tabState(senderTabId);
      st.job = msg.job ? { ...msg.job, tabId: senderTabId, frameId: sender.frameId || 0 } : null;
      updateBadge(senderTabId);
      return { ok: true };
    }

    case 'vdh:variants': {
      if (senderTabId < 0) return { ok: false };
      setVariants(senderTabId, msg.key || '', msg.payload || null);
      return { ok: true };
    }

    case 'clearJob': {
      const tabId = typeof msg.tabId === 'number' ? msg.tabId : senderTabId;
      const st = tabStore.get(tabId);
      if (st) st.job = null;
      updateBadge(tabId);
      return { ok: true };
    }

    case 'clearTab': {
      clearTab(typeof msg.tabId === 'number' ? msg.tabId : senderTabId, true);
      return { ok: true };
    }

    /* 内容脚本探测到 DRM / 受保护流时回写标记，弹窗据此禁止下载并说明原因 */
    case 'vdh:flag': {
      if (senderTabId < 0) return { ok: false };
      const st = tabState(senderTabId);
      const key = normalizeKey(msg.key || '');
      const item = key ? st.items.get(key) : null;
      if (item) {
        item.drm = !!msg.drm;
        item.drmReason = msg.reason || '';
        // 顺带记录内容脚本实测到的体积（直链 206 或下载后实测）
        if (msg.size) item.size = msg.size;
        if (msg.ranges) item.ranges = true;
        persistTab(senderTabId);
      }
      return { ok: true };
    }

    case 'downloadUrl': {
      const id = await startDirectDownload(
        msg.url,
        msg.filename,
        typeof msg.tabId === 'number' ? msg.tabId : senderTabId,
        typeof msg.frameId === 'number' ? msg.frameId : 0,
        false
      );
      return { ok: true, downloadId: id };
    }

    default:
      return { ok: false, error: 'unknown message' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

/* ---------------- webRequest 监听 ---------------- */

function onMediaRequest(details) {
  if (!details || details.tabId < 0) return;
  try {
    addNetworkItem(details);
  } catch (e) {
    /* 忽略单条失败，避免影响页面请求 */
  }
}

chrome.webRequest.onHeadersReceived.addListener(
  onMediaRequest,
  {
    urls: ['http://*/*', 'https://*/*'],
    types: ['media', 'xmlhttprequest', 'main_frame', 'other', 'object', 'sub_frame']
  },
  ['responseHeaders']
);

/* ---------------- 标签页生命周期 ---------------- */

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // 主文档重新加载 / 跳转时清空旧列表（SPA 的 pushState 不触发 status=loading）
  if (changeInfo.status === 'loading') {
    clearTab(tabId, false);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStore.delete(tabId);
  clearTimeout(persistTimers.get(tabId));
  persistTimers.delete(tabId);
  chrome.storage.session.remove('tab_' + tabId).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#4f6cff' });
});
