/*
 * 打包脚本：一次生成 Chrome 与 Firefox 两个发行包。
 *
 *   node tools/build.mjs
 *
 * Chrome 包 → dist/video-download-helper-chrome.zip
 * Firefox 包 → dist/video-download-helper-firefox.xpi
 *
 * 两个包只有后台声明与 gecko 标识不同，其余文件完全共用，
 * 避免维护两份代码后在两边行为不一致。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const INCLUDE = ['manifest.json', 'background.js', 'content.js', 'inject.js', 'popup.html', 'popup.js', 'popup.css', 'lib', 'icons'];

const GECKO_ID = 'video-download-helper@51pwn.local';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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

function toFirefoxManifest(base) {
  const manifest = JSON.parse(JSON.stringify(base));

  delete manifest.minimum_chrome_version;
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
  execFileSync('zip', ['-qr', output, '.'], { cwd: from, stdio: 'inherit' });
}

function main() {
  fs.mkdirSync(DIST, { recursive: true });

  // 1. Chrome
  const chromeDir = path.join(DIST, 'chrome');
  copyTree(chromeDir);
  const chromeZip = path.join(DIST, 'video-download-helper-chrome.zip');
  fs.rmSync(chromeZip, { force: true });
  zip(chromeDir, chromeZip);

  // 2. Firefox
  const firefoxDir = path.join(DIST, 'firefox');
  copyTree(firefoxDir);
  const base = readJson(path.join(ROOT, 'manifest.json'));
  fs.writeFileSync(
    path.join(firefoxDir, 'manifest.json'),
    JSON.stringify(toFirefoxManifest(base), null, 2) + '\n'
  );
  const firefoxZip = path.join(DIST, 'video-download-helper-firefox.xpi');
  fs.rmSync(firefoxZip, { force: true });
  zip(firefoxDir, firefoxZip);

  console.log('Chrome  →', chromeZip);
  console.log('Firefox →', firefoxZip);
}

main();
