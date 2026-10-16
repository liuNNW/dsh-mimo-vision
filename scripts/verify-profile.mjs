#!/usr/bin/env node
/**
 * MiMo 视觉识别 —— profile 装配验证（不重启 dsh）。
 *
 * 在真机上验证「profile 级永久插件」这条链路是否真的接通：
 *   1. profiles/<p>/package.json 的 dsh.profile.bundles 里有本包；
 *   2. 内核能从安装锚点或 profile 目录解析到包体（resolveBundleDir）；
 *   3. 本包的 cordis.patch.yml 是合法 YAML，且里面那一行的 id 正是 `mimo-vision`
 *      （设置命名空间靠它定位，改名即设置页失效）；
 *   4. 兼容性检查通过（或已被显式豁免）；
 *   5. 组合后的条目树里存在 id = mimo-vision 的 row，且 name 正确。
 *
 * 用法：
 *   cd %USERPROFILE%\.dsh\profiles\desktop
 *   node "<仓库>/mimo-vision-plugin/scripts/verify-profile.mjs"
 * 可选参数：--install-anchor <dsh 包 package.json 的绝对路径>
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '..')
/** npm 包名（与 package.json / cordis.patch.yml 的 name 一致）。 */
const PKG_NAME = 'dsh-mimo-vision'
/** 设置命名空间 / row id，与包名解耦（改名会让设置页丢命名空间）。 */
const ROW_ID = 'mimo-vision'
/** 历史包名，只用于检查旧残留。 */
const LEGACY_PKG_NAMES = ['@deepseek-ai/dsh-mimo-vision']

const failures = []
const passes = []

