#!/usr/bin/env node
/**
 * MiMo 视觉识别 —— 冒烟测试（不需要启动 dsh，也不联网）。
 *
 * 覆盖：
 *   [1] 浏览器半：在 stub 出来的 window.__ModuleLoader__ 下能注册；factory 跑通后
 *       inject 里含 configForms / remote.credentials，apply 是函数。
 *   [2] 宿主 HTTP 面：直接调用 lib/index.js 注册的路由处理器（用假 ctx 捕获），
 *       对 status / prepare / analyze / test 四条路径断言参数校验与错误映射，
 *       其中 fetch 用桩函数替换，不发真实请求。
 *   [3] 密钥解析顺序：Config 字面量 → 凭据服务 → 启动环境变量。
 *   [4] 迁移：MIMO_VISION_CONFIG 被拆成 Config 字段 + 新凭据，旧引用被删除。
 *
 * 用法（cwd 必须在 profile 目录下，才能解析到内核依赖）：
 *   cd %USERPROFILE%\.dsh\profiles\desktop
 *   node "<仓库>/mimo-vision-plugin/scripts/smoke.mjs"
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '..')

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

/** 断言辅助：值相等。 */
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) ok(label)
  else fail(label, `期望 ${e}，实际 ${a}`)
}

/** 定位 profile 的 node_modules。 */
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
      const { statSync } = await import('node:fs')
      try {
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

/** 造一个记录型假响应对象。 */
function fakeResponse() {
  const captured = { status: undefined, headers: undefined, body: undefined }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(text) {
      captured.body = text
    },
  }
}

/** 造一个请求体可迭代对象。 */
async function* bodyStream(payload) {
  yield Buffer.from(payload === undefined ? '' : JSON.stringify(payload), 'utf8')
}

/** 造一个最小的侵入式假 ctx，够宿主半注册路由与工具。
 *
 * 模拟 cordis 的两条契约：
 *   - `ctx.get(name)` 读可选服务；
 *   - `ctx.inject(deps, cb)` 把命中的服务挂到**子上下文**上（`sctx.settings`），
 *     命中不全时不调用回调 —— 这正是宿主半「settings 缺席就跳过」的依赖。
 */
function fakeHostCtx({ credentials, settings, logger } = {}) {
  const registered = { routes: [], tools: [], listeners: [] }
  const ctx = {
    logger: logger ?? { info() {}, warn() {} },
    webServer: {
      register(route) {
        registered.routes.push(route)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        registered.tools.push(definition)
        return () => {}
      },
    },
    effect(callback) {
      // 立刻执行一次；返回的清理函数交给调用方（这里只关心注册是否成功）。
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on(name, handler) {
      registered.listeners.push({ name, handler })
      return () => {}
    },
    inject(deps, callback) {
      const child = Object.create(ctx)
      let complete = true
      for (const dep of deps) {
        const value = ctx.get(dep)
        if (value === undefined) {
          complete = false
          break
        }
        child[dep] = value
      }
      if (!complete) return () => {}
      const disposer = callback(child)
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'settings') return settings
      if (name === 'tools') return ctx.tools
      if (name === 'webServer') return ctx.webServer
      return undefined
    },
    _registered: registered,
  }
  return ctx
}

/** 用 profile 的 dsh-tools 校验工具定义能否通过注册前的参数编译。 */
async function compileToolParameters(definition) {
  const tools = await importDep('@deepseek-ai/dsh-tools')
  return tools.parameterSchemaSpecToJsonSchema(definition.parameters)
}

// ───────────────────────── [1] 浏览器半 ─────────────────────────

