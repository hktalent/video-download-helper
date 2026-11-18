# Video Download Helper

浏览器扩展：检测并下载当前页面里的视频与音频，覆盖直链文件、HLS(m3u8)、DASH(mpd) 和 MSE(blob) 流。
Chrome / Edge 与 Firefox 共用同一套代码，打包脚本会分别生成两个发行包。

## 功能

- **媒体检测**
  - `webRequest` 监听页面请求，按 MIME / 扩展名识别直链、HLS、DASH、字幕
  - 直链体积优先取 `Content-Range` 总量（只回 206 的 CDN 也能显示真实大小），并记录是否支持 Range
  - HLS `SAMPLE-AES` / DASH `ContentProtection` 标记为 DRM，弹窗标红并禁用下载
  - 扫描页面 `<video>` / `<audio>`（含 `currentSrc`、`<source>`），并在 `loadedmetadata` / `play` 时刷新
  - 徽标显示当前标签页检测到的条目数；正在合并下载时显示 `↓`
- **HLS 下载**
  - 解析主播放列表：**可选清晰度下拉框**、独立音轨（`EXT-X-MEDIA`）、多语言字幕
  - 分片并发下载 + 6 次指数退避重试 + 单请求 20s 超时，按 `EXT-X-BYTERANGE` / `EXT-X-MAP` 正确拼接（fMP4 与 TS 都支持）
  - 坏分片容忍：单段失败按序号跳过，失败率超过 5% 才中止，完成态会标出「跳过 N 个损坏分片」
  - `EXT-X-KEY: AES-128`（含 `IV` 与按序号推导两种模式）在本机解密
  - 无 `EXT-X-ENDLIST` 的直播列表按目标时长轮询，持续录制新增分片，取消时保存已录部分
- **DASH 下载**
  - `SegmentTemplate`（含 `SegmentTimeline` / `$Number$` / `$Time$` 模板）、`SegmentList`、`SegmentBase`+`sidx` 三种索引方式
  - 单文件 `SegmentBase` 会先读 `sidx`，再按字节范围逐段下载并拼接；无法解析索引时退回整文件下载
  - 视频与音频分开保存，页面提示可用 ffmpeg 合并
- **MSE(blob) 捕获**
  - 在主世界挂钩 `MediaSource.addSourceBuffer` / `SourceBuffer.appendBuffer`，按 mime 分轨累积
  - 仅在用户点击「开始捕获」后落盘，单页上限 900 MB，超限自动停止避免拖垮页面
  - 多 iframe 场景按帧汇总字节数与轨道，不会互相覆盖
- **落盘（OPFS 流式）**
  - 分片边下边写进页面源 OPFS 临时文件，收尾把 `File` 句柄交给浏览器下载，**内存占用恒定**，GB 级视频不再爆内存
  - 环境不支持 OPFS / 配额不足 64MB 时自动退回内存 Blob（行为与旧版一致）
- **下载策略**
  - 直链默认交给浏览器下载器；被防盗链拦截（Referer / Cookie 校验）时自动回退到页面内 `fetch` 保存
  - 「页内下载」开关：强制所有直链走页面上下文下载，原样带上 Cookie / Referer
  - 字幕单独保存为 `.vtt`，不占用主任务进度位

## 目录结构

```
manifest.json         Chrome / Edge 清单（MV3 service worker）
manifest.firefox.json 仅供参考的 Firefox 清单样例（由 tools/build.mjs 生成对应版本）
background.js         后台：请求监听、条目汇总、下载、徽标
content.js            内容脚本：扫描、HLS/DASH 合并下载、清晰度探测、字幕、MSE 桥接
inject.js             主世界脚本：MSE 挂钩
lib/stream.js         HLS / DASH / sidx 解析（可被 node 直接 require 做单测）
popup.html/js/css     弹窗界面
icons/                图标
test/parsers.test.js  解析器单元测试
tools/build.mjs       打包脚本
dist/                 打包产物（chrome.zip / firefox.xpi）
```

## 安装

**Chrome / Edge**

1. `chrome://extensions`（Edge：`edge://extensions`）打开开发者模式
2. 「加载已解压的扩展程序」，选择本目录

**Firefox（≥128）**

1. 先打包：`node tools/build.mjs`
2. 打开 `about:debugging#/runtime/this-firefox`
3. 「临时载入附加组件」，选择 `dist/video-download-helper-firefox.xpi`
4. 长期使用可用 `dist/firefox/` 目录打包签名后安装；Firefox 140+ 已在清单里声明不收集数据

## 开发与校验

```bash
node --test test/parsers.test.js   # 解析器单测
node tools/build.mjs               # 生成两个发行包
npx web-ext lint --source-dir dist/firefox   # Firefox 清单/API 静态检查
```

## 已知限制

- **不支持 DRM（Widevine / PlayReady / 采样级加密）**：会在弹窗里标红并禁用下载，不会白跑一次下载
- HLS 的独立音频轨、DASH 的音频轨仍是单独文件，需要自行用 ffmpeg 合并（容器层合并尚未实现）：
  `ffmpeg -i video.mp4 -i audio.m4a -c copy out.mp4`
- MSE 捕获只能保存播放器**已经加载过**的数据，拖动进度条没看过的部分无法补回
- 直播录制在支持 OPFS 的环境下不受内存上限约束；不支持时会退到内存模式（2GB 上限）
- OPFS 临时文件在下载结束后保留 5 分钟再清理，期间会短暂占用页面源的存储配额
