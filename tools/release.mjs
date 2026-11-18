/*
 * 一键发版：改版本号 → 跑单测 → 提交 → 打 tag →（可选）推送。
 *
 *   node tools/release.mjs patch          # 1.0.0 → 1.0.1
 *   node tools/release.mjs minor --push   # 1.0.1 → 1.1.0，并推送到 hktalent 仓库
 *   node tools/release.mjs 1.2.3 --push   # 指定版本号
 *
 * 推送 tag 后，GitHub Actions 的 Release 工作流会自动打包 Chrome zip / Firefox xpi
 * 并创建对应的 GitHub Release。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'manifest.json');
const PACKAGE = path.join(ROOT, 'package.json');
const SEMVER = /^\d+\.\d+\.\d+$/;

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options }).trim();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeVersion(file, version) {
  const data = readJson(file);
  data.version = version;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function bump(current, mode) {
  if (SEMVER.test(mode)) return mode;
  const parts = current.split('.').map(Number);
  if (mode === 'major') return `${parts[0] + 1}.0.0`;
  if (mode === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
  if (mode === 'patch') return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  throw new Error(`未知的版本参数：${mode}（可用 patch / minor / major / x.y.z）`);
}

function main() {
  const argv = process.argv.slice(2);
  const mode = argv.find((a) => !a.startsWith('--'));
  const push = argv.includes('--push');
  const dryRun = argv.includes('--dry-run');

  if (!mode) throw new Error('用法：node tools/release.mjs <patch|minor|major|x.y.z> [--push] [--dry-run]');

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main' && push) throw new Error(`当前分支为 ${branch}，发版请先切到 main`);

  const current = readJson(MANIFEST).version;
  const next = bump(current, mode);
  const tag = 'v' + next;

  const remote = git(['remote', 'get-url', 'origin']);
  if (!remote.includes('hktalent')) throw new Error(`origin 不是 hktalent 仓库：${remote}`);

  console.log(`版本：${current} → ${next}（tag ${tag}）`);
  if (dryRun) {
    console.log('dry-run，未做任何改动');
    return;
  }

  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw new Error('工作区有未提交的改动，请先提交或 stash：\n' + dirty);

  if (git(['tag', '-l', tag])) throw new Error(`tag ${tag} 已存在`);

  writeVersion(MANIFEST, next);
  writeVersion(PACKAGE, next);

  console.log('运行单测…');
  execFileSync('node', ['--test', 'test/parsers.test.js'], { cwd: ROOT, stdio: 'inherit' });

  git(['add', 'manifest.json', 'package.json']);
  git(['commit', '-m', `chore(release): ${tag}`]);
  git(['tag', '-a', tag, '-m', `Video Download Helper ${tag}`]);
  console.log(`已提交并打 tag ${tag}`);

  if (push) {
    git(['push', 'origin', 'HEAD:main'], { stdio: 'inherit' });
    git(['push', 'origin', tag], { stdio: 'inherit' });
    console.log(`已推送 ${tag}，Release 工作流将自动打包发布`);
  } else {
    console.log(`如需发布：git push origin HEAD:main && git push origin ${tag}`);
  }
}

main();