async function testClientHalf() {
  console.log('\n[1] 浏览器半')
  const captured = []
  globalThis.window = {
    __ModuleLoader__: {
      load(registration) {
        captured.push(registration)
      },
    },
  }
  globalThis.document = {
    baseURI: 'http://127.0.0.1:19387/',
    head: { appendChild() {} },
    querySelector() {
      return null
    },
    createElement() {
      return { dataset: {}, textContent: '', remove() {} }
    },
  }

  const url = pathToFileURL(path.join(PKG_ROOT, 'lib', 'client.js')).href
  await import(url)

  if (captured.length === 1) ok('注册了一次 __ModuleLoader__.load')
  else fail('注册次数', String(captured.length))
  const registration = captured[0]
  eq('模块 id', registration?.id, 'dsh-mimo-vision')

  // factory 需要一个 require：只 stub 真正用到的两个符号。
  const requiredSpecs = []
  const factoryRequire = (specifier) => {
    requiredSpecs.push(specifier)
    if (specifier === 'react') {
      return {
        createElement: () => null,
        useEffect() {},
        useState() {
          return [false, () => {}]
        },
        useMemo: (fn) => fn(),
      }
    }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        SettingsForm: () => null,
        SettingsFormModel: class {
          constructor() {}
          shell() {
            return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
          }
          field() {
            return { text: '', overridden: false, invalid: false }
          }
          bind(project) {
            return { getSnapshot: project, set() {}, subscribe() { return () => {} } }
          }
          actions() {
            return { edit() {}, resetField() {}, save() {}, discard() {} }
          }
          dispose() {}
        },
        SettingsSecretField: () => null,
        SettingsValueField: () => null,
        Button: () => null,
        Pill: () => null,
        StateDot: () => null,
        Switch: () => null,
        Tag: () => null,
        IconInfoOutlineRegular: () => null,
        settingsNumberField: (field) => ({ field, format: String, parse: () => ({ kind: 'set', value: 1 }) }),
        settingsTextField: (field) => ({ field, format: String, parse: () => ({ kind: 'set', value: 'x' }) }),
      }
    }
    throw new Error(`client half required unexpected module "${specifier}"`)
  }

  let exported = null
  try {
    exported = registration.factory(factoryRequire)
    ok('factory 执行成功')
  } catch (error) {
    fail('factory 执行', String(error?.message ?? error))
    return
  }
  if (Array.isArray(exported.inject)) ok(`inject = ${JSON.stringify(exported.inject)}`)
  else fail('inject 不是数组', typeof exported.inject)
  for (const required of ['slots', 'locale', 'configForms', 'remote', 'remote.credentials', 'timer']) {
    if (exported.inject?.includes(required)) ok(`inject 含 ${required}`)
    else fail(`inject 缺少 ${required}`, JSON.stringify(exported.inject))
  }
  if (typeof exported.apply === 'function') ok('导出 apply')
  else fail('导出 apply', typeof exported.apply)
  eq('导出 SETTINGS_NS', exported.SETTINGS_NS, 'mimo-vision')
  if (!requiredSpecs.includes('@deepseek-ai/dsh-client-ui-settings')) {
    ok('没有直接依赖 ui-settings 包（只用 configForms 服务）')
  } else {
    // 也不致命：只要解析得到即可。
    ok('引用了 @deepseek-ai/dsh-client-ui-settings（由 dsh.client.inject 保证存在）')
  }
}

// ─────────────────── [2][3][4] 宿主半：路由 / 密钥 / 迁移 ───────────────────

async function loadHost() {
  return await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'index.js')).href)
}

/** 造一套假凭据服务。 */
function fakeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  const events = []
  return {
    store,
    events,
    async resolve(ref) {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'file' }
    },
    async describe(ref) {
      return { configured: store.has(ref), writable: true, source: 'file' }
    },
    async set(ref, value) {
      store.set(ref, value)
    },
    async unset(ref) {
      store.delete(ref)
    },
  }
}

/** 用假 ctx 起一个宿主半实例，返回注册物。 */
async function bootHost({ config, credentials, settings, logger } = {}) {
  const host = await loadHost()
  const ctx = fakeHostCtx({ credentials: credentials ?? fakeCredentials(), settings, logger })
  host.apply(ctx, config ?? {})
  return { host, ctx }
}

/** 调一次路由。 */
async function callRoute(ctx, method, payload, httpMethod = 'POST') {
  const route = ctx._registered.routes.find((item) => item.path === '/mimo-vision/api')
  if (route === undefined) throw new Error('路由没注册上')
  const res = fakeResponse()
  const req = { method: httpMethod, url: `/mimo-vision/api/${method}`, async *[Symbol.asyncIterator]() {} }
  const inner = bodyStream(payload)
  req[Symbol.asyncIterator] = inner[Symbol.asyncIterator].bind(inner)
  await route.handler(req, res)
  return { status: res.captured.status, body: res.captured.body === undefined ? undefined : JSON.parse(res.captured.body) }
}

