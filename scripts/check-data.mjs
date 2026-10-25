#!/usr/bin/env node
/**
 * 校验 data/apps.json 的结构：id 唯一、平台合法、repo 格式正确、match 正则可编译。
 * 在 CI 和本地 npm run check 中执行，避免坏数据把站点搞挂。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const DATA_FILE = path.resolve(import.meta.dirname, '..', 'data', 'apps.json');
const PLATFORMS = new Set(['windows', 'macos', 'linux', 'android']);

const errors = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

let catalog;
try {
  catalog = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
} catch (error) {
  console.error(`✗ data/apps.json 不是合法 JSON：${error.message}`);
  process.exit(1);
}

check(typeof catalog.owner === 'string' && catalog.owner.length > 0, '缺少 owner');
check(typeof catalog.repo === 'string' && catalog.repo.length > 0, '缺少 repo');
check(Array.isArray(catalog.apps) && catalog.apps.length > 0, 'apps 必须是非空数组');

const ids = new Set();
const seenPlatforms = new Set();

for (const [index, app] of (catalog.apps || []).entries()) {
  const where = `apps[${index}]${app?.id ? ` (${app.id})` : ''}`;

  check(typeof app?.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(app.id || ''),
    `${where}: id 必须是 kebab-case`);
  check(!ids.has(app?.id), `${where}: id 重复`);
  ids.add(app?.id);

  check(typeof app?.name === 'string' && app.name.length > 0, `${where}: 缺少 name`);
  check(typeof app?.tagline === 'string' && app.tagline.length > 0, `${where}: 缺少 tagline`);
  check(typeof app?.description === 'string' && app.description.length > 0, `${where}: 缺少 description`);
  check(/^[\w.-]+\/[\w.-]+$/.test(app?.repo || ''), `${where}: repo 必须形如 owner/name`);
  check(Array.isArray(app?.downloads) && app.downloads.length > 0, `${where}: downloads 不能为空`);

  for (const [di, download] of (app?.downloads || []).entries()) {
    const label = `${where}: downloads[${di}]`;
    check(PLATFORMS.has(download?.platform), `${label}: platform 非法（${download?.platform}）`);
    check(typeof download?.label === 'string' && download.label.length > 0, `${label}: 缺少 label`);
    seenPlatforms.add(download?.platform);

    if (!download?.match && !download?.asset) {
      errors.push(`${label}: 至少需要 match 或 asset 之一`);
    }
    if (download?.match) {
      try {
        new RegExp(download.match);
      } catch {
        errors.push(`${label}: match 不是合法正则（${download.match}）`);
      }
    }
  }
}

if (errors.length) {
  console.error('✗ data/apps.json 校验失败：');
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(`✓ data/apps.json 校验通过：${catalog.apps.length} 个应用，平台 ${[...seenPlatforms].join(' / ')}`);
