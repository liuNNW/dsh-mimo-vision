#!/usr/bin/env node
/**
 * MiMo 视觉识别 —— 插件契约自检（不需要启动 dsh）。
 *
 * 校验两件事，任一失败即非零退出：
 *
 * 1. **Config 契约**：用 profile 里的 @deepseek-ai/schemastery 解析 Config({})，
 *    确认默认值齐全；`toJSON()` 后每个字段都带 `meta.volatile`，且没有
 *    「volatile 嵌在 volatile 内」（schemastery 对那种写法会抛 ValidationError）。
 *    设置页只显示 volatile 字段，所以这条挂了等于设置页空白。
 *
 * 2. **工具参数契约**：用 @deepseek-ai/dsh-tools 的 parameterSchemaSpecToJsonSchema
 *    编译 mimo_analyze_image 的 parameters。历史上这里写成 JSON Schema 形态
 *    （{type:'object',properties,required:[]}）会让 defineTool 抛
 *    JsonSchemaError，进而让整棵插件树 FAILED、dsh 起不来。
 *
 * 用法（cwd 必须在 profile 目录下，才能解析到内核依赖）：
 *   cd %USERPROFILE%\.dsh\profiles\desktop
 *   node "<仓库>/mimo-vision-plugin/scripts/schema-check.mjs"
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '..')

const failures = []
const passes = []

/** 记录一条通过。 */
function ok(label) {
  passes.push(label)
  console.log(`  ✔ ${label}`)
}

