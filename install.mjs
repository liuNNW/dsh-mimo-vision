#!/usr/bin/env node
/**
 * dsh-mimo-vision 一键安装脚本
 *
 * 用法：在仓库根目录运行
 *   node install.mjs
 *
 * 完成三步：
 *   1. 定位 dsh 安装目录（npm root -g，可用环境变量 DSHSCOPE 覆盖）
 *   2. 拷贝插件包到 node_modules/@deepseek-ai/dsh-mimo-vision（幂等，自动覆盖旧版）
 *   3. 在 profile 组合补丁 cordis.patch.yml 中追加插件行（幂等，已存在则跳过）
 *
 * 装完需要重启 dsh 服务并刷新页面，再在配置卡片里填写 API Key。
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_NAME = '@deepseek-ai/dsh-mimo-vision';
const PKG_SRC = path.join(SCRIPT_DIR, '@deepseek-ai', 'dsh-mimo-vision');
const ROW_ID = 'mimo-vision';
const INSERT_BLOCK = `- insert:
    - id: ${ROW_ID}
      name: '${PKG_NAME}'`;

function log(msg) { console.log(msg); }
function fail(msg) { console.error('\n✖ ' + msg); process.exit(1); }

/** 定位 dsh 的 node_modules/@deepseek-ai 目录（插件包安装目标） */
function findDshScope() {
  if (process.env.DSHSCOPE) {
    if (existsSync(process.env.DSHSCOPE)) return process.env.DSHSCOPE;
    fail('环境变量 DSHSCOPE 指向的目录不存在：' + process.env.DSHSCOPE);
  }
  const candidates = [];
  // 1) npm 全局安装目录：<prefix>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', windowsHide: true }).trim();
    if (root) {
      candidates.push(path.join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'));
      // 老布局：包直接平铺在 <prefix>/node_modules/@deepseek-ai
      candidates.push(path.join(root, '@deepseek-ai'));
    }
  } catch (e) { /* npm 不可用时忽略 */ }
  // 2) 通过 dsh 命令所在位置推断
  try {
    const which = execSync(process.platform === 'win32' ? 'where dsh' : 'which dsh', { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
    if (which) {
      const real = path.resolve(which);
      const marker = path.join('node_modules', '@deepseek-ai', 'dsh');
      const idx = real.toLowerCase().indexOf(marker.toLowerCase());
      if (idx !== -1) {
        const base = real.slice(0, idx + marker.length);
        candidates.push(path.join(base, 'node_modules', '@deepseek-ai'));
      }
    }
  } catch (e) { /* 找不到 dsh 命令时忽略 */ }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0] || null;
}

/** 定位 profile 的组合补丁文件（profiles/web/cordis.patch.yml 优先，其次扫描其它 profile） */
function findPatchFile() {
  const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh');
  const profiles = path.join(dshHome, 'profiles');
  const direct = path.join(profiles, 'web', 'cordis.patch.yml');
  if (existsSync(direct)) return direct;
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) {
      const f = path.join(profiles, name, 'cordis.patch.yml');
      if (existsSync(f)) return f;
    }
  }
  return direct;
}

/** 拷贝插件包到安装目录（幂等） */
function installPackage(scope) {
  if (!existsSync(PKG_SRC)) {
    fail('未找到插件源码目录：' + PKG_SRC + '\n请在仓库根目录运行本脚本（install.mjs 与 @deepseek-ai/ 同级）。');
  }
  const target = path.join(scope, 'dsh-mimo-vision');
  if (existsSync(target)) {
    log('↻ 已存在 ' + PKG_NAME + '，移除旧版本…');
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(scope, { recursive: true });
  cpSync(PKG_SRC, target, { recursive: true });
  log('✔ 插件包已安装：' + target);
}

/** 在组合补丁中追加插件行（幂等） */
function patchComposition(file) {
  const block = INSERT_BLOCK;
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, block + '\n', 'utf8');
    log('✔ 已创建组合补丁：' + file);
    return;
  }
  let text = readFileSync(file, 'utf8');
  if (text.includes(PKG_NAME)) {
    log('ℹ 组合补丁已包含插件行，跳过写入。');
    return;
  }
  const crlf = text.includes('\r\n');
  const finalBlock = crlf ? block.replace(/\n/g, '\r\n') : block;
  const emptyArr = text.match(/^\s*\[\]\s*$/m);
  if (emptyArr) {
    // 空补丁文件（内容仅为 []）→ 用插件行替换空数组，保留其余注释
    text = text.replace(/^\s*\[\]\s*$/m, finalBlock);
  } else {
    // 已有其它补丁条目 → 追加为新顶层条目
    text = text.replace(/\s*$/, '') + '\n' + finalBlock + '\n';
  }
  writeFileSync(file, text, 'utf8');
  log('✔ 已写入组合补丁：' + file);
}

// ---- main ----
log('════════ dsh-mimo-vision 一键安装 ════════');
const scope = findDshScope();
if (!scope || !existsSync(scope)) {
  fail('未找到 dsh 安装目录。\n请确认 dsh 已通过 npm 全局安装，或设置环境变量 DSHSCOPE 指向 dsh 的 node_modules/@deepseek-ai 目录后重试。');
}
log('→ dsh 包目录：' + scope);
installPackage(scope);
const patchFile = findPatchFile();
patchComposition(patchFile);
log('\n✔ 安装完成！接下来：');
log('  1. 重启 dsh 服务（停掉当前进程重新启动）；');
log('  2. 刷新浏览器页面；');
log('  3. 打开 设置 → 插件 → 插件配置 →「MiMo 视觉」，填写 API Key 并点「测试连接」。');
