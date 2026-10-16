#!/usr/bin/env node
/**
 * dsh-mimo-vision 一键安装（profile 级永久插件）
 *
 * 用法：
 *   node install.mjs                  # 自动挑 profile（默认 desktop）
 *   node install.mjs --profile web    # 指定 profile
 *   node install.mjs --no-cli         # 跳过 dsh plugin，直接用文件系统兜底
 *
 * 为什么不再是「拷进内核 node_modules」：
 *   0.1.x 把包拷贝到 <dsh>/node_modules/@deepseek-ai/ 下并在 profile 补丁里插一行。
 *   那条路在升级 dsh（npm i -g / 桌面版自动更新）时会被整棵树替换掉，插件随之消失，
 *   而且它借用的是内核自己的依赖解析，任何一次内核依赖变动都会连带打挂启动。
 *   现在的正确形态是 **profile 级插件**：
 *
 *     profiles/<profile>/package.json        dsh.profile.bundles 里加包名
 *     profiles/<profile>/node_modules/<pkg>  包体（pnpm 安装；这里用 file: 本地路径）
 *     包根/cordis.patch.yml                  本包自带的组合补丁层（- insert 一行）
 *     包根/package.json                      dsh.bundle.patch + dsh.client（浏览器半）
 *
 *   装一次进入 bundles，之后每次启动自动加载；升级内核不影响它。
 *
 * 两条安装路径：
 *   A. `dsh plugin --profile <p> add <包名>` —— 官方路径，会走 pnpm 与
 *      兼容性检查（推荐，已发布到 npm 时用这条）。
 *   B. 文件系统兜底：把包体拷进 profile 的 node_modules、把包名写进 bundles、
 *      并保证补丁里有对应 row。适合没有 CLI 或离线环境。
 *
 * 幂等：重复执行安全；旧版本残留（内核目录里的拷贝）会被提示清理。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
/** npm 包名。必须与 package.json 的 name、cordis.patch.yml 的 name 一致。 */
const PKG_NAME = 'dsh-mimo-vision'
/** 设置命名空间 / row id。与包名解耦：改名会连设置页一起丢，所以它跟着历史走。 */
const ROW_ID = 'mimo-vision'
/** 历史包名（0.1.x 用过的官方 scope 名），只用于识别旧残留。 */
const LEGACY_PKG_NAMES = ['@deepseek-ai/dsh-mimo-vision']
const LEGACY_INSTALL_MARKERS = [
  ...LEGACY_PKG_NAMES.flatMap((name) => [
    path.join('node_modules', '@deepseek-ai', 'dsh', 'node_modules', ...name.split('/')),
    path.join('node_modules', ...name.split('/')),
  ]),
  path.join('node_modules', 'dsh-mimo-vision'),
]

function log(message) {
  console.log(message)
}
function warn(message) {
  console.warn('⚠ ' + message)
}
function fail(message) {
  console.error('\n✖ ' + message)
  process.exit(1)
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const options = { profile: undefined, useCli: true, acceptRisk: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile' || arg === '-p') options.profile = argv[++index]
    else if (arg === '--no-cli') options.useCli = false
    else if (arg === '--accept-risk') options.acceptRisk = true
    else if (arg === '--help' || arg === '-h') {
      log('用法：node install.mjs [--profile desktop|web] [--no-cli] [--accept-risk]')
      process.exit(0)
    } else warn(`忽略未知参数：${arg}`)
  }
  return options
}

/** DSH 家目录。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh')
}

/**
 * 选 profile：
 *   1) --profile
 *   2) DSH_PROFILE 环境变量
 *   3) 从运行中的 DSH 进程命令行里抓（…\.dsh\profiles\<name>…）
 *   4) desktop（本机桌面版常用），再退到唯一存在的 profile
 */
function resolveProfile(requested) {
  if (requested) return requested
  if (process.env.DSH_PROFILE) return process.env.DSH_PROFILE
  const fromProcess = profileFromRunningProcess()
  if (fromProcess) return fromProcess
  const profilesDir = path.join(dshHome(), 'profiles')
  if (existsSync(path.join(profilesDir, 'desktop'))) return 'desktop'
  if (existsSync(path.join(profilesDir, 'web'))) return 'web'
  if (existsSync(profilesDir)) {
    const names = readdirSync(profilesDir).filter((name) => !name.startsWith('.'))
    if (names.length === 1) return names[0]
  }
  return 'desktop'
}