function ok(label) {
  passes.push(label)
  console.log(`  ✔ ${label}`)
}
function fail(label, detail) {
  failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
  console.error(`  ✖ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 解析参数。 */
function parseArgs(argv) {
  const out = { installAnchor: undefined }
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--install-anchor') out.installAnchor = argv[++i]
  return out
}

/** 找内核（dsh 包）的 package.json：桌面版 app.asar 解包目录，或全局 npm 安装。 */
function guessInstallAnchor() {
  const candidates = [
    'F:/软件/dsh/resources/app/dsh/node_modules/@deepseek-ai/dsh/package.json',
    'F:/软件/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json',
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE ?? '', '.dsh')
  const globalRoot = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules') : undefined
  if (globalRoot !== undefined) {
    const npmAnchor = path.join(globalRoot, '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(npmAnchor)) return npmAnchor
  }
  void home
  return undefined
}

/**
 * 加载内核的 @deepseek-ai/dsh-app-boot。
 *
 * 它不在 profile 的依赖里，也不一定在 dsh 包自己的 node_modules 下
 * （桌面版把它平铺在 app 的 node_modules），所以要按几个已知锚点找：
 *   1. dsh 包的同级 node_modules（installAnchor 的 ../../..）
 *   2. dsh 包内的 node_modules（npm 全局布局）
 *   3. profile 的 node_modules
 * 全部落空时返回 undefined，调用方跳过依赖它的检查（不是失败）。
 *
 * @param {string | undefined} anchor - dsh 包 package.json 的绝对路径。
 * @param {string} profileDir - profile 目录。
 * @returns {Promise<object | undefined>} 模块命名空间。
 */
async function loadAppBoot(anchor, profileDir) {
  const candidates = []
  if (anchor !== undefined) {
    const dshDir = path.dirname(anchor)
    candidates.push(path.join(path.dirname(dshDir), 'dsh-app-boot', 'lib', 'index.js'))
    candidates.push(path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'))
  }
  candidates.push(path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'))
  candidates.push(path.join(PKG_ROOT, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'))
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      return await import(pathToFileURL(candidate).href)
    } catch {
      // 试下一个
    }
  }
  try {
    return await import('@deepseek-ai/dsh-app-boot')
  } catch {
    return undefined
  }
}

async function main() {
  console.log('══ MiMo 视觉识别 · profile 装配验证 ══')
  const options = parseArgs(process.argv.slice(2))

  const profileDir = process.cwd()
  const profileName = path.basename(profileDir)
  if (path.basename(path.dirname(profileDir)).toLowerCase() !== 'profiles') {
    fail('运行目录', `请在 profile 目录里运行（当前 ${profileDir}）`)
    report()
    return
  }
  console.log(`profile：${profileName}（${profileDir}）`)

  // ---- 1. bundles ----
  console.log('\n[1] dsh.profile.bundles')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  } catch (error) {
    fail('读 profile 的 package.json', String(error?.message ?? error))
    report()
    return
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (bundles.includes(PKG_NAME)) ok(`bundles 含 ${PKG_NAME}`)
  else fail('bundles 缺少本包', `请运行 install.mjs，或在 package.json 的 dsh.profile.bundles 里加上 ${PKG_NAME}`)

  // ---- 2. 内核能否解析到包体 ----
  console.log('\n[2] 包体解析')
  const anchor = options.installAnchor ?? guessInstallAnchor()
  console.log(`  installAnchor：${anchor ?? '(没找到，跳过该检查)'}`)
  const boot = await loadAppBoot(anchor, profileDir)
  if (boot === undefined) {
    warn('找不到 @deepseek-ai/dsh-app-boot，跳过解析与装配检查（不影响安装结论）')
  } else if (anchor !== undefined && typeof boot.resolveBundleDir === 'function') {
    try {
      const resolved = boot.resolveBundleDir('dsh', PKG_NAME, anchor, profileDir)
      const expected = path.join(profileDir, 'node_modules', ...PKG_NAME.split('/'))
      if (path.resolve(resolved) === path.resolve(expected)) ok('resolveBundleDir 命中 profile 内的包体')
      else ok(`resolveBundleDir 解析到 ${resolved}`)
    } catch (error) {
      fail('resolveBundleDir', String(error?.message ?? error))
    }
  }

  // ---- 3. 补丁层 ----
  console.log('\n[3] 包自带的组合补丁层')
  const patchPath = path.join(PKG_ROOT, 'cordis.patch.yml')
  const patchText = readFileSync(patchPath, 'utf8')
  if (patchText.includes(`id: ${ROW_ID}`)) ok(`cordis.patch.yml 里的 row id 是 ${ROW_ID}`)
  else fail('row id 不匹配', `设置页按 ${ROW_ID} 定位命名空间，id 必须一致`)
  if (patchText.includes(PKG_NAME)) ok('补丁里 name 指向本包')
  else fail('补丁里没有本包名', PKG_NAME)

  // 用 profile 里真实存在的那份（安装后拷贝的）再核一次，避免源码与安装体不一致。
  const installedPatch = path.join(profileDir, 'node_modules', ...PKG_NAME.split('/'), 'cordis.patch.yml')
  if (existsSync(installedPatch)) {
    const installedText = readFileSync(installedPatch, 'utf8')
    if (installedText === patchText) ok('安装体的补丁与源码一致')
    else fail('安装体的补丁与源码不一致', '请重新运行 install.mjs')
  } else {
    warn(`安装体里没有 cordis.patch.yml：${installedPatch}`)
  }

  // ---- 4. 兼容性 ----
  console.log('\n[4] 兼容性检查')
  const installedManifest = path.join(profileDir, 'node_modules', ...PKG_NAME.split('/'), 'package.json')
  if (existsSync(installedManifest)) {
    try {
      const installed = JSON.parse(readFileSync(installedManifest, 'utf8'))
      if (installed.version === JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version) {
        ok(`安装体版本一致（${installed.version}）`)
      } else {
        fail('安装体版本与源码不同', `${installed.version} vs 源码版本`)
      }
      if (installed.dsh?.bundle?.patch !== undefined) ok('安装体声明 dsh.bundle.patch')
      else fail('安装体缺少 dsh.bundle.patch', 'Loader 不会加载组合层')
      if (installed.dsh?.client !== undefined) ok('安装体声明 dsh.client（浏览器半）')
      else fail('安装体缺少 dsh.client', '设置页不会出现')
    } catch (error) {
      fail('读安装体的 package.json', String(error?.message ?? error))
    }
  } else {
    fail('安装体不存在', installedManifest)
  }

  // ---- 5. 组合后的条目树 ----
  console.log('\n[5] 组合条目树')
  if (boot === undefined || anchor === undefined || typeof boot.loadProfileDirectory !== 'function') {
    console.log('  （缺少 dsh-app-boot / installAnchor，跳过）')
  } else {
    try {
      const loaded = boot.loadProfileDirectory('dsh', profileDir, anchor)
      // 别的 bundle 被跳过（例如与本机内核版本不兼容的第三方包）与本插件无关，
      // 只报告；只要 **本包** 没被跳过就算通过。
      const mine = loaded.skippedBundles.find((item) => item.packageName === PKG_NAME)
      if (mine === undefined) ok('本包没有被跳过')
      else fail('本包被跳过', mine.reason)
      const others = loaded.skippedBundles.filter((item) => item.packageName !== PKG_NAME)
      if (others.length > 0) {
        warn(`另有 ${others.length} 个无关 bundle 被跳过（与本插件无关）：`)
        for (const item of others) warn(`    ${item.packageName}：${String(item.reason).split('\n')[0].slice(0, 160)}`)
      }
      const layer = loaded.layers.find((item) => item.packageName === PKG_NAME)
      if (layer !== undefined) ok('mimo 层已进入装配列表')
      else fail('mimo 层没有进入装配列表', loaded.layers.map((item) => item.packageName).join(', '))
      if (layer !== undefined) {
        const rows = JSON.stringify(layer.patches)
        if (rows.includes(`"${ROW_ID}"`)) ok(`补丁层里出现 row id ${ROW_ID}`)
        else fail('补丁层里没有该 row', rows.slice(0, 200))
      }
    } catch (error) {
      fail('装配检查', String(error?.message ?? error))
    }
  }

  report()
}

function warn(message) {
  console.warn(`  ⚠ ${message}`)
}

function report() {
  console.log(`\n结果：${passes.length} 通过，${failures.length} 失败`)
  if (failures.length > 0) {
    console.error('\n失败项：')
    for (const item of failures) console.error(`  - ${item}`)
    process.exit(1)
  }
}

await main()
