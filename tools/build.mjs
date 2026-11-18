/*
 * 打包脚本：一次生成 Chrome 与 Firefox 两个发行包（hktalent 专属构建）。
 *
 *   node tools/build.mjs                       # 常规打包
 *   node tools/build.mjs --expect-version 1.2.3  # 校验版本号（CI 发布时用）
 *
 * Chrome 包 → dist/video-download-helper-chrome.zip
 * Firefox 包 → dist/video-download-helper-firefox.xpi
 *
 * 两个包只有清单差异（后台声明 / gecko 标识 / 作者字段）不同，其余文件完全共用，
 * 避免维护两份代码后在两边行为不一致。
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const INCLUDE = ['manifest.json', 'background.js', 'content.js', 'inject.js', 'popup.html', 'popup.js', 'popup.css', 'lib', 'icons'];

// 与 hktalent/video-download-helper 仓库绑定的固定附加组件 ID，
// 一旦在 Firefox 上安装过就不应再改，否则会被视为另一个扩展。
const GECKO_ID = 'video-download-helper@hktalent.github.io';
const AUTHOR = 'hktalent';
const HOMEPAGE = 'https://github.com/hktalent/video-download-helper';
const SEMVER = /^\d+\.\d+\.\d+$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
  const args = { expectVersion: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--expect-version') {
      args.expectVersion = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function copyTree(target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const entry of INCLUDE) {
    const src = path.join(ROOT, entry);
    if (!fs.existsSync(src)) throw new Error('缺少文件：' + entry);
    fs.cpSync(src, path.join(target, entry), { recursive: true });
  }
}

function toChromeManifest(base) {
  const manifest = JSON.parse(JSON.stringify(base));
  // author 是 Firefox 字段，Chrome 会报未识别键
  delete manifest.author;
  return manifest;
}

function toFirefoxManifest(base) {
  const manifest = JSON.parse(JSON.stringify(base));

  delete manifest.minimum_chrome_version;
  // developer 是 Chrome 方言，Firefox 走 author 字段
  delete manifest.developer;
  manifest.author = AUTHOR;
  // Firefox 的 MV3 事件页用 background.scripts，不支持 service_worker 字段
  manifest.background = { scripts: ['background.js'] };
  manifest.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: '128.0',
      // Firefox 140+ 上架/签名需要显式声明数据收集范围
      data_collection_permissions: { required: ['none'] }
    }
  };
  return manifest;
}

function zip(from, output) {
  // -X 去掉额外属性，配合固定时区让两次打包结果尽量一致
  execFileSync('zip', ['-qrX', output, '.'], {
    cwd: from,
    stdio: 'inherit',
    env: { ...process.env, TZ: 'UTC' }
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const { expectVersion } = parseArgs(process.argv.slice(2));
  const base = readJson(path.join(ROOT, 'manifest.json'));
  const version = base.version;

  if (!SEMVER.test(version)) throw new Error(`版本号格式非法：${version}`);
  if (expectVersion && expectVersion.replace(/^v/, '') !== version) {
    throw new Error(`版本号不一致：清单为 ${version}，期望 ${expectVersion}`);
  }

  fs.mkdirSync(DIST, { recursive: true });

  // 1. Chrome / Edge
  const chromeDir = path.join(DIST, 'chrome');
  copyTree(chromeDir);
  fs.writeFileSync(path.join(chromeDir, 'manifest.json'), JSON.stringify(toChromeManifest(base), null, 2) + '\n');
  const chromeZip = path.join(DIST, 'video-download-helper-chrome.zip');
  fs.rmSync(chromeZip, { force: true });
  zip(chromeDir, chromeZip);

  // 2. Firefox
  const firefoxDir = path.join(DIST, 'firefox');
  copyTree(firefoxDir);
  fs.writeFileSync(path.join(firefoxDir, 'manifest.json'), JSON.stringify(toFirefoxManifest(base), null, 2) + '\n');
  const firefoxZip = path.join(DIST, 'video-download-helper-firefox.xpi');
  fs.rmSync(firefoxZip, { force: true });
  zip(firefoxDir, firefoxZip);

  console.log(`\n构建完成 v${version}（${AUTHOR} / ${HOMEPAGE}）`);
  console.log('Chrome  →', path.relative(ROOT, chromeZip), `${sha256(chromeZip).slice(0, 16)}…`);
  console.log('Firefox →', path.relative(ROOT, firefoxZip), `${sha256(firefoxZip).slice(0, 16)}…`);
}

main();