/** 从进程列表里找正在运行的 DSH profile。 */
function profileFromRunningProcess() {
  if (process.platform !== 'win32') return undefined
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe' OR Name='node.exe'\" | Select-Object -ExpandProperty CommandLine) -join \"`n\"",
    ], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    const match = /[\\/]\.dsh[\\/]profiles[\\/]([^\\/\s"]+)/i.exec(output)
    return match ? match[1] : undefined
  } catch {
    return undefined
  }
}

/** 找 dsh 启动器（.cmd / .ps1 / 可执行）。 */
function resolveDshCommand() {
  for (const candidate of ['dsh.cmd', 'dsh']) {
    try {
      const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', [candidate], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      }).trim().split(/\r?\n/)[0]
      if (found) return found
    } catch {
      // 继续试下一个
    }
  }
  return undefined
}

/** 读 profile 的 package.json（没有则返回一个可写骨架）。 */
function readProfileManifest(dir) {
  const file = path.join(dir, 'package.json')
  if (!existsSync(file)) return { manifest: { name: `dsh-profile-${path.basename(dir)}`, private: true, dsh: { profile: { bundles: [] } } }, file, existed: false }
  try {
    return { manifest: JSON.parse(readFileSync(file, 'utf8')), file, existed: true }
  } catch (error) {
    fail(`profile 的 package.json 不是合法 JSON：${file}\n${String(error?.message ?? error)}`)
  }
}

/** 备份一个文件（只在同目录、同扩展名意义下追加 .bak-<时间戳>）。 */
function backup(file) {
  if (!existsSync(file)) return undefined
  const target = `${file}.bak-mimo-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`
  cpSync(file, target)
  return target
}

/**
 * 走官方路径：dsh plugin --profile <p> add file:<本目录>
 *
 * 两个已实测的坑：
 *   1. `dsh plugin` 对 **desktop** profile 直接报错
 *      （"profile \"desktop\" is managed exclusively by the Electron application"），
 *      桌面版只能走文件系统兜底；
 *   2. 路径里带中文时，pnpm 写进 profile package.json 的 specifier 会出现乱码
 *      （实测「数据」→「鏁版嵁」），dependencies 里的记录不可靠。
 *      文件系统兜底不走 pnpm，因此不受影响。
 *
 * 所以：desktop profile 或含非 ASCII 的路径，都直接走兜底；其余情况才试 CLI。
 *
 * @param {string} profile - profile 名。
 * @param {object} options - 命令行选项。
 * @returns {boolean} 是否成功。
 */
function installViaCli(profile, options) {
  if (profile.toLowerCase() === 'desktop') {
    log('→ desktop profile 由 Electron 应用独占管理，`dsh plugin` 不接受它；直接走文件系统安装。')
    return false
  }
  // eslint-disable-next-line no-control-regex
  if (/[^\u0000-\u007F]/.test(SCRIPT_DIR)) {
    warn('本目录路径含非 ASCII 字符，pnpm 写 specifier 时可能乱码；直接走文件系统安装。')
    return false
  }
  const dsh = resolveDshCommand()
  if (!dsh) {
    warn('找不到 dsh 命令，改用文件系统兜底。')
    return false
  }
  const spec = `file:${SCRIPT_DIR}`
  const args = ['plugin', '--profile', profile, 'add', spec]
  if (options.acceptRisk) args.push('--accept-risk')
  log(`→ 执行：${dsh} ${args.join(' ')}`)
  const result = spawnSync(dsh, args, { stdio: 'inherit', windowsHide: true, shell: false })
  if (result.error) {
    warn(`dsh plugin 调用失败：${String(result.error.message)}`)
    return false
  }
  if (result.status !== 0) {
    warn(`dsh plugin 退出码 ${String(result.status)}，改用文件系统兜底。`)
    return false
  }
  return true
}

/**
 * 文件系统兜底安装：
 *   1. 把包体拷进 <profile>/node_modules/dsh-mimo-vision
 *      （无 scope 包直接落在 node_modules 根下；带 scope 时才需要建 scope 子目录）
 *   2. package.json 的 dsh.profile.bundles 追加包名
 *   3. 保证 profile 的 cordis.patch.yml 里有一行（本包自带的补丁层会被 bundle 机制加载，
 *      但 profiles/<p>/cordis.patch.yml 才是用户层；这里只做「已经装了」的自检与提示）
 */
