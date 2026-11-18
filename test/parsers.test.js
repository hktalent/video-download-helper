/*
 * 播放列表解析单元测试（不依赖浏览器环境）：
 *
 *   node --test test/
 *
 * 只覆盖纯解析逻辑，DOMParser 相关的 MPD 解析需要在浏览器里验证。
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const VDH = require('../lib/stream.js');

test('主播放列表：清晰度、独立音轨、字幕', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="cn",LANGUAGE="zh",DEFAULT=YES,URI="audio/cn.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="中文",LANGUAGE="zh",URI="subs/zh.vtt"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"',
    '1080/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720,AUDIO="aud"',
    '720/index.m3u8'
  ].join('\n');

  const master = VDH.parseMasterPlaylist(text, 'https://cdn.example.com/media/master.m3u8');

  assert.equal(master.variants.length, 2);
  assert.equal(master.variants[0].bandwidth, 2800000);
  assert.deepEqual(master.variants[0].resolution, { width: 1920, height: 1080 });
  assert.equal(master.variants[0].url, 'https://cdn.example.com/media/1080/index.m3u8');
  assert.equal(master.variants[0].audioGroup, 'aud');

  assert.equal(master.media.audio.length, 1);
  assert.equal(master.media.audio[0].isDefault, true);
  assert.equal(master.media.audio[0].url, 'https://cdn.example.com/media/audio/cn.m3u8');

  assert.equal(master.media.subtitles.length, 1);
  assert.equal(master.media.subtitles[0].lang, 'zh');
});

test('媒体播放列表：分片、时长、序号与 ENDLIST', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:10',
    '#EXTINF:5.0,',
    'seg-10.ts',
    '#EXTINF:4.5,',
    'seg-11.ts',
    '#EXT-X-ENDLIST'
  ].join('\n');

  const playlist = VDH.parseMediaPlaylist(text, 'https://cdn.example.com/hls/playlist.m3u8');

  assert.equal(playlist.segments.length, 2);
  assert.equal(playlist.endList, true);
  assert.equal(playlist.targetDuration, 6);
  assert.equal(playlist.segments[0].seq, 10);
  assert.equal(playlist.segments[1].seq, 11);
  assert.equal(playlist.segments[0].duration, 5);
  assert.equal(playlist.segments[1].url, 'https://cdn.example.com/hls/seg-11.ts');
});

test('媒体播放列表：EXT-X-MAP、BYTERANGE 与 AES-128 密钥', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x000102030405060708090a0b0c0d0e0f',
    '#EXTINF:2,',
    '#EXT-X-BYTERANGE:1000@720',
    'media.mp4',
    '#EXTINF:2,',
    '#EXT-X-BYTERANGE:900',
    'media.mp4',
    '#EXT-X-ENDLIST'
  ].join('\n');

  const playlist = VDH.parseMediaPlaylist(text, 'https://cdn.example.com/x/playlist.m3u8');

  assert.equal(playlist.init.url, 'https://cdn.example.com/x/init.mp4');
  assert.deepEqual(playlist.init.range, { length: 720, start: 0 });
  assert.equal(playlist.segments[0].range.start, 720);
  assert.equal(playlist.segments[0].range.length, 1000);
  // 省略起点的 BYTERANGE 紧接上一个分片的结束位置
  assert.equal(playlist.segments[1].range.start, 1720);
  assert.equal(playlist.segments[0].key.method, 'AES-128');
  assert.equal(playlist.segments[0].key.url, 'https://cdn.example.com/x/key.bin');
});

test('媒体播放列表：跳过 GAP 分片但不打乱序号', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-MEDIA-SEQUENCE:1',
    '#EXTINF:4,',
    'a.ts',
    '#EXTINF:4,',
    '#EXT-X-GAP',
    'b.ts',
    '#EXT-X-ENDLIST'
  ].join('\n');

  const playlist = VDH.parseMediaPlaylist(text, 'https://e.com/p.m3u8');

  assert.equal(playlist.segments.length, 1);
  assert.equal(playlist.segments[0].url, 'https://e.com/a.ts');
  assert.equal(playlist.segments[0].seq, 1);
});

test('工具函数：字节范围 / ISO 时长 / 文件名清洗', () => {
  assert.deepEqual(VDH.parseRange('100@20'), { length: 100, start: 20 });
  assert.deepEqual(VDH.parseDashRange('10-19'), { start: 10, length: 10 });
  assert.equal(VDH.parseIsoDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(VDH.parseIsoDuration('P1DT1S'), 86401);
  assert.equal(VDH.sanitizeFilename('a/b:c*?.mp4', 'video'), 'a b c .mp4');
  assert.equal(VDH.sanitizeFilename('', 'video'), 'video');
  assert.equal(VDH.extOf('https://x.com/a/b.MP4?x=1'), 'mp4');
});

test('DASH SegmentTemplate 变量替换（$Number$ / $Time$ / 补零）', () => {
  const vars = { id: 'v1', bandwidth: 900000, number: 7, time: 1234 };

  assert.equal(VDH.fillUrlTemplate('seg-$Number%05d$.m4s', vars), 'seg-00007.m4s');
  assert.equal(VDH.fillUrlTemplate('$RepresentationID$/seg-$Time$.m4s', vars), 'v1/seg-1234.m4s');
  assert.equal(VDH.fillUrlTemplate('$Bandwidth$/init.mp4', vars), '900000/init.mp4');
  // 未知变量原样保留，避免生成错误地址
  assert.equal(VDH.fillUrlTemplate('$Unknown$.m4s', vars), '$Unknown$.m4s');
  assert.equal(VDH.fillUrlTemplate('price$$.m4s', vars), 'price$.m4s');
});
