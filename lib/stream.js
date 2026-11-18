/*
 * HLS / DASH 播放列表解析工具。
 * 运行环境：内容脚本（isolated world）与 Node 测试。
 */
(function (global) {
  'use strict';

  var VDH = {};

  function absoluteUrl(url, base) {
    if (!url) return '';
    try {
      return new URL(url, base).href;
    } catch (e) {
      return url;
    }
  }

  function joinBase(base, child) {
    if (!child) return base || '';
    try {
      return new URL(child.trim(), base).href;
    } catch (e) {
      return child.trim();
    }
  }

  /* 解析 "KEY=VALUE,KEY2=VALUE2" 形式的属性列表（忽略引号内逗号）。 */
  function parseAttrs(str) {
    var out = {};
    var re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
    var m;
    while ((m = re.exec(str || ''))) {
      var v = m[2];
      if (v && v.charAt(0) === '"') v = v.slice(1, -1);
      out[m[1].toUpperCase()] = v;
    }
    return out;
  }

  function parseResolution(value) {
    var m = /^(\d+)x(\d+)$/.exec((value || '').trim());
    return m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : null;
  }

  /* 解析 "长度@起点" 或 "长度" 形式的字节范围（HLS）。 */
  function parseRange(value) {
    if (!value) return null;
    var s = String(value).replace(/"/g, '').trim();
    var m = /^(\d+)@(\d+)$/.exec(s);
    if (m) return { length: parseInt(m[1], 10), start: parseInt(m[2], 10) };
    m = /^(\d+)$/.exec(s);
    if (m) return { length: parseInt(m[1], 10), start: null };
    return null;
  }

  /* 解析 "起点-终点" 形式的字节范围（DASH）。 */
  function parseDashRange(value) {
    if (!value) return null;
    var s = String(value).replace(/"/g, '').trim();
    var m = /^(\d+)-(\d+)$/.exec(s);
    if (m) {
      var start = parseInt(m[1], 10);
      var end = parseInt(m[2], 10);
      return { start: start, length: Math.max(0, end - start + 1) };
    }
    m = /^(\d+)$/.exec(s);
    if (m) return { start: parseInt(m[1], 10), length: null };
    return null;
  }

  /* ---------------- HLS ---------------- */

  function parseMasterPlaylist(text, baseUrl) {
    var lines = String(text || '').split(/\r?\n/);
    var variants = [];
    var media = { audio: [], video: [], subtitles: [] };
    var pending = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
        var a = parseAttrs(line.slice(18));
        pending = {
          bandwidth: parseInt(a.BANDWIDTH || '0', 10) || 0,
          averageBandwidth: parseInt(a['AVERAGE-BANDWIDTH'] || '0', 10) || 0,
          resolution: parseResolution(a.RESOLUTION),
          codecs: a.CODECS || '',
          audioGroup: a.AUDIO || '',
          videoGroup: a.VIDEO || '',
          url: ''
        };
        continue;
      }

      if (line.indexOf('#EXT-X-MEDIA:') === 0) {
        var m = parseAttrs(line.slice(13));
        var type = (m.TYPE || '').toUpperCase();
        var item = {
          type: type,
          groupId: m['GROUP-ID'] || '',
          name: m.NAME || '',
          lang: m.LANGUAGE || '',
          isDefault: (m.DEFAULT || '').toUpperCase() === 'YES',
          url: m.URI ? absoluteUrl(m.URI, baseUrl) : ''
        };
        if (type === 'AUDIO') media.audio.push(item);
        else if (type === 'VIDEO') media.video.push(item);
        else if (type === 'SUBTITLES') media.subtitles.push(item);
        continue;
      }

      if (pending && line.charAt(0) !== '#') {
        pending.url = absoluteUrl(line, baseUrl);
        if (pending.url) variants.push(pending);
        pending = null;
      }
    }

    return { variants: variants, media: media };
  }

  function parseMediaPlaylist(text, baseUrl) {
    var lines = String(text || '').split(/\r?\n/);
    var segments = [];
    var init = null;
    var endList = false;
    var targetDuration = 0;
    var playlistType = '';
    var mediaSequence = 0;
    var currentKey = null;
    var pendingDuration = 0;
    var pendingRange = null;
    var pendingDiscontinuity = false;
    var lastRange = { url: '', end: 0 };
    var seq = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      if (line.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) {
        mediaSequence = parseInt(line.split(':')[1], 10) || 0;
        seq = mediaSequence;
        continue;
      }
      if (line.indexOf('#EXT-X-TARGETDURATION:') === 0) {
        targetDuration = parseFloat(line.split(':')[1]) || 0;
        continue;
      }
      if (line.indexOf('#EXT-X-PLAYLIST-TYPE:') === 0) {
        playlistType = line.split(':')[1].trim().toUpperCase();
        continue;
      }
      if (line === '#EXT-X-ENDLIST') {
        endList = true;
        continue;
      }
      if (line.indexOf('#EXT-X-MAP:') === 0) {
        var map = parseAttrs(line.slice(11));
        init = {
          url: absoluteUrl(map.URI, baseUrl),
          range: parseRange(map.BYTERANGE)
        };
        continue;
      }
      if (line.indexOf('#EXT-X-KEY:') === 0) {
        var key = parseAttrs(line.slice(11));
        var method = (key.METHOD || 'NONE').toUpperCase();
        if (method === 'NONE') {
          currentKey = null;
        } else {
          currentKey = {
            method: method,
            url: key.URI ? absoluteUrl(key.URI, baseUrl) : '',
            iv: key.IV || ''
          };
        }
        continue;
      }
      if (line.indexOf('#EXTINF:') === 0) {
        pendingDuration = parseFloat(line.slice(8).split(',')[0]) || 0;
        continue;
      }
      if (line.indexOf('#EXT-X-BYTERANGE:') === 0) {
        pendingRange = parseRange(line.slice(17));
        continue;
      }
      if (line === '#EXT-X-DISCONTINUITY') {
        pendingDiscontinuity = true;
        continue;
      }
      if (line === '#EXT-X-GAP') {
        pendingDuration = -1;
        continue;
      }
      if (line.charAt(0) === '#') continue;

      // 媒体分片 URL 行
      var url = absoluteUrl(line, baseUrl);
      var range = null;
      if (pendingRange) {
        var start = pendingRange.start;
        if (start == null) start = lastRange.url === url ? lastRange.end : 0;
        range = { start: start, length: pendingRange.length };
        lastRange = { url: url, end: start + pendingRange.length };
      }

      if (pendingDuration >= 0) {
        segments.push({
          url: url,
          duration: pendingDuration,
          range: range,
          seq: seq,
          key: currentKey,
          discontinuity: pendingDiscontinuity
        });
      }

      pendingDuration = 0;
      pendingRange = null;
      pendingDiscontinuity = false;
      seq++;
    }

    return {
      segments: segments,
      init: init,
      endList: endList,
      targetDuration: targetDuration,
      playlistType: playlistType,
      mediaSequence: mediaSequence
    };
  }

  /* ---------------- DASH ---------------- */

  function childEls(el, name) {
    var out = [];
    if (!el) return out;
    var children = el.children || [];
    for (var i = 0; i < children.length; i++) {
      if (children[i].localName === name) out.push(children[i]);
    }
    return out;
  }

  function directChild(el, name) {
    return childEls(el, name)[0] || null;
  }

  function textOf(el) {
    return el && el.textContent ? el.textContent.trim() : '';
  }

  function parseIsoDuration(str) {
    if (!str) return 0;
    var m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(String(str).trim());
    if (!m) return 0;
    return (parseInt(m[1] || '0', 10) || 0) * 86400 +
      (parseInt(m[2] || '0', 10) || 0) * 3600 +
      (parseInt(m[3] || '0', 10) || 0) * 60 +
      (parseFloat(m[4] || '0') || 0);
  }

  /*
   * DASH 模板变量替换：$$ 是转义的单字符 $，其余 $Var$ / $Var%0Nd$ 按规范展开。
   * 先替换 $ 再还原，避免 "$$" 被当成变量边界吃掉。
   */
  function fillUrlTemplate(tpl, vars) {
    var SENTINEL = '\u0001';
    var out = String(tpl).split('$$').join(SENTINEL);

    out = out.replace(/\$([A-Za-z]+)(?:%0(\d+)d)?\$/g, function (all, name, pad) {
      var value;
      if (name === 'RepresentationID') value = vars.id == null ? '' : String(vars.id);
      else if (name === 'Bandwidth') value = String(vars.bandwidth == null ? '' : vars.bandwidth);
      else if (name === 'Number') value = String(vars.number == null ? '' : vars.number);
      else if (name === 'Time') value = String(vars.time == null ? 0 : vars.time);
      else return all;
      if (!value) return all;
      if (pad) value = value.padStart(parseInt(pad, 10), '0');
      return value;
    });

    return out.split(SENTINEL).join('$');
  }

  function buildFromTemplate(rep) {
    var tpl = rep.template;
    var base = rep.baseUrl;
    var media = tpl.getAttribute('media') || '';
    var initTpl = tpl.getAttribute('initialization') || '';
    if (!media) return null;

    var startNumber = parseInt(tpl.getAttribute('startNumber') || '1', 10) || 1;
    var timescale = parseFloat(tpl.getAttribute('timescale') || '1') || 1;
    var pto = parseFloat(tpl.getAttribute('presentationTimeOffset') || '0') || 0;
    var segDurTicks = parseFloat(tpl.getAttribute('duration') || '0');
    var vars = { id: rep.id, bandwidth: rep.bandwidth };

    var init = null;
    if (initTpl) {
      init = {
        url: absoluteUrl(fillUrlTemplate(initTpl, {
          id: rep.id, bandwidth: rep.bandwidth, number: startNumber, time: 0
        }), base),
        range: null
      };
    }

    var segments = [];
    var timeline = directChild(tpl, 'SegmentTimeline');

    if (timeline) {
      var time = 0;
      var number = startNumber;
      var sList = childEls(timeline, 'S');
      for (var i = 0; i < sList.length; i++) {
        var s = sList[i];
        var t = s.getAttribute('t');
        if (t != null) time = parseInt(t, 10) || 0;
        var d = parseInt(s.getAttribute('d') || '0', 10);
        if (!d) continue;
        var repeat = parseInt(s.getAttribute('r') || '0', 10);
        var count = repeat >= 0 ? repeat + 1 : 1;
        for (var k = 0; k < count; k++) {
          segments.push({
            url: absoluteUrl(fillUrlTemplate(media, {
              id: rep.id, bandwidth: rep.bandwidth, number: number, time: time
            }), base),
            range: null
          });
          time += d;
          number++;
        }
      }
    } else if (segDurTicks > 0 && rep.periodDuration > 0) {
      var segDur = segDurTicks / timescale;
      var total = Math.ceil(rep.periodDuration / segDur);
      for (var n = 0; n < total; n++) {
        segments.push({
          url: absoluteUrl(fillUrlTemplate(media, {
            id: rep.id,
            bandwidth: rep.bandwidth,
            number: startNumber + n,
            time: Math.round(n * segDurTicks + pto)
          }), base),
          range: null
        });
      }
    } else {
      return null;
    }

    return segments.length ? { init: init, segments: segments } : null;
  }

  function buildFromSegmentList(rep) {
    var list = rep.list;
    var base = rep.baseUrl;
    var init = null;
    var initEl = directChild(list, 'Initialization');
    if (initEl) {
      var initUrl = initEl.getAttribute('sourceURL') || textOf(initEl);
      if (initUrl) {
        init = { url: absoluteUrl(initUrl, base), range: parseDashRange(initEl.getAttribute('range')) };
      }
    }
    var urls = childEls(list, 'SegmentURL');
    var segments = [];
    for (var i = 0; i < urls.length; i++) {
      var url = urls[i].getAttribute('media') || textOf(urls[i]);
      if (!url) continue;
      segments.push({
        url: absoluteUrl(url, base),
        range: parseDashRange(urls[i].getAttribute('mediaRange'))
      });
    }
    return segments.length ? { init: init, segments: segments } : null;
  }

  /* SegmentBase：整文件 + sidx 索引，常见于单文件 MP4 的 DASH。 */
  function buildFromSegmentBase(rep) {
    var sb = rep.segBase;
    if (!sb) return null;
    // 没有显式 BaseURL 时无法确定媒体文件地址，避免把 MPD 地址当媒体下载
    if (!rep.explicitBase) return null;

    var init = null;
    var initEl = directChild(sb, 'Initialization');
    if (initEl) {
      var initUrl = initEl.getAttribute('sourceURL') || textOf(initEl) || rep.baseUrl;
      init = {
        url: absoluteUrl(initUrl, rep.baseUrl),
        range: parseDashRange(initEl.getAttribute('range'))
      };
    }

    var index = null;
    var indexEl = directChild(sb, 'RepresentationIndex') || directChild(sb, 'IndexSegment');
    if (indexEl) {
      var idxUrl = indexEl.getAttribute('sourceURL') || textOf(indexEl);
      index = {
        url: idxUrl ? absoluteUrl(idxUrl, rep.baseUrl) : rep.baseUrl,
        range: parseDashRange(indexEl.getAttribute('range')),
        external: !!idxUrl
      };
    } else {
      var indexRange = parseDashRange(sb.getAttribute('indexRange'));
      if (indexRange) index = { url: rep.baseUrl, range: indexRange, external: false };
    }

    return { singleFile: true, init: init, index: index, segments: [] };
  }

  function buildDashSegments(rep) {
    if (rep.list) return buildFromSegmentList(rep);
    if (rep.template) return buildFromTemplate(rep);
    if (rep.segBase) return buildFromSegmentBase(rep);
    return null;
  }

  function parseMpd(text, manifestUrl) {
    if (typeof DOMParser === 'undefined') throw new Error('当前环境不支持 DOMParser');
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    var root = doc.documentElement;
    if (!root || root.localName === 'parsererror' || root.getElementsByTagName('parsererror').length) {
      throw new Error('MPD 解析失败');
    }
    if (root.localName !== 'MPD') throw new Error('不是有效的 MPD 文件');

    var mpdBaseUrl = textOf(directChild(root, 'BaseURL'));
    var mpdBase = joinBase(manifestUrl, mpdBaseUrl);
    var type = root.getAttribute('type') || 'static';
    var mpdDuration = parseIsoDuration(root.getAttribute('mediaPresentationDuration') || '');
    var periods = childEls(root, 'Period');
    var videos = [];
    var audios = [];
    var unsupported = [];

    periods.forEach(function (period, pIndex) {
      var periodBaseUrl = textOf(directChild(period, 'BaseURL'));
      var periodBase = joinBase(mpdBase, periodBaseUrl);
      var periodDuration = parseIsoDuration(period.getAttribute('duration') || '') || mpdDuration;

      childEls(period, 'AdaptationSet').forEach(function (set) {
        var setBaseUrl = textOf(directChild(set, 'BaseURL'));
        var setBase = joinBase(periodBase, setBaseUrl);
        var setMime = set.getAttribute('mimeType') || '';
        var setContentType = (set.getAttribute('contentType') || '').toLowerCase();
        var setTemplate = directChild(set, 'SegmentTemplate');
        var setList = directChild(set, 'SegmentList');
        var setSegBase = directChild(set, 'SegmentBase');

        childEls(set, 'Representation').forEach(function (repEl, rIndex) {
          var mime = repEl.getAttribute('mimeType') || setMime || '';
          var kind = setContentType || (mime.split('/')[0] || '').toLowerCase();
          if (kind !== 'video' && kind !== 'audio') return;

          var repBaseUrl = textOf(directChild(repEl, 'BaseURL'));
          var rep = {
            id: repEl.getAttribute('id') || ('p' + pIndex + 'r' + rIndex),
            kind: kind,
            mime: mime,
            codecs: repEl.getAttribute('codecs') || set.getAttribute('codecs') || '',
            bandwidth: parseInt(repEl.getAttribute('bandwidth') || '0', 10) || 0,
            width: parseInt(repEl.getAttribute('width') || '0', 10) || 0,
            height: parseInt(repEl.getAttribute('height') || '0', 10) || 0,
            baseUrl: joinBase(setBase, repBaseUrl),
            explicitBase: !!(repBaseUrl || setBaseUrl || periodBaseUrl || mpdBaseUrl),
            template: directChild(repEl, 'SegmentTemplate') || setTemplate,
            list: directChild(repEl, 'SegmentList') || setList,
            segBase: directChild(repEl, 'SegmentBase') || setSegBase,
            periodDuration: periodDuration
          };

          var info = buildDashSegments(rep);
          if (!info) {
            unsupported.push(rep);
            return;
          }
          rep.init = info.init;
          rep.segments = info.segments || [];
          rep.singleFile = !!info.singleFile;
          rep.index = info.index || null;
          (kind === 'video' ? videos : audios).push(rep);
        });
      });
    });

    return {
      type: type,
      duration: mpdDuration,
      videos: videos,
      audios: audios,
      unsupported: unsupported
    };
  }

  /* ---------------- ISO BMFF sidx ---------------- */

  /*
   * 解析 MP4 中的 sidx 索引盒，返回各子段在媒体文件中的字节范围。
   * baseOffset 为 buffer[0] 在媒体文件中的绝对偏移（Range 下载时使用）。
   */
  function parseSidx(buffer, baseOffset) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var offset = 0;
    baseOffset = baseOffset || 0;

    while (offset + 8 <= bytes.byteLength) {
      var size = view.getUint32(offset);
      var type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5],
        bytes[offset + 6], bytes[offset + 7]);
      var header = 8;
      if (size === 1) {
        if (offset + 16 > bytes.byteLength) break;
        size = view.getUint32(offset + 8) * 4294967296 + view.getUint32(offset + 12);
        header = 16;
      } else if (size === 0) {
        size = bytes.byteLength - offset;
      }
      if (size < header) break;

      if (type === 'sidx') {
        var boxEnd = Math.min(offset + size, bytes.byteLength);
        var p = offset + header;
        if (p + 12 > boxEnd) break;
        var version = bytes[p];
        var timescale = view.getUint32(p + 8);
        var firstOffsetPos = p + 12 + (version === 0 ? 4 : 8);
        if (firstOffsetPos + 4 > boxEnd) break;
        var firstOffset = version === 0 ? view.getUint32(firstOffsetPos) :
          (view.getBigUint64 ? Number(view.getBigUint64(firstOffsetPos)) : 0);
        var countPos = firstOffsetPos + (version === 0 ? 4 : 8) + 2;
        if (countPos + 2 > boxEnd) break;
        var count = view.getUint16(countPos);
        var rp = countPos + 2;
        // sidx 的偏移基准是索引盒结束位置
        var start = baseOffset + offset + size + firstOffset;
        var refs = [];
        for (var i = 0; i < count && rp + 12 <= boxEnd; i++) {
          var word = view.getUint32(rp);
          var refType = word >>> 31;
          var refSize = word & 0x7fffffff;
          var duration = view.getUint32(rp + 4);
          rp += 12;
          if (refType === 0 && refSize > 0) {
            refs.push({ start: start, length: refSize, duration: duration });
          }
          start += refSize;
        }
        return { timescale: timescale, references: refs };
      }

      offset += size;
    }
    return null;
  }

  /* ---------------- 其他工具 ---------------- */

  function sanitizeFilename(name, fallback) {
    var s = String(name == null ? '' : name)
      .replace(/[\u0000-\u001f<>:"/\\|?*\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '');
    if (s.length > 120) s = s.slice(0, 120).trim();
    return s || fallback || 'video';
  }

  function extOf(url) {
    try {
      var path = new URL(url, 'https://x/').pathname;
      var m = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(path);
      return m ? m[1].toLowerCase() : '';
    } catch (e) {
      return '';
    }
  }

  VDH.absoluteUrl = absoluteUrl;
  VDH.joinBase = joinBase;
  VDH.parseAttrs = parseAttrs;
  VDH.parseRange = parseRange;
  VDH.parseDashRange = parseDashRange;
  VDH.fillUrlTemplate = fillUrlTemplate;
  VDH.parseMasterPlaylist = parseMasterPlaylist;
  VDH.parseMediaPlaylist = parseMediaPlaylist;
  VDH.parseMpd = parseMpd;
  VDH.parseSidx = parseSidx;
  VDH.buildDashSegments = buildDashSegments;
  VDH.parseIsoDuration = parseIsoDuration;
  VDH.sanitizeFilename = sanitizeFilename;
  VDH.extOf = extOf;

  global.VDHStream = VDH;
  if (typeof module !== 'undefined' && module.exports) module.exports = VDH;
})(typeof globalThis !== 'undefined' ? globalThis : this);