function installViaFilesystem(profile) {
  const dir = path.join(dshHome(), 'profiles', profile)
  if (!existsSync(dir)) fail(`profile 目录不存在：${dir}\n请先在 dsh 里创建该 profile，或用 --profile 指定正确的名字。`)

  // 1) 包体：无 scope 包直接放 node_modules 下，与 pnpm 的落盘布局一致。
  const segments = PKG_NAME.split('/')
  const target = path.join(dir, 'node_modules', ...segments)
  mkdirSync(path.dirname(target), { recursive: true })
  if (existsSync(target)) {
    log('↻ 目标已存在，先移除旧版本…')
    rmSync(target, { recursive: true, force: true })
  }
  cpSync(SCRIPT_DIR, target, {
    recursive: true,
    filter(source) {
      const relative = path.relative(SCRIPT_DIR, source)
      if (relative === '') return true
      const head = relative.split(path.sep)[0]
      // 不要把开发期的 node_modules（junction 指向内核包）与 .git 拷进去。
      return head !== 'node_modules' && head !== '.git'
    },
  })
  log(`✔ 包体已就位：${target}`)

  // 2) bundles
  const { manifest, file } = readProfileManifest(dir)
  const backupFile = backup(file)
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  // 兜底路径不走 pnpm，所以 dependencies 里不会（也不应）出现本包；
  // 真正让它被加载的是 bundles 这一项 + 包体 + 包自带的 cordis.patch.yml。
  if (bundles.includes(PKG_NAME)) {
    log('ℹ dsh.profile.bundles 已包含本包，跳过。')
  } else {
    // 追加到末尾：本插件不覆盖任何内置条目，只在自己的 cordis.patch.yml 里 insert 一行，
    // 所以层序放在最外层最直观（实测 dump-config 组合结果正确）。
    bundles.push(PKG_NAME)
    manifest.dsh.profile.bundles = bundles
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    log(`✔ 已写入 dsh.profile.bundles：${file}${backupFile ? `（备份 ${path.basename(backupFile)}）` : ''}`)
  }

  // 3) 组合补丁自检
  //
  // 这里要区分两种长得像、含义完全不同的 row：
  //   · `- insert:` 块里再声明一条同 id 的 row → 真·重复插入，会被 Loader 判重；
  //   · 顶层 `- id: mimo-vision` + `name:` + `config:` → 这是**设置页保存下来的
  //     用户层**（dsh-settings-file 就写在这），必须保留，不是残留。
  // 两者都含 `name: '<包名>'`，所以不能只按名字 grep（老版本就是这么误报的）。
  const patchFile = path.join(dir, 'cordis.patch.yml')
  if (existsSync(patchFile)) {
    const text = readFileSync(patchFile, 'utf8')
    const names = [PKG_NAME, ...LEGACY_PKG_NAMES]
    const declaresName = (chunk) => names.some((name) => (
      chunk.includes(`name: '${name}'`) || chunk.includes(`name: "${name}"`) || chunk.includes(`name: ${name}`)
    ))
    // 按顶层条目切块：每个 `- ` 开头的行起一条。
    const chunks = []
    for (const line of text.split(/\r?\n/)) {
      if (/^- /.test(line)) chunks.push([line])
      else if (chunks.length > 0) chunks[chunks.length - 1].push(line)
    }
    const insertChunk = chunks.find((chunk) => /^- insert:/.test(chunk[0]) && declaresName(chunk.join('\n')))
    if (insertChunk !== undefined) {
      warn(`profile 补丁里有重复 insert（会与包自带的 cordis.patch.yml 撞同一 row）：${patchFile}`)
      warn('  请删掉那个 `- insert:` 块 —— 该 row 由本包自带，不用手工插。')
    }
    // 老用户升级提示：用户层 row 的 name 是「补丁守卫」（applyEntryPatches 会比对
    // target.name，不一致就整条跳过）。还写着旧 scope 名的话，保存过的配置会静默失效。
    const legacyGuard = LEGACY_PKG_NAMES.find((name) => (
      text.includes(`name: '${name}'`) || text.includes(`name: "${name}"`) || text.includes(`name: ${name}`)
    ))
    if (legacyGuard !== undefined) {
      warn(`profile 补丁里的用户层 row 仍写着旧包名 ${legacyGuard}：${patchFile}`)
      warn(`  包名已改为 ${PKG_NAME}；该 row 的 name 必须跟着改，否则配置会被 Loader 跳过。`)
    }
  }
  return dir
}