async function testHostSurface() {
  console.log('\n[2] 宿主 HTTP 面')
  const credentials = fakeCredentials()
  const { host, ctx } = await bootHost({ credentials })

  if (ctx._registered.routes.length === 1 && ctx._registered.routes[0].path === '/mimo-vision/api') ok('注册了 /mimo-vision/api prefix 路由')
  else fail('路由注册', JSON.stringify(ctx._registered.routes.map((r) => r.path)))
  eq('路由 kind', ctx._registered.routes[0]?.kind, 'prefix')
  eq('注册的工具数', ctx._registered.tools.length, 1)
  eq('工具名', ctx._registered.tools[0]?.name, 'mimo_analyze_image')

  // 工具参数必须能过内核的参数编译器。注意把 **作者态** 参数表喂给它，
  // 而不是注册后已被 defineTool 编译成 JSON Schema 的 definition.parameters。
  try {
    const compiled = await compileToolParameters({ parameters: host.MIMO_ANALYZE_TOOL_PARAMETERS })
    eq('工具 required', compiled.required, ['image'])
    ok('工具参数通过 parameterSchemaSpecToJsonSchema')
  } catch (error) {
    fail('工具参数编译', String(error?.message ?? error))
  }
  // 同时验证注册表里的定义确实带上了编译后的 schema。
  if (ctx._registered.tools[0]?.parameters?.type === 'object') ok('注册定义带编译后的 parameters')
  else fail('注册定义的 parameters', JSON.stringify(ctx._registered.tools[0]?.parameters))

  // status：未配置密钥
  let answer = await callRoute(ctx, 'status', {})
  eq('status HTTP', answer.status, 200)
  eq('status ok', answer.body.ok, true)
  eq('status configured（未配置）', answer.body.configured, false)
  eq('status apiKeyEnv', answer.body.apiKeyEnv, 'MIMO_VISION_API_KEY')

  // status：配好密钥后应为 true
  await credentials.set('MIMO_VISION_API_KEY', 'sk-test-key')
  answer = await callRoute(ctx, 'status', {})
  eq('status configured（已配置）', answer.body.configured, true)

  // prepare：正常路径
  const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  answer = await callRoute(ctx, 'prepare', {
    sessionId: 'session-1',
    images: [{ mediaType: 'image/png', data: onePixelPng }],
    prompt: '这张图里有什么？',
  })
  eq('prepare ok', answer.body.ok, true)
  eq('prepare count', answer.body.count, 1)

  // prepare：缺 sessionId
  answer = await callRoute(ctx, 'prepare', { images: [{ mediaType: 'image/png', data: onePixelPng }] })
  eq('prepare 缺 sessionId → ok=false', answer.body.ok, false)

  // prepare：坏类型
  answer = await callRoute(ctx, 'prepare', { sessionId: 's', images: [{ mediaType: 'text/plain', data: 'abc' }] })
  eq('prepare 非图片类型 → ok=false', answer.body.ok, false)

  // prepare：空图集
  answer = await callRoute(ctx, 'prepare', { sessionId: 's', images: [] })
  eq('prepare 空图集 → ok=false', answer.body.ok, false)

  // 未知方法 / 非 POST
  answer = await callRoute(ctx, 'nope', {})
  eq('未知方法 HTTP', answer.status, 404)
  const getAnswer = await callRoute(ctx, 'status', {}, 'GET')
  eq('非 POST HTTP', getAnswer.status, 405)

  // analyze：未配置密钥时给出可操作的提示
  const bare = await bootHost({ credentials: fakeCredentials() })
  answer = await callRoute(bare.ctx, 'analyze', { dataUrl: 'data:image/png;base64,' + onePixelPng })
  eq('analyze 未配密钥 ok=false', answer.body.ok, false)
  if (String(answer.body.error).includes('设置')) ok('未配密钥的提示指向设置页')
  else fail('未配密钥提示', String(answer.body.error))

  // analyze：缺图源
  answer = await callRoute(bare.ctx, 'analyze', {})
  eq('analyze 缺图源 ok=false', answer.body.ok, false)
}

