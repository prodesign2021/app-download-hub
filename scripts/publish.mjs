#!/usr/bin/env node
/**
 * 一键发布自托管应用安装包到 GitHub Releases，并同步 data/apps.json。
 *
 * 用法：
 *   node scripts/publish.mjs --app harness-demo --version 0.1.0 \
 *     --file dist/harness-demo.windows.zip --file dist/harness-demo.macos.zip \
 *     [--notes "更新说明"] [--commit] [--dry-run]
 *
 * 依赖：已登录的 gh CLI（gh auth login），git。
 * 说明：外部应用（microsoft/vscode 等）不需要跑这个脚本，站点会通过 GitHub API
 *       自动解析它们的 latest release 资产。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'apps.json');
const DEFAULT_BRANCH = 'main';

const HELP = `
发布自托管安装包到 GitHub Releases 并更新站点清单

  node scripts/publish.mjs --app <应用 id> --version <x.y.z> --file <安装包> [--file ...]
                           [--notes "更新说明"] [--commit] [--dry-run]

参数
  --app       data/apps.json 里的应用 id（必需）
  --version   语义化版本号，例如 0.1.0（必需，会打 v0.1.0 的 tag）
  --file      要上传的安装包，可重复传多个（必需）
  --notes     版本说明，默认自动生成
  --commit    发布后自动 commit + push data/apps.json
  --dry-run   只打印将要执行的命令，不真正创建 release
  -h, --help  显示本帮助
`.trim();

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { files: [], notes: '', commit: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => (i += 1, argv[i]);
    switch (key) {
      case '--app': args.app = next(); break;
      case '--version': args.version = next(); break;
      case '--file': args.files.push(next()); break;
      case '--notes': args.notes = next(); break;
      case '--commit': args.commit = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '-h':
      case '--help': console.log(HELP); process.exit(0); break;
      default: fail(`未知参数：${key}\n\n${HELP}`);
    }
  }
  return args;
}

function run(cmd, cmdArgs, { silent = false } = {}) {
  const rendered = `${cmd} ${cmdArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  if (!silent) console.log(`  $ ${rendered}`);
  return execFileSync(cmd, cmdArgs, {
    encoding: 'utf8',
    stdio: silent ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
}

function tryRun(cmd, cmdArgs) {
  try {
    return run(cmd, cmdArgs, { silent: true });
  } catch {
    return null;
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.app) fail('缺少 --app（应用 id）');
  if (!args.version) fail('缺少 --version（例如 0.1.0）');
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(args.version)) {
    fail(`版本号不合法：${args.version}，请使用 x.y.z 形式`);
  }
  if (!args.files.length) fail('至少需要传一个 --file 安装包');

  if (!existsSync(DATA_FILE)) fail(`找不到清单文件：${DATA_FILE}`);
  const catalog = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  const app = (catalog.apps || []).find((item) => item.id === args.app);
  if (!app) {
    fail(`清单里没有 id 为 "${args.app}" 的应用，现有 id：${catalog.apps.map((a) => a.id).join(', ')}`);
  }

  const repo = app.repo;
  if (!repo || !repo.includes('/')) fail(`应用 ${app.id} 的 repo 字段不合法的：${repo}`);

  for (const file of args.files) {
    if (!existsSync(file)) fail(`安装包不存在：${file}`);
  }

  const auth = tryRun('gh', ['auth', 'status']);
  if (auth === null) fail('gh 未登录，请先执行：gh auth login');

  const tag = `v${args.version}`;
  const title = `${app.name} ${tag}`;
  const notes = args.notes || `${app.name} ${tag}\n\n- 发布新版本 ${args.version}`;

  console.log(`\n▸ 目标仓库：${repo}`);
  console.log(`▸ 应用：${app.name}（${app.id}）`);
  console.log(`▸ 版本：${tag}`);
  console.log(`▸ 文件：${args.files.map((f) => path.basename(f)).join(', ')}\n`);

  if (args.dryRun) {
    console.log('（dry-run，以下命令未执行）');
    run('gh', ['release', 'create', tag, '-R', repo, '--title', title, '--notes', notes]);
    run('gh', ['release', 'upload', tag, ...args.files, '-R', repo, '--clobber']);
    console.log('\n✓ dry-run 完成');
    return;
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'apphub-publish-'));
  const notesFile = path.join(tmpDir, 'notes.md');
  writeFileSync(notesFile, `${notes}\n`, 'utf8');

  try {
    const existing = tryRun('gh', ['release', 'view', tag, '-R', repo]);
    if (existing === null) {
      console.log('▸ 创建 release…');
      run('gh', ['release', 'create', tag, '-R', repo, '--title', title, '--notes-file', notesFile]);
    } else {
      console.log('▸ release 已存在，直接覆盖上传…');
    }

    console.log('▸ 上传安装包…');
    run('gh', ['release', 'upload', tag, ...args.files, '-R', repo, '--clobber']);

    const raw = run('gh', ['api', `repos/${repo}/releases/tags/${tag}`]);
    const release = JSON.parse(raw);
    const assets = release.assets || [];

    console.log('\n▸ 发布结果：');
    for (const asset of assets) {
      const size = (asset.size / 1024 / 1024).toFixed(2);
      console.log(`   ✓ ${asset.name}  (${size} MB)`);
    }

    // 校验清单里的 match 正则是否都能命中真实资产，提前发现配置漂移
    console.log('\n▸ 清单匹配校验：');
    let missing = 0;
    for (const download of app.downloads || []) {
      let hit = null;
      try {
        const pattern = new RegExp(download.match);
        hit = assets.find((asset) => pattern.test(asset.name));
      } catch {
        hit = null;
      }
      if (hit) {
        console.log(`   ✓ ${download.label} → ${hit.name}`);
      } else {
        missing += 1;
        console.log(`   ⚠ ${download.label} 未匹配到资产（match: ${download.match}）`);
      }
    }
    if (missing) {
      console.log(`   ${missing} 个下载项没命中，站点上会回退到「发布页」链接。`);
    }

    // 同步清单里的版本信息
    const updated = todayISO();
    app.version = args.version;
    app.updated = updated;
    catalog.updated = updated;
    const downloadUrl = release.html_url;
    app.releaseUrl = downloadUrl;
    writeFileSync(DATA_FILE, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    console.log(`\n▸ 已更新 data/apps.json（${app.id} → ${tag}）`);

    if (args.commit) {
      console.log('\n▸ 提交并推送清单变更…');
      run('git', ['add', 'data/apps.json']);
      run('git', ['commit', '-m', `chore(release): ${app.name} ${tag}`]);
      run('git', ['push', 'origin', DEFAULT_BRANCH]);
      console.log('▸ 已推送，GitHub Pages 会自动重新部署。');
    } else {
      console.log('\n▸ 清单已更新但未提交，确认无误后：git add data/apps.json && git commit && git push');
    }

    console.log(`\n✓ 发布完成：${downloadUrl}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