/** 清理历史遗留：内核 node_modules 里的旧拷贝（它会跟着内核升级消失，也容易打挂启动）。 */
function reportLegacyCopies() {
  const candidates = []
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim()
    for (const marker of LEGACY_INSTALL_MARKERS) candidates.push(path.join(root, marker))
  } catch {
    // 没有 npm 就跳过
  }
  const found = candidates.filter((candidate) => existsSync(candidate))
  if (found.length === 0) return
  log('\nℹ 发现旧的「内核内拷贝」安装残留（0.1.x 的装法）：')
  for (const item of found) log(`   - ${item}`)
  log('  它们会随内核升级消失，且若与 profile 版本同时加载会冲突。建议删除：')
  for (const item of found) log(`   Remove-Item -Recurse -Force "${item}"`)
  log('  另外 <DSH_HOME>\\fix-mimo-vision.mjs 这类补丁脚本对新版本已无作用，可一并删除。')
}

/** 校验包体是否自洽（避免装了个半成品）。 */
function verifyPackage() {
  const required = ['package.json', 'lib/index.js', 'lib/client.js', 'cordis.patch.yml']
  for (const rel of required) {
    if (!existsSync(path.join(SCRIPT_DIR, rel))) fail(`包体不完整，缺少 ${rel}。请在仓库根目录（含 package.json 的那一层）运行本脚本。`)
  }
  const manifest = JSON.parse(readFileSync(path.join(SCRIPT_DIR, 'package.json'), 'utf8'))
  if (manifest.name !== PKG_NAME) fail(`package.json 的 name 是 ${manifest.name}，期望 ${PKG_NAME}。`)
  if (manifest.dsh?.bundle?.patch === undefined) fail('package.json 缺少 dsh.bundle.patch —— 少了它 Loader 不会加载本包的组合层。')
  if (manifest.dsh?.client === undefined) fail('package.json 缺少 dsh.client —— 少了它浏览器半不会被组合。')
  if (statSync(path.join(SCRIPT_DIR, 'lib', 'client.js')).size === 0) fail('lib/client.js 是空文件。')
  return manifest
}

// ───────────────────────────── main ─────────────────────────────

log('════════ dsh-mimo-vision 安装（profile 级永久插件）════════')
const options = parseArgs(process.argv.slice(2))
const manifest = verifyPackage()
log(`包：${manifest.name}@${manifest.version}`)
log(`源：${SCRIPT_DIR}`)

const profile = resolveProfile(options.profile)
log(`profile：${profile}`)

let installed = false
if (options.useCli) {
  installed = installViaCli(profile, options)
  if (installed) log('✔ 已通过 dsh plugin 安装（官方路径，含兼容性检查）。')
} else {
  log('→ 按 --no-cli 跳过 dsh plugin。')
}

if (!installed) {
  const dir = installViaFilesystem(profile)
  log(`✔ 已通过文件系统兜底安装到：${dir}`)
}

reportLegacyCopies()

log('\n下一步：')
log('  1. 重启 DeepSeek Harness（或 dsh web）—— profile 的结构性变更需要重启才生效；')
log('  2. 打开 设置 → MiMo 视觉（也可从 插件 → MiMo 视觉 进入）；')
log('  3. 填三样东西：**模型名称**（如 mimo-v2.5-pro）、**模型密钥**、**默认提示词**，点「测试连接」再「保存」；')
log('     · 模型密钥只写进 <DSH_HOME>/.credentials.yaml，不落配置文件；')
log('     · 其余字段写进 profiles/<profile>/cordis.patch.yml 的 - id: mimo-vision 条目；')
log('  4. 回聊天框粘贴一张图发送即可。')
log('\n自检（可选，在 profile 目录下跑）：')
log(`  cd ${path.join(dshHome(), 'profiles', profile)}`)
log(`  node "${path.join(SCRIPT_DIR, 'scripts', 'schema-check.mjs')}"`)
log(`  node "${path.join(SCRIPT_DIR, 'scripts', 'smoke.mjs')}"`)