/** 记录一条失败。 */
function fail(label, detail) {
  failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
  console.error(`  ✖ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 定位 profile 的 node_modules：优先 cwd（脚本约定在 profile 目录里跑），
 * 否则退到 <DSH_HOME>/profiles/desktop。
 * @returns {string} 绝对路径。
 */
function profileNodeModules() {
  const cwd = process.cwd()
  if (path.basename(path.dirname(cwd)).toLowerCase() === 'profiles') return path.join(cwd, 'node_modules')
  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE ?? '', '.dsh')
  return path.join(dshHome, 'profiles', 'desktop', 'node_modules')
}

/**
 * 按「插件自己的解析路径」导入一个内核依赖：先看包目录下的 node_modules
 * （开发期 junction / pnpm 装出来的 hoisted 依赖），再看 profile 的 node_modules。
 * @param {string} specifier - 包名（可带子路径）。
 * @returns {Promise<object>} 模块命名空间。
 */
async function importDep(specifier) {
  const candidates = [
    path.join(PKG_ROOT, 'node_modules', ...specifier.split('/')),
    path.join(profileNodeModules(), ...specifier.split('/')),
  ]
  let lastError
  for (const base of candidates) {
    for (const rel of [[], ['lib', 'index.js'], ['lib', 'index.mjs'], ['index.js']]) {
      const target = path.join(base, ...rel)
      try {
        const { statSync } = await import('node:fs')
        statSync(target)
      } catch {
        continue
      }
      try {
        return await import(pathToFileURL(target).href)
      } catch (error) {
        lastError = error
      }
    }
    try {
      return await import(pathToFileURL(base).href)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error(`无法解析依赖 ${specifier}`)
}

async function main() {
  console.log('══ MiMo 视觉识别 · 契约自检 ══')
  console.log(`包目录：${PKG_ROOT}`)

  const configUrl = pathToFileURL(path.join(PKG_ROOT, 'lib', 'config.js')).href
  const { Config, DEFAULT_API_KEY_REF } = await import(configUrl)

  // ---- 1. Config schema ----
  console.log('\n[1] Config schema')
  // volatile 字段解析出来是「引用对象」（带 get()），普通字段是裸值。
  const parsed = Config({})
  const readValue = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)
  const expectedDefaults = {
    apiKeyEnv: DEFAULT_API_KEY_REF,
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro',
    maxTokens: 2048,
    temperature: 0.3,
    autoConvertImages: true,
  }
  for (const [key, value] of Object.entries(expectedDefaults)) {
    const actual = readValue(parsed[key])
    if (actual === value) ok(`默认值 ${key} = ${JSON.stringify(value)}`)
    else fail(`默认值 ${key}`, `期望 ${JSON.stringify(value)}，实际 ${JSON.stringify(actual)}`)
  }
  const promptDefault = readValue(parsed.defaultPrompt)
  if (typeof promptDefault === 'string' && promptDefault.length > 0) ok('默认值 defaultPrompt 非空')
  else fail('默认值 defaultPrompt', '应为非空字符串')

  // toJSON() 是一张 uid → 节点 的引用表，先定位根节点再读 dict。
  const json = Config.toJSON()
  const rootNode = json?.refs?.[json.uid]
  const dict = rootNode?.dict ?? {}
  const VOLATILE_FIELDS = [
    'apiKeyEnv', 'apiKey', 'baseUrl', 'model', 'maxTokens',
    'temperature', 'defaultPrompt', 'systemPrompt', 'autoConvertImages',
  ]
  for (const field of VOLATILE_FIELDS) {
    const node = json?.refs?.[dict[field]]
    if (node === undefined) {
      fail(`字段 ${field} 在 schema 里`, 'toJSON() 里找不到该字段')
      continue
    }
    if (node.meta?.volatile === true) ok(`字段 ${field} 标记 volatile（会出现在设置页）`)
    else fail(`字段 ${field} 未标记 volatile`, '设置页不会显示它')
  }
  if (rootNode?.meta?.volatile === true) fail('根节点不应是 volatile', 'volatile 根会让整份 Config 变成一个字段')
  else ok('根节点不是 volatile（字段可逐个编辑）')

  // ---- 2. 工具参数契约 ----
  console.log('\n[2] mimo_analyze_image 参数契约')
  let parameterSchemaSpecToJsonSchema
  try {
    const tools = await importDep('@deepseek-ai/dsh-tools')
    parameterSchemaSpecToJsonSchema = tools.parameterSchemaSpecToJsonSchema
    if (typeof parameterSchemaSpecToJsonSchema !== 'function') throw new Error('导出里没有 parameterSchemaSpecToJsonSchema')
  } catch (error) {
    fail('导入 @deepseek-ai/dsh-tools', String(error?.message ?? error))
  }
  if (parameterSchemaSpecToJsonSchema !== undefined) {
    const parameters = {
      image: { type: 'string', required: true, description: '图片来源' },
      prompt: { type: 'string', description: '分析要求' },
      model: { type: 'string', description: '模型名称' },
      maxTokens: { type: 'integer', description: '最大输出 token' },
    }
    try {
      const compiled = parameterSchemaSpecToJsonSchema(parameters)
      if (compiled.type === 'object') ok('parameters 编译为 object 根')
      else fail('parameters 根类型', `期望 object，实际 ${String(compiled.type)}`)
      const required = Array.isArray(compiled.required) ? compiled.required : []
      if (required.length === 1 && required[0] === 'image') ok('required = ["image"]')
      else fail('required', `期望 ["image"]，实际 ${JSON.stringify(required)}`)
      if (compiled.properties?.image?.type === 'string') ok('image 是 string 值 schema')
      else fail('image 类型', JSON.stringify(compiled.properties?.image))
    } catch (error) {
      fail('parameterSchemaSpecToJsonSchema 抛错', String(error?.message ?? error))
    }
  }

  // ---- 3. 宿主半可导入且导出面完整 ----
  console.log('\n[3] 宿主半导出面')
  try {
    const host = await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'index.js')).href)
    if (host.name === 'mimo-vision') ok('name = mimo-vision')
    else fail('name', String(host.name))
    if (typeof host.apply === 'function') ok('apply 是函数')
    else fail('apply', typeof host.apply)
    if (Array.isArray(host.inject) && host.inject.includes('tools')) ok('inject 含 tools（历史崩溃点已修）')
    else fail('inject 缺少 tools', JSON.stringify(host.inject))
    if (host.Config === Config || typeof host.Config === 'function') ok('导出 Config')
    else fail('导出 Config', typeof host.Config)
  } catch (error) {
    fail('导入宿主半', String(error?.message ?? error))
  }

  console.log(`\n结果：${passes.length} 通过，${failures.length} 失败`)
  if (failures.length > 0) {
    console.error('\n失败项：')
    for (const item of failures) console.error(`  - ${item}`)
    process.exit(1)
  }
}

await main()