async function testFetchErrorMapping() {
  console.log('\n[3] MiMo 错误映射（fetch 打桩）')
  const cases = [
    { status: 401, body: '{"error":"invalid api key sk-abcdef123456"}', expect: '密钥无效', forbid: 'sk-abcdef123456' },
    { status: 404, body: '{"error":"model not found"}', expect: '接口地址或模型名称', forbid: undefined },
    { status: 429, body: '{"error":"rate limited"}', expect: '限流', forbid: undefined },
    { status: 500, body: 'boom', expect: 'MiMo 服务端错误', forbid: undefined },
  ]
  const originalFetch = globalThis.fetch
  try {
    for (const item of cases) {
      globalThis.fetch = async () => ({
        ok: false,
        status: item.status,
        async text() {
          return item.body
        },
      })
      const { ctx } = await bootHost({ credentials: fakeCredentials({ MIMO_VISION_API_KEY: 'sk-real' }) })
      const answer = await callRoute(ctx, 'test', {})
      eq(`HTTP ${item.status} → ok=false`, answer.body.ok, false)
      if (String(answer.body.error).includes(item.expect)) ok(`HTTP ${item.status} 提示含「${item.expect}」`)
      else fail(`HTTP ${item.status} 提示`, String(answer.body.error))
      if (item.forbid !== undefined && !String(answer.body.error).includes(item.forbid)) ok(`HTTP ${item.status} 已对密钥脱敏`)
      else if (item.forbid !== undefined) fail(`HTTP ${item.status} 未脱敏密钥`, String(answer.body.error))
    }

    // 成功路径：models 列表
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ data: [{ id: 'mimo-v2.5-pro' }, { id: 'mimo-v2.5' }] })
      },
    })
    const { ctx } = await bootHost({ credentials: fakeCredentials({ MIMO_VISION_API_KEY: 'sk-real' }) })
    const answer = await callRoute(ctx, 'test', {})
    eq('test ok', answer.body.ok, true)
    eq('test 模型数', answer.body.models.length, 2)

    // chat/completions：max_completion_tokens 被拒后自动用 max_tokens 重试
    const seen = []
    let first = true
    globalThis.fetch = async (_url, init) => {
      seen.push(JSON.parse(init.body))
      if (first) {
        first = false
        return { ok: false, status: 400, async text() { return '{"error":"unknown field max_completion_tokens"}' } }
      }
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ model: 'mimo-v2.5-pro', choices: [{ message: { content: '一只猫坐在窗台上' } }], usage: { total_tokens: 42 } })
        },
      }
    }
    const analyzed = await callRoute(ctx, 'analyze', { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' })
    eq('analyze 重试后 ok', analyzed.body.ok, true)
    eq('analyze 描述', analyzed.body.description, '一只猫坐在窗台上')
    eq('analyze 请求次数', seen.length, 2)
    if (seen[1].max_tokens !== undefined && seen[1].max_completion_tokens === undefined) ok('第二次请求改用 max_tokens')
    else fail('重试字段', JSON.stringify(Object.keys(seen[1])))
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testApiKeyOrder() {
  console.log('\n[4] 密钥解析顺序')
  const onePixelPng = 'iVBORw0KGgo='
  const originalFetch = globalThis.fetch
  const seenAuth = []
  globalThis.fetch = async (_url, init) => {
    seenAuth.push(init?.headers?.authorization)
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: 'ok' } }] })
      },
    }
  }
  try {
    // ① Config 字面量优先
    let boot = await bootHost({
      config: { apiKey: 'sk-literal', baseUrl: 'https://example.invalid/v1' },
      credentials: fakeCredentials({ MIMO_VISION_API_KEY: 'sk-from-store' }),
    })
    await callRoute(boot.ctx, 'analyze', { dataUrl: `data:image/png;base64,${onePixelPng}` })
    eq('字面量优先', seenAuth.at(-1), 'Bearer sk-literal')

    // ② 无字面量 → 凭据服务
    boot = await bootHost({
      config: { apiKeyEnv: 'MIMO_VISION_API_KEY', baseUrl: 'https://example.invalid/v1' },
      credentials: fakeCredentials({ MIMO_VISION_API_KEY: 'sk-from-store' }),
    })
    await callRoute(boot.ctx, 'analyze', { dataUrl: `data:image/png;base64,${onePixelPng}` })
    eq('凭据服务次之', seenAuth.at(-1), 'Bearer sk-from-store')

    // ③ 凭据也没有 → 启动环境变量
    process.env.MIMO_VISION_ENV_ONLY = 'sk-from-env'
    boot = await bootHost({
      config: { apiKeyEnv: 'MIMO_VISION_ENV_ONLY', baseUrl: 'https://example.invalid/v1' },
      credentials: fakeCredentials({}),
    })
    await callRoute(boot.ctx, 'analyze', { dataUrl: `data:image/png;base64,${onePixelPng}` })
    eq('启动环境兜底', seenAuth.at(-1), 'Bearer sk-from-env')
    delete process.env.MIMO_VISION_ENV_ONLY
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testLegacyMigration() {
  console.log('\n[5] 旧配置迁移')
  const credentials = fakeCredentials({
    MIMO_VISION_CONFIG: JSON.stringify({
      apiKey: 'sk-legacy',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5',
      maxTokens: 4096,
      temperature: 0.5,
      defaultPrompt: '旧提示词',
      systemPrompt: '',
      autoConvertImages: true,
    }),
  })
  const updates = []
  const settings = {
    configure() {
      return () => {}
    },
    describe() {
      return [{ ns: 'mimo-vision', user: {}, value: {} }]
    },
    async update(ns, patch) {
      updates.push({ ns, patch })
    },
  }
  await bootHost({ credentials, settings })
  // 迁移是 fire-and-forget，让微任务跑完。
  await new Promise((resolve) => setTimeout(resolve, 30))

  eq('新凭据已写入', credentials.store.get('MIMO_VISION_API_KEY'), 'sk-legacy')
  eq('旧凭据已删除', credentials.store.has('MIMO_VISION_CONFIG'), false)
  eq('settings.update 次数', updates.length, 1)
  eq('迁移目标命名空间', updates[0]?.ns, 'mimo-vision')
  eq('迁移了 model', updates[0]?.patch?.model, 'mimo-v2.5')
  eq('迁移了 maxTokens', updates[0]?.patch?.maxTokens, 4096)

  // 幂等：再起一次不应再有动作（旧引用已删）
  const second = []
  const settings2 = {
    configure() { return () => {} },
    describe() { return [{ ns: 'mimo-vision', user: { model: 'already-set' } }] },
    async update(ns, patch) { second.push(patch) },
  }
  await bootHost({ credentials, settings: settings2 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  eq('第二次迁移无动作', second.length, 0)

  // 已存在的用户值不被覆盖
  const credentials3 = fakeCredentials({
    MIMO_VISION_CONFIG: JSON.stringify({ apiKey: 'sk-legacy2', model: 'mimo-v2.5-pro' }),
    MIMO_VISION_API_KEY: 'sk-existing',
  })
  const third = []
  await bootHost({
    credentials: credentials3,
    settings: {
      configure() { return () => {} },
      describe() { return [{ ns: 'mimo-vision', user: { model: 'user-choice' } }] },
      async update(ns, patch) { third.push(patch) },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  eq('不覆盖已有密钥', credentials3.store.get('MIMO_VISION_API_KEY'), 'sk-existing')
  eq('不覆盖已有字段', third.length === 0 || third[0].model === undefined, true)
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main() {
  console.log('══ MiMo 视觉识别 · 冒烟测试 ══')
  console.log(`包目录：${PKG_ROOT}`)
  await testClientHalf()
  await testHostSurface()
  await testFetchErrorMapping()
  await testApiKeyOrder()
  await testLegacyMigration()

  console.log(`\n结果：${passes.length} 通过，${failures.length} 失败`)
  if (failures.length > 0) {
    console.error('\n失败项：')
    for (const item of failures) console.error(`  - ${item}`)
    process.exit(1)
  }
}

await main()
