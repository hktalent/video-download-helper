/*
 * 内容脚本（isolated world）：
 * 1. 扫描页面 <video>/<audio> 并上报；
 * 2. 在页面上下文中下载并合并 HLS / DASH 流（保留页面 Cookie 与 Referer）；
 * 3. 与主世界脚本桥接 MSE(blob) 捕获；
 * 4. 直链下载失败时的页内下载回退。
 */
(function () {
  'use strict';

  const VDH = globalThis.VDHStream;
  if (!VDH) return;

  const elementIds = new WeakMap();

  let job = null;
  let lastEmit = 0;
  let emitTimer = 0;
  let reportTimer = 0;
  let elementSeq = 0;
  let domItems = [];

  /* ---------------- 与后台通信 ---------------- */

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (e) {
      /* 扩展被卸载时可能抛错 */
    }
  }

  function emit(force) {
    if (!job) return;
    const now = Date.now();
    if (!force && now - lastEmit < 250) {
      if (!emitTimer) {
        emitTimer = setTimeout(() => {
          emitTimer = 0;
          emit(true);
        }, 260);
      }
      return;
    }
    lastEmit = now;
    send({
      type: 'vdh:progress',
      job: {
        id: job.id,
        state: job.state,
        title: job.title,
        phase: job.phase,
        done: job.done,
        total: job.total,
        bytes: job.bytes,
        error: job.error || '',
        ts: now
      }
    });
  }

  /* ---------------- 任务框架 ---------------- */

  function runJob(title, work) {
    if (job) throw new Error('已有下载任务正在进行');

    const current = {
      id: 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: title || '视频下载',
      state: 'running',
      phase: '准备中',
      done: 0,
      total: 0,
      bytes: 0,
      error: '',
      cancelled: false,
      controller: new AbortController()
    };
    job = current;
    lastEmit = 0;
    emit(true);

    return (async () => {
      const ctx = {
        signal: current.controller.signal,
        setPhase: (phase) => {
          current.phase = phase;
          emit(true);
        },
        onProgress: (p) => {
          current.done = p.done;
          current.total = p.total;
          current.bytes = p.bytes;
          if (p.phase) current.phase = p.phase;
          emit(false);
        },
        cancelled: () => current.cancelled
      };

      try {
        await work(ctx);
        current.state = 'done';
        current.phase = '已完成';
        emit(true);
      } catch (err) {
        if (current.cancelled) {
          current.state = 'cancelled';
          current.phase = '已取消';
          current.error = '';
        } else {
          current.state = 'error';
          current.phase = '下载失败';
          current.error = String((err && err.message) || err);
        }
        emit(true);
      } finally {
        if (job === current) job = null;
      }
    })();
  }

  /* ---------------- 网络工具 ---------------- */

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchBuffer(url, range, signal) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const headers = {};
        if (range && range.length) {
          headers.Range = 'bytes=' + range.start + '-' + (range.start + range.length - 1);
        }
        const res = await fetch(url, {
          headers: headers,
          credentials: 'include',
          signal: signal,
          cache: 'default'
        });
        if (range && range.length && res.status !== 206 && res.status !== 200) {
          throw new Error('HTTP ' + res.status);
        }
        if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
        if (range && range.length && res.status === 200) {
          throw new Error('服务器未按字节范围返回数据');
        }
        return await res.arrayBuffer();
      } catch (err) {
        lastError = err;
        if (err && err.name === 'AbortError') throw err;
        if (attempt < 2) await sleep(350 * (attempt + 1));
      }
    }
    throw lastError;
  }

  async function fetchText(url, signal, noStore) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const options = { credentials: 'include' };
        if (signal) options.signal = signal;
        if (noStore) options.cache = 'no-store';
        const res = await fetch(url, options);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.text();
      } catch (err) {
        lastError = err;
        if (err && err.name === 'AbortError') throw err;
        if (attempt < 2) await sleep(350 * (attempt + 1));
      }
    }
    throw lastError;
  }

  function hexToIv(str) {
    let hex = String(str || '').replace(/^0x/i, '');
    if (hex.length % 2) hex = '0' + hex;
    if (hex.length > 32) hex = hex.slice(-32);
    while (hex.length < 32) hex = '0' + hex;
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
    return out;
  }

  function seqToIv(seq) {
    const out = new Uint8Array(16);
    const view = new DataView(out.buffer);
    view.setUint32(12, seq >>> 0, false);
    return out;
  }

  async function decryptSegment(key, buffer, seq, keyCache, signal) {
    if (key.method !== 'AES-128') {
      throw new Error('不支持的 HLS 加密方式: ' + key.method);
    }
    let keyPromise = keyCache.get(key.url);
    if (!keyPromise) {
      keyPromise = (async () => {
        const res = await fetch(key.url, { credentials: 'include', signal: signal });
        if (!res.ok) throw new Error('密钥下载失败 HTTP ' + res.status);
        const raw = await res.arrayBuffer();
        if (raw.byteLength !== 16) throw new Error('密钥长度异常');
        return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
      })();
      keyCache.set(key.url, keyPromise);
    }
    const cryptoKey = await keyPromise;
    const iv = key.iv ? hexToIv(key.iv) : seqToIv(seq);
    return await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, cryptoKey, buffer);
  }

  async function downloadSegments(segments, ctx, label) {
    const total = segments.length;
    const parts = new Array(total);
    const keyCache = new Map();
    const concurrency = Math.min(total > 24 ? 4 : 2, total);
    let next = 0;
    let done = 0;
    let bytes = 0;

    ctx.setPhase(label + ' 0/' + total);

    async function worker() {
      for (;;) {
        if (ctx.cancelled()) throw new Error('已取消');
        const index = next++;
        if (index >= total) return;
        const seg = segments[index];
        let buffer = await fetchBuffer(seg.url, seg.range, ctx.signal);
        if (seg.key && seg.key.url) {
          buffer = await decryptSegment(seg.key, buffer, seg.seq, keyCache, ctx.signal);
        }
        parts[index] = new Uint8Array(buffer);
        done++;
        bytes += buffer.byteLength;
        ctx.onProgress({
          done: done,
          total: total,
          bytes: bytes,
          phase: label + ' ' + done + '/' + total
        });
      }
    }

    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);
    return { parts: parts, bytes: bytes };
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  /* ---------------- 命名 ---------------- */

  // 播放器生成的通用文件名（index/master/playlist…）不适合作为最终文件名
  const GENERIC_NAMES = new Set([
    'index', 'master', 'playlist', 'manifest', 'main', 'media', 'video',
    'stream', 'output', 'hls', 'dash', 'prog_index', 'chunklist', 'live'
  ]);

  function baseTitle(entry) {
    const title = String(entry.title || '').trim();
    if (title && title !== location.hostname) return title;

    let fromUrl = '';
    try {
      fromUrl = decodeURIComponent(new URL(entry.url).pathname.split('/').filter(Boolean).pop() || '')
        .replace(/\.[a-z0-9]{2,5}$/i, '');
    } catch (e) {
      /* ignore */
    }

    if (fromUrl && !GENERIC_NAMES.has(fromUrl.toLowerCase())) return fromUrl;
    return document.title || location.hostname || 'video';
  }

  function qualityLabel(entry, variant) {
    if (variant && variant.resolution && variant.resolution.height) {
      return variant.resolution.height + 'p';
    }
    if (entry.height) return entry.height + 'p';
    return '';
  }

  function buildName(base, quality, ext) {
    let name = VDH.sanitizeFilename(base, 'video');
    if (name.length > 90) name = name.slice(0, 90).trim();
    if (quality) name += ' ' + quality;
    if (!new RegExp('\\.' + ext + '$', 'i').test(name)) name += '.' + ext;
    return name;
  }

  /* ---------------- HLS 直播录制 ---------------- */

  const LIVE_MEMORY_LIMIT = 2 * 1024 * 1024 * 1024;

  /*
   * 无 ENDLIST 的播放列表会持续滚动，需要按轮询刷新并累积新增分片。
   * 用户取消或达到内存上限时停止录制，并把已录内容保存为文件。
   */
  async function recordLivePlaylist(playlist, mediaUrl, parts, ctx, keyCache) {
    const seen = new Set();
    const interval = Math.max(1500, Math.min(10000, ((playlist.targetDuration || 4) * 1000) / 2));
    let recorded = 0;
    let bytes = 0;

    ctx.setPhase('直播录制中 · 已录 0 段');

    async function downloadNew(segments) {
      for (let i = 0; i < segments.length; i++) {
        if (ctx.cancelled()) return;
        const seg = segments[i];
        const key = seg.url + '|' + (seg.range ? seg.range.start + '-' + (seg.range.start + seg.range.length) : '');
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          let buffer = await fetchBuffer(seg.url, seg.range, ctx.signal);
          if (seg.key && seg.key.url) {
            buffer = await decryptSegment(seg.key, buffer, seg.seq, keyCache, ctx.signal);
          }
          parts.push(new Uint8Array(buffer));
          bytes += buffer.byteLength;
          recorded++;
          ctx.onProgress({
            done: recorded,
            total: recorded + 1,
            bytes: bytes,
            phase: '直播录制中 · 已录 ' + recorded + ' 段'
          });
        } catch (err) {
          seen.delete(key);
          if (ctx.cancelled() || (err && err.name === 'AbortError')) return;
          // 单段失败下一轮重试，不影响整体录制
        }
      }
    }

    for (;;) {
      await downloadNew(playlist.segments);
      if (ctx.cancelled()) break;
      if (bytes >= LIVE_MEMORY_LIMIT) {
        ctx.setPhase('已达内存上限，停止录制并保存');
        break;
      }
      if (playlist.endList) break;

      await sleep(interval);
      if (ctx.cancelled()) break;

      let text;
      try {
        text = await fetchText(mediaUrl, ctx.signal, true);
      } catch (err) {
        if (ctx.cancelled() || (err && err.name === 'AbortError')) break;
        continue;
      }
      const next = VDH.parseMediaPlaylist(text, mediaUrl);
      if (!next.segments.length) continue;
      playlist = next;
      // 让出主线程，保持页面可响应
      await sleep(0);
    }

    ctx.setPhase('录制结束 · 共 ' + recorded + ' 段');
    return { recorded: recorded };
  }

  /* ---------------- 清晰度 / 音轨 / 字幕探测 ---------------- */

  const probeCache = new Map(); // 播放列表地址 -> 探测结果

  /*
   * 解析主播放列表，返回可选清晰度、独立音轨和多语言字幕。
   * 探测在页面上下文中进行，因此天然带上 Cookie 与 Referer。
   */
  async function probeStream(url) {
    const cached = probeCache.get(url);
    if (cached) return cached;

    const text = await fetchText(url, null, true);
    const result = { master: false, variants: [], subtitles: [], audio: [] };

    if (/#EXT-X-STREAM-INF:/.test(text)) {
      const master = VDH.parseMasterPlaylist(text, url);
      result.master = true;
      result.variants = master.variants.map((v, i) => ({
        index: i,
        url: v.url,
        bandwidth: v.bandwidth,
        height: v.resolution ? v.resolution.height : 0,
        width: v.resolution ? v.resolution.width : 0,
        codecs: v.codecs || '',
        audioGroup: v.audioGroup || '',
        label: (v.resolution && v.resolution.height ? v.resolution.height + 'p' : '') ||
          (v.bandwidth ? Math.round(v.bandwidth / 1000) + 'kbps' : '#' + (i + 1))
      })).sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));

      result.audio = master.media.audio.filter((a) => a.url).map((a) => ({
        url: a.url,
        lang: a.lang,
        name: a.name,
        groupId: a.groupId,
        isDefault: a.isDefault
      }));

      result.subtitles = master.media.subtitles.filter((s) => s.url).map((s) => ({
        url: s.url,
        lang: s.lang,
        name: s.name
      }));
    } else {
      // 本身就是媒体播放列表：没有可选清晰度，只有一路
      const parsed = VDH.parseMediaPlaylist(text, url);
      result.live = !parsed.endList;
      result.segmentCount = parsed.segments.length;
    }

    probeCache.set(url, result);
    if (probeCache.size > 40) probeCache.delete(probeCache.keys().next().value);
    return result;
  }

  /* 字幕单独保存，不占用主下载任务的进度位。 */
  async function saveSubtitleFile(url, filename) {
    const text = await fetchText(url, null, true);
    if (!text.trim()) throw new Error('字幕内容为空');

    const ext = VDH.extOf(url) || 'vtt';
    let name = VDH.sanitizeFilename(filename || baseTitle({ url: url }), 'subtitle');
    name = buildName(name, '', /^(vtt|srt|ass|ssa)$/i.test(ext) ? ext : 'vtt');
    saveBlob(new Blob([text], { type: 'text/vtt;charset=utf-8' }), name);
    return name;
  }

  /* ---------------- HLS 下载 ---------------- */

  async function downloadHls(entry, ctx) {
    ctx.setPhase('解析播放列表');
    const firstText = await fetchText(entry.url, ctx.signal);

    let variant = null;
    let mediaUrl = entry.url;
    let mediaText = firstText;
    let audioUrl = entry.audioUrl || '';

    if (/#EXT-X-STREAM-INF:/.test(firstText)) {
      const master = VDH.parseMasterPlaylist(firstText, entry.url);
      if (!master.variants.length) throw new Error('主播放列表中没有可用清晰度');

      if (entry.variantUrl) {
        variant = master.variants.find((v) => v.url === entry.variantUrl) ||
          { url: entry.variantUrl, bandwidth: 0, resolution: null, audioGroup: '' };
      } else {
        variant = master.variants.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0];
      }

      if (!audioUrl && variant.audioGroup) {
        const group = master.media.audio.filter((a) => a.groupId === variant.audioGroup && a.url);
        const chosen = group.find((a) => a.isDefault) || group[0];
        if (chosen) audioUrl = chosen.url;
      }
      mediaUrl = variant.url;
      mediaText = await fetchText(mediaUrl, ctx.signal);
    }

    const playlist = VDH.parseMediaPlaylist(mediaText, mediaUrl);
    if (!playlist.segments.length) throw new Error('播放列表中未找到媒体分片');
    const isLive = !playlist.endList;

    const isFmp4 = !!playlist.init ||
      playlist.segments.some((s) => /\.(m4s|mp4|m4v|m4a)(\?|$)/i.test(s.url));
    const ext = isFmp4 ? 'mp4' : 'ts';
    const quality = qualityLabel(entry, variant);
    const base = baseTitle(entry);

    const parts = [];
    if (playlist.init) {
      ctx.setPhase('下载初始化分片');
      const initBuf = await fetchBuffer(playlist.init.url, playlist.init.range, ctx.signal);
      parts.push(new Uint8Array(initBuf));
    }

    if (isLive) {
      // 直播 / 无 ENDLIST：持续录制新增分片，取消后保存已录内容
      await recordLivePlaylist(playlist, mediaUrl, parts, ctx, new Map());
    } else {
      const videoResult = await downloadSegments(playlist.segments, ctx, '下载视频分片');
      parts.push.apply(parts, videoResult.parts);
    }

    ctx.setPhase('保存视频文件');
    saveBlob(
      new Blob(parts, { type: isFmp4 ? 'video/mp4' : 'video/mp2t' }),
      buildName(base, quality, ext)
    );

    // 部分 HLS 把音频单独放在 EXT-X-MEDIA 中，需要额外下载一个音频文件
    if (audioUrl && !ctx.cancelled()) {
      ctx.setPhase('解析音频播放列表');
      const audioText = await fetchText(audioUrl, ctx.signal);
      const audioPlaylist = VDH.parseMediaPlaylist(audioText, audioUrl);
      if (audioPlaylist.segments.length) {
        const audioParts = [];
        if (audioPlaylist.init) {
          const initBuf = await fetchBuffer(audioPlaylist.init.url, audioPlaylist.init.range, ctx.signal);
          audioParts.push(new Uint8Array(initBuf));
        }
        if (!audioPlaylist.endList) {
          await recordLivePlaylist(audioPlaylist, audioUrl, audioParts, ctx, new Map());
        } else {
          const audioResult = await downloadSegments(audioPlaylist.segments, ctx, '下载音频分片');
          audioParts.push.apply(audioParts, audioResult.parts);
        }

        const audioFmp4 = !!audioPlaylist.init ||
          /\.(m4s|mp4|m4a)(\?|$)/i.test(audioPlaylist.segments[0].url);
        ctx.setPhase('保存音频文件');
        // TS 封装下音频仍是 MPEG-TS 流，使用 .ts 扩展名便于播放器识别
        saveBlob(
          new Blob(audioParts, { type: audioFmp4 ? 'audio/mp4' : 'video/mp2t' }),
          buildName(base + ' audio', quality, audioFmp4 ? 'm4a' : 'ts')
        );
      }
    }
  }

  /* ---------------- DASH 下载 ---------------- */

  function pickBestDash(list) {
    return list.slice().sort((a, b) => {
      if (b.bandwidth !== a.bandwidth) return b.bandwidth - a.bandwidth;
      return (b.height || 0) - (a.height || 0);
    })[0];
  }

  /*
   * SegmentBase（单文件 DASH）：下载 init + sidx 索引，再按索引范围下载子段并合并；
   * 没有可用索引时退回整文件下载。
   */
  async function collectDashSingleFile(rep, ctx, label) {
    const parts = [];
    const indexRange = rep.index && !rep.index.external ? rep.index.range : null;
    const initRange = rep.init ? rep.init.range : null;

    // init 与索引范围重叠时无法按段拼接，直接整文件下载
    const overlap = !!(initRange && indexRange &&
      initRange.start < indexRange.start + indexRange.length &&
      indexRange.start < initRange.start + initRange.length);

    if (overlap) {
      ctx.setPhase('下载' + label + '完整文件');
      const whole = await fetchBuffer(rep.baseUrl, null, ctx.signal);
      ctx.onProgress({ done: 1, total: 1, bytes: whole.byteLength, phase: '下载' + label + '完整文件' });
      return [new Uint8Array(whole)];
    }

    if (rep.init) {
      const sameAsMedia = !initRange && rep.init.url === rep.baseUrl;
      if (!sameAsMedia) {
        ctx.setPhase('下载' + label + '初始化分片');
        const initBuf = await fetchBuffer(rep.init.url, initRange, ctx.signal);
        parts.push(new Uint8Array(initBuf));
      }
    }

    let sidx = null;
    if (rep.index) {
      try {
        ctx.setPhase('读取' + label + '分片索引');
        const indexBuf = await fetchBuffer(rep.index.url, rep.index.range, ctx.signal);
        const baseOffset = rep.index.external ? 0 : (rep.index.range ? rep.index.range.start : 0);
        sidx = VDH.parseSidx(indexBuf, baseOffset);
      } catch (err) {
        if (ctx.cancelled() || (err && err.name === 'AbortError')) throw err;
        sidx = null;
      }
    }

    if (sidx && sidx.references.length) {
      const segments = sidx.references.map((ref) => ({
        url: rep.baseUrl,
        range: { start: ref.start, length: ref.length }
      }));
      const result = await downloadSegments(segments, ctx, '下载' + label + '分片');
      parts.push.apply(parts, result.parts);
      return parts;
    }

    ctx.setPhase('下载' + label + '完整文件');
    const whole = await fetchBuffer(rep.baseUrl, null, ctx.signal);
    ctx.onProgress({ done: 1, total: 1, bytes: whole.byteLength, phase: '下载' + label + '完整文件' });
    return [new Uint8Array(whole)];
  }

  async function downloadDash(entry, ctx) {
    ctx.setPhase('解析 MPD');
    const text = await fetchText(entry.url, ctx.signal);
    const mpd = VDH.parseMpd(text, entry.url);

    const video = pickBestDash(mpd.videos);
    const audio = pickBestDash(mpd.audios);
    if (!video && !audio) {
      if (mpd.unsupported.length) throw new Error('MPD 中没有可直接下载的轨道（缺少 BaseURL 或分片信息）');
      throw new Error('MPD 中没有可下载的音视频轨道');
    }

    const base = baseTitle(entry);
    const tracks = [];
    if (video) tracks.push({ rep: video, kind: 'video' });
    if (audio) tracks.push({ rep: audio, kind: 'audio' });

    for (const track of tracks) {
      const rep = track.rep;
      const label = track.kind === 'video' ? '视频' : '音频';
      let parts;

      if (rep.singleFile) {
        parts = await collectDashSingleFile(rep, ctx, label);
      } else {
        parts = [];
        if (rep.init) {
          ctx.setPhase('下载' + label + '初始化分片');
          const initBuf = await fetchBuffer(rep.init.url, rep.init.range, ctx.signal);
          parts.push(new Uint8Array(initBuf));
        }

        const result = await downloadSegments(rep.segments, ctx, '下载' + label + '分片');
        parts.push.apply(parts, result.parts);
      }

      const mime = String(rep.mime || '').toLowerCase();
      const ext = mime.indexOf('webm') >= 0 ? 'webm' : (track.kind === 'audio' ? 'm4a' : 'mp4');
      const quality = rep.height ? rep.height + 'p' : '';
      const suffix = track.kind === 'audio' && tracks.length > 1 ? ' audio' : '';

      ctx.setPhase('保存' + label + '文件');
      saveBlob(
        new Blob(parts, { type: mime || (track.kind === 'audio' ? 'audio/mp4' : 'video/mp4') }),
        buildName(base + suffix, quality, ext)
      );
    }

    if (tracks.length > 1) {
      ctx.setPhase('已保存视频与音频两个文件，可用 ffmpeg 合并');
    }
  }

  /* ---------------- 直链页内回退 ---------------- */

  function downloadDirectViaPage(url, filename) {
    runJob(filename || '视频下载', async (ctx) => {
      ctx.setPhase('页面内下载中');
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      if (!blob.size) throw new Error('下载内容为空');
      ctx.onProgress({ done: 1, total: 1, bytes: blob.size, phase: '保存文件' });
      saveBlob(blob, VDH.sanitizeFilename(filename, 'video'));
    }).catch(() => {});
  }

  /* ---------------- DOM 扫描 ---------------- */

  function elementId(el) {
    let id = elementIds.get(el);
    if (!id) {
      id = 'el' + (++elementSeq);
      elementIds.set(el, id);
    }
    return id;
  }

  function absolute(url) {
    if (!url) return '';
    try {
      return new URL(url, location.href).href;
    } catch (e) {
      return url;
    }
  }

  function collectDomItems() {
    const items = [];
    document.querySelectorAll('video, audio').forEach((el) => {
      let src = el.currentSrc || el.getAttribute('src') || '';
      if (!src) {
        const source = el.querySelector('source[src]');
        if (source) src = source.src || source.getAttribute('src') || '';
      }
      if (!src) return;

      const blob = src.indexOf('blob:') === 0;
      items.push({
        id: elementId(el),
        url: blob ? src : absolute(src),
        kind: blob ? 'blob' : 'file',
        title: el.getAttribute('title') || document.title || '',
        poster: el.poster ? absolute(el.poster) : '',
        duration: Number.isFinite(el.duration) ? Math.round(el.duration) : 0,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0
      });
    });
    domItems = items;
    return items;
  }

  function scanAndReport() {
    const items = collectDomItems();
    if (items.length) {
      send({ type: 'domMedia', items: items });
    }
    return items;
  }

  function scheduleScan(delay) {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      reportTimer = 0;
      scanAndReport();
    }, delay || 300);
  }

  function isMediaTarget(target) {
    return target && (target.tagName === 'VIDEO' || target.tagName === 'AUDIO');
  }

  document.addEventListener('loadedmetadata', (e) => {
    if (isMediaTarget(e.target)) scheduleScan(120);
  }, true);

  document.addEventListener('play', (e) => {
    if (isMediaTarget(e.target)) scheduleScan(300);
  }, true);

  document.addEventListener('durationchange', (e) => {
    if (isMediaTarget(e.target)) scheduleScan(600);
  }, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scheduleScan(0), { once: true });
  } else {
    scheduleScan(0);
  }
  setTimeout(() => scheduleScan(0), 1200);
  setTimeout(() => scheduleScan(0), 4000);

  let ticks = 0;
  const ticker = setInterval(() => {
    if (document.hidden) return;
    scanAndReport();
    if (++ticks >= 40) clearInterval(ticker);
  }, 6000);

  /* ---------------- MSE 桥接（主世界 ↔ 内容脚本） ---------------- */

  function postToMain(action) {
    try {
      window.postMessage({ __vdh: 'mse-cmd', action: action }, '*');
    } catch (e) {
      /* ignore */
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.__vdh === 'mse-state' && data.state) {
      send({ type: 'mseState', state: data.state });
      return;
    }

    if (data.__vdh === 'mse-saved') {
      const now = Date.now();
      if (data.ok) {
        send({
          type: 'vdh:progress',
          job: {
            id: 'mse' + now,
            state: 'done',
            title: 'MSE 流捕获',
            phase: '已保存 ' + (data.files || 1) + ' 个文件',
            done: 1,
            total: 1,
            bytes: data.bytes || 0,
            error: '',
            ts: now
          }
        });
      } else {
        send({
          type: 'vdh:progress',
          job: {
            id: 'mse' + now,
            state: 'error',
            title: 'MSE 流捕获',
            phase: '保存失败',
            done: 0,
            total: 0,
            bytes: 0,
            error: data.error || '没有可用数据',
            ts: now
          }
        });
      }
    }
  });

  setTimeout(() => postToMain('state'), 500);
  setTimeout(() => postToMain('state'), 3000);

  /* ---------------- 消息路由 ---------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'vdh:scan': {
        const items = scanAndReport();
        postToMain('state');
        sendResponse({ ok: true, count: items.length });
        break;
      }

      case 'vdh:probe': {
        probeStream(msg.url)
          .then((result) => {
            send({ type: 'vdh:variants', key: msg.key || '', payload: result });
            sendResponse({ ok: true, result: result });
          })
          .catch((err) => sendResponse({
            ok: false,
            error: String((err && err.message) || err)
          }));
        return true;
      }

      case 'vdh:sub': {
        saveSubtitleFile(msg.url, msg.filename)
          .then((name) => sendResponse({ ok: true, filename: name }))
          .catch((err) => sendResponse({
            ok: false,
            error: String((err && err.message) || err)
          }));
        return true;
      }

      case 'vdh:download': {
        const entry = msg.entry;
        if (!entry) {
          sendResponse({ ok: false, error: '缺少媒体信息' });
          break;
        }
        if (job) {
          sendResponse({ ok: false, error: '已有下载任务进行中' });
          break;
        }
        const starter = entry.kind === 'hls' ? downloadHls :
          entry.kind === 'dash' ? downloadDash : null;
        if (!starter) {
          sendResponse({ ok: false, error: '该类型不支持页内下载' });
          break;
        }
        runJob(baseTitle(entry), (ctx) => starter(entry, ctx)).catch(() => {});
        sendResponse({ ok: true });
        break;
      }

      case 'vdh:cancel': {
        if (job) {
          job.cancelled = true;
          job.phase = '正在取消…';
          emit(true);
          try {
            job.controller.abort();
          } catch (e) {
            /* ignore */
          }
        }
        sendResponse({ ok: !!job });
        break;
      }

      case 'vdh:job': {
        sendResponse({
          job: job ? {
            id: job.id,
            state: job.state,
            phase: job.phase,
            done: job.done,
            total: job.total,
            bytes: job.bytes
          } : null
        });
        break;
      }

      case 'vdh:mse': {
        postToMain(msg.action || 'state');
        sendResponse({ ok: true });
        break;
      }

      case 'vdh:fetch-save': {
        downloadDirectViaPage(msg.url, msg.filename);
        sendResponse({ ok: true });
        break;
      }

      default:
        break;
    }
  });

  // 供调试查看当前帧扫描结果
  globalThis.__VDH_DOM_ITEMS__ = () => domItems;
})();
