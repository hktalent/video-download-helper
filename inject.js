/*
 * 页面主世界（MAIN world）脚本：
 * 在页面启动早期挂钩 MediaSource / SourceBuffer，用于捕获通过 MSE(blob) 播放的流。
 * 仅在用户主动开启捕获后落盘，避免常态占用内存。
 */
(function () {
  'use strict';

  if (window.__VDH_MSE_HOOKED__) return;
  window.__VDH_MSE_HOOKED__ = true;

  var MediaSourceCtor = window.MediaSource;
  var SourceBufferCtor = window.SourceBuffer;
  if (!MediaSourceCtor || !SourceBufferCtor || !SourceBufferCtor.prototype.appendBuffer) return;

  var LIMIT = 900 * 1024 * 1024; // 单页捕获上限，超过后停止，避免拖垮页面
  var FLAG_KEY = '__vdh_mse_capture__';

  var state = {
    active: false,
    bytes: 0,
    truncated: false,
    tracks: new Map()
  };
  var stateTimer = 0;

  try {
    state.active = window.localStorage.getItem(FLAG_KEY) === '1';
  } catch (e) {
    state.active = false;
  }

  function post(type, payload) {
    try {
      window.postMessage(Object.assign({ __vdh: type }, payload || {}), '*');
    } catch (e) {
      /* ignore */
    }
  }

  function trackFor(mime) {
    var track = state.tracks.get(mime);
    if (!track) {
      track = { mime: mime, chunks: [], bytes: 0, segments: 0 };
      state.tracks.set(mime, track);
    }
    return track;
  }

  function trackSnapshot() {
    var list = [];
    state.tracks.forEach(function (track) {
      if (track.bytes > 0) {
        list.push({ mime: track.mime, bytes: track.bytes, segments: track.segments });
      }
    });
    return list;
  }

  function postState(immediate) {
    if (!immediate) {
      if (stateTimer) return;
      stateTimer = setTimeout(function () {
        stateTimer = 0;
        postState(true);
      }, 600);
      return;
    }
    clearTimeout(stateTimer);
    stateTimer = 0;
    post('mse-state', {
      state: {
        active: state.active,
        bytes: state.bytes,
        truncated: state.truncated,
        tracks: trackSnapshot()
      }
    });
  }

  /* ---- 挂钩 addSourceBuffer，记录每条轨道的 mime ---- */
  var origAddSourceBuffer = MediaSourceCtor.prototype.addSourceBuffer;
  MediaSourceCtor.prototype.addSourceBuffer = function (mime) {
    var sb = origAddSourceBuffer.apply(this, arguments);
    try {
      sb.__vdhMime = mime || 'application/octet-stream';
    } catch (e) {
      /* ignore */
    }
    return sb;
  };

  /* ---- 挂钩 appendBuffer，按轨道累积数据 ---- */
  var origAppendBuffer = SourceBufferCtor.prototype.appendBuffer;
  SourceBufferCtor.prototype.appendBuffer = function (data) {
    try {
      if (state.active && data && !state.truncated) {
        var copy = null;
        if (data instanceof ArrayBuffer) {
          copy = data.slice(0);
        } else if (ArrayBuffer.isView(data)) {
          copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        }
        if (copy) {
          if (state.bytes + copy.byteLength > LIMIT) {
            state.truncated = true;
            state.active = false;
            postState(true);
          } else {
            var track = trackFor(this.__vdhMime || 'application/octet-stream');
            track.chunks.push(new Uint8Array(copy));
            track.bytes += copy.byteLength;
            track.segments += 1;
            state.bytes += copy.byteLength;
            postState(false);
          }
        }
      }
    } catch (e) {
      /* 捕获失败不能影响播放 */
    }
    return origAppendBuffer.apply(this, arguments);
  };

  /* ---- 文件名 / 扩展名 ---- */
  function baseMime(mime) {
    return String(mime || '').split(';')[0].trim().toLowerCase();
  }

  function extForMime(mime) {
    var map = {
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'video/mp2t': 'ts',
      'audio/mp4': 'm4a',
      'audio/webm': 'weba',
      'audio/mpeg': 'mp3',
      'audio/aac': 'aac',
      'audio/ogg': 'ogg'
    };
    return map[baseMime(mime)] || 'mp4';
  }

  function sanitize(name) {
    return String(name || '')
      .replace(/[\u0000-\u001f<>:"/\\|?*\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 110) || 'video';
  }

  function save() {
    var tracks = [];
    state.tracks.forEach(function (track) {
      if (track.bytes > 0) tracks.push(track);
    });
    if (!tracks.length) {
      post('mse-saved', { ok: false, error: '尚未捕获到任何媒体数据' });
      return;
    }

    var title = sanitize(document.title || location.hostname);
    var saved = 0;

    tracks.forEach(function (track, index) {
      var mime = baseMime(track.mime) || 'application/octet-stream';
      var ext = extForMime(mime);
      var kind = mime.indexOf('audio/') === 0 ? 'audio' : 'video';
      var name = title + ' ' + kind;
      if (tracks.length > 1) name += ' ' + (index + 1);
      name += '.' + ext;

      try {
        var blob = new Blob(track.chunks, { type: mime });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.style.display = 'none';
        (document.body || document.documentElement).appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
        saved++;
      } catch (e) {
        /* ignore */
      }
    });

    state.active = false;
    try {
      window.localStorage.removeItem(FLAG_KEY);
    } catch (e) {
      /* ignore */
    }

    post('mse-saved', { ok: saved > 0, files: saved, bytes: state.bytes });
    postState(true);
  }

  function reset() {
    state.tracks.clear();
    state.bytes = 0;
    state.truncated = false;
    state.active = false;
    try {
      window.localStorage.removeItem(FLAG_KEY);
    } catch (e) {
      /* ignore */
    }
    postState(true);
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || data.__vdh !== 'mse-cmd') return;

    switch (data.action) {
      case 'start':
        state.active = true;
        state.truncated = false;
        try {
          window.localStorage.setItem(FLAG_KEY, '1');
        } catch (e) {
          /* ignore */
        }
        postState(true);
        break;
      case 'stop':
        state.active = false;
        try {
          window.localStorage.removeItem(FLAG_KEY);
        } catch (e) {
          /* ignore */
        }
        postState(true);
        break;
      case 'reset':
        reset();
        break;
      case 'save':
        save();
        break;
      case 'state':
        postState(true);
        break;
    }
  });

  postState(true);
})();
