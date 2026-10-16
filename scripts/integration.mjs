#!/usr/bin/env node
/**
 * MiMo 视觉识别 —— 行为集成测试（不启动 dsh，不联网）。
 *
 * 覆盖两条最容易写错、也最影响体感的链路：
 *
 *   [A] 宿主 `agent/pre-step` 注入：
 *       发送时暂存的图片 → 调 MiMo → 把结果作为一条 source.kind==='plugin' 的用户
 *       消息插到「已认领消息」之后。同时验证：
 *         · 识别失败时插一条失败说明（不静默吞图，也不让整步崩掉）；
 *         · 未配置密钥时一声不响地放行（回退原生），不注入任何东西；
 *         · 暂存是一次性的（第二次 pre-step 不再注入）；
 *         · 取消信号会向上传播。
 *
 *   [B] 客户端发送拦截：
 *       用假 conversation 服务装一次拦截，验证：
 *         · 开启自动识别 + 已配置密钥 + 带图 → 先 POST prepare，再以「剔除图片后的
 *           附件 id」调用原始 sendSession，并释放图片草稿；
 *         · 关闭自动识别 / 未配置密钥 / prepare 失败 / 无图 → 一字不改地走原始调用；
 *         · conversation.sendSession 抛错也回退，不把异常抛给用户；
 *         · 卸载时恢复原始方法。
 *
 * 用法（cwd 必须在 profile 目录下）：
 *   cd %USERPROFILE%\.dsh\profiles\desktop
 *   node "<仓库>/mimo-vision-plugin/scripts/integration.mjs"
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '..')

const failures = []
const passes = []

/**
 * 一棵极简的元素树。
 *
 * 官方组件的真实实现（Switch / Button / Pill / SettingsValueField …）无法在本
 * 离线脚本里加载 —— 它们在 asar 里、且依赖 react-dom。所以这里造一个「同名桩」：
 * 桩元素带 `stubName`，断言据此在渲染树里**按组件名**统计（例如「树里出现
 * Switch 且没有 checkbox」），同时保留组件自己的子树以便穿透到底层 host 标签。
 */
function stubComponent(name) {
  const Stub = () => null
  Stub.__stubName = name
  return Stub
}

function makeElement(type, props, children) {
  const flat = []
  for (const child of children ?? []) {
    if (Array.isArray(child)) flat.push(...child.flat(Infinity))
    else if (child !== null && child !== undefined && child !== false) flat.push(child)
  }
  const stubName = typeof type === 'function' && typeof type.__stubName === 'string' ? type.__stubName : undefined
  return { type, stubName, props: props ?? {}, children: flat }
}

/**
 * 展开一棵元素树：函数组件按位置路径生成 hook 帧后执行，宿主标签原样保留。
 *
 * 桩组件同时被标记（`stubName`）并保留子树，因此两件事都能断言：
 * 「用了哪个官方组件」与「它下面渲染出了什么 host 标签」。
 * @param {object} node - 待展开的元素。
 * @param {string} path - 该节点在树里的位置路径。
 * @param {object} runtime - hook 运行时。
 * @returns {object|null} 展开后的元素。
 */
function expand(node, path, runtime) {
  if (typeof node === 'string' || typeof node === 'number') return node
  if (node === null || node === undefined || typeof node !== 'object') return null
  const { type, stubName, props, children } = node
  if (typeof type === 'function' && stubName === undefined) {
    const childProp = children.length === 1 ? children[0] : children
    const rendered = runtime.runAt(path, () => type({ ...props, children: childProp }))
    return expand(rendered, path, runtime)
  }
  const nextChildren = []
  children.forEach((child, index) => {
    const expanded = expand(child, `${path}.${index}`, runtime)
    if (expanded !== null) nextChildren.push(expanded)
  })
  return { type, stubName, props, children: nextChildren }
}

/** 渲染树里某桩组件名出现的所有元素。 */
function collectStubs(node, stubName, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (node.stubName === stubName) out.push(node)
  for (const child of node.children ?? []) collectStubs(child, stubName, out)
  return out
}

/** 渲染树里所有 host 标签名（字符串 type）。 */
function collectHostTags(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (typeof node.type === 'string') out.push(node.type)
  for (const child of node.children ?? []) collectHostTags(child, out)
  return out
}

/** 渲染树里所有元素展平（用于按属性找控件）。 */
function collectAll(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) collectAll(child, out)
  return out
}

/** 元素是「宿主 input 且 type=checkbox」吗。 */
function isCheckboxInput(node) {
  return node?.type === 'input' && node?.props?.type === 'checkbox'
}

/**
 * 极简 hook 运行时：够 `useState` 用，好让「ⓘ 展开」这类交互在离线脚本里可见。
 *
 * 帧按组件位置（路径）持久化，所以 setter 触发重渲染后状态还在 —— 与 React 的
 * 「同位置即同一实例」一致。这是为了断言而存在的最小实现，不追求通用。
 */
function createHookRuntime() {
  const frames = new Map()
  const stack = []
  let rerender = () => {}

  const useState = (initial) => {
    const frame = stack[stack.length - 1]
    const index = frame.cursor++
    if (!(index in frame.hooks)) frame.hooks[index] = typeof initial === 'function' ? initial() : initial
    return [frame.hooks[index], (next) => {
      frame.hooks[index] = typeof next === 'function' ? next(frame.hooks[index]) : next
      rerender()
    }]
  }

  /**
   * 在指定路径的帧里跑一次组件函数。
   * @param {string} key - 组件位置路径。
   * @param {Function} fn - 组件函数体。
   * @returns {object} 组件返回的元素树。
   */
  const runAt = (key, fn) => {
    let frame = frames.get(key)
    if (frame === undefined) {
      frame = { hooks: [], cursor: 0 }
      frames.set(key, frame)
    }
    frame.cursor = 0
    stack.push(frame)
    try {
      return fn()
    } finally {
      stack.pop()
    }
  }

  return {
    useState,
    runAt,
    setRerender(fn) {
      rerender = fn
    },
  }
}

/** 当前渲染器（由 renderSeat 装配；factory 的 react 桩经此取 useState）。 */
let activeHooks = null
function hookState(initial) {
  if (activeHooks === null) return [initial, () => {}]
  return activeHooks.useState(initial)
}

function ok(label) {
  passes.push(label)
  console.log(`  ✔ ${label}`)
}
function fail(label, detail) {
  failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
  console.error(`  ✖ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) ok(label)
  else fail(label, `期望 ${e}，实际 ${a}`)
}

/** 一个合法的最小 PNG（1×1）。 */
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/** 定位 profile 的 node_modules。 */
function profileNodeModules() {
  const cwd = process.cwd()
  if (path.basename(path.dirname(cwd)).toLowerCase() === 'profiles') return path.join(cwd, 'node_modules')
  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE ?? '', '.dsh')
  return path.join(dshHome, 'profiles', 'desktop', 'node_modules')
}

/** 造假凭据服务。 */
function fakeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
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

/** 造宿主假 ctx，会记录注册物。 */
function fakeHostCtx({ credentials }) {
  const registered = { routes: [], tools: [], listeners: [], effects: [] }
  const ctx = {
    logger: { info() {}, warn() {} },
    webServer: { register(route) { registered.routes.push(route); return () => {} } },
    tools: { register(definition) { registered.tools.push(definition); return () => {} } },
    effect(callback) {
      const disposer = callback()
      registered.effects.push(disposer)
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on(name, handler) {
      registered.listeners.push({ name, handler })
      return () => {}
    },
    inject(deps, callback) {
      const child = Object.create(ctx)
      for (const dep of deps) {
        const value = ctx.get(dep)
        if (value === undefined) return () => {}
        child[dep] = value
      }
      const disposer = callback(child)
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'tools') return ctx.tools
      if (name === 'webServer') return ctx.webServer
      return undefined
    },
    _registered: registered,
  }
  return ctx
}

/** 假响应。 */
function fakeResponse() {
  const captured = {}
  return {
    captured,
    writeHead(status) { captured.status = status },
    end(text) { captured.body = JSON.parse(text) },
  }
}

/** 调一次路由。 */
async function callRoute(ctx, method, payload, httpMethod = 'POST') {
  const route = ctx._registered.routes.find((item) => item.path === '/mimo-vision/api')
  const res = fakeResponse()
  const req = {
    method: httpMethod,
    url: `/mimo-vision/api/${method}`,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload ?? {}), 'utf8')
    },
  }
  await route.handler(req, res)
  return res.captured
}

/** 起一个宿主实例并返回它的 pre-step 监听器。 */
async function bootHostWithPreStep({ credentials, config }) {
  const host = await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'index.js')).href)
  const ctx = fakeHostCtx({ credentials })
  host.apply(ctx, config ?? {})
  const listener = ctx._registered.listeners.find((item) => item.name === 'agent/pre-step')
  if (listener === undefined) throw new Error('没有注册 agent/pre-step 监听器')
  return { ctx, listener: listener.handler }
}

/**
 * 造一个「认领了两条用户消息」的 pre-step 决策来源。
 * 真实 loop 的 next() 会返回 {kind:'enter', messages:[...claimed, context]}。
 */
function makeNext(claimedCount) {
  const claimed = []
  for (let index = 0; index < claimedCount; index += 1) {
    claimed.push({ id: `user-${index}`, role: 'user', content: [{ type: 'text', text: `问题 ${index}` }] })
  }
  return {
    claimed,
    next: async () => ({ kind: 'enter', messages: [...claimed, { id: 'context', role: 'user', content: [{ type: 'text', text: '运行时上下文' }] }] }),
  }
}

/**
 * 造一个真实的 AbortSignal。
 *
 * `agent/pre-step` 给的是货真价实的 AbortSignal，插件里也按 instanceof 甄别，
 * 所以测试必须用真的，不能拿鸭子类型顶替 —— 否则测出来的行为不是线上行为。
 * @param {object} [options] - aborted=true 时返回一个已取消的信号。
 * @returns {AbortSignal} 信号。
 */
function fakeSignal({ aborted = false } = {}) {
  const controller = new AbortController()
  if (aborted) controller.abort()
  return controller.signal
}

// ───────────────────────── [A] pre-step 注入 ─────────────────────────

async function testPreStep() {
  console.log('\n[A] 宿主 agent/pre-step 注入')
  const originalFetch = globalThis.fetch
  try {
    // ---- A1. 成功路径 ----
    let seenBodies = []
    globalThis.fetch = async (_url, init) => {
      seenBodies.push(JSON.parse(init.body))
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ model: 'mimo-v2.5-pro', choices: [{ message: { content: '一只橘猫趴在键盘上' } }], usage: { total_tokens: 88 } })
        },
      }
    }
    let boot = await bootHostWithPreStep({ credentials: fakeCredentials({ MIMO_VISION_API_KEY: 'sk-test' }) })
    // 先经 prepare 暂存（模拟客户端发送前的动作）
    let answer = await callRoute(boot.ctx, 'prepare', {
      sessionId: 'session-A',
      images: [{ mediaType: 'image/png', data: ONE_PIXEL_PNG }],
      prompt: '这是什么？',
    })
    eq('prepare 成功', answer.body.ok, true)

    let { next, claimed } = makeNext(1)
    let decision = await boot.listener(
      { agent: { id: 'session-A' }, messages: claimed, signal: fakeSignal() },
      next,
    )
    eq('决策仍是 enter', decision.kind, 'enter')
    eq('消息数 = 原 2 条 + 注入 1 条', decision.messages.length, 3)
    const injected = decision.messages[1]
    if (injected.role === 'user') ok('注入消息 role=user')
    else fail('注入消息 role', String(injected.role))
    eq('注入消息来源', injected.source, { kind: 'plugin', plugin: 'mimo-vision' })
    const text = injected.content[0].text
    if (text.includes('一只橘猫趴在键盘上')) ok('注入内容含 MiMo 描述')
    else fail('注入内容', text)
    if (text.includes('MiMo 视觉识别')) ok('注入内容带识别标记')
    else fail('注入标记', text)
    if (decision.messages[1] === injected && decision.messages[0]?.id === 'user-0') {
      ok('注入位置紧跟已认领消息之后')
    } else {
      fail('注入位置', decision.messages.map((message) => message.id ?? '(注入)').join(' > '))
    }
    const chatCall = seenBodies.find((body) => body.messages?.[1]?.content?.[0]?.type === 'image_url')
    if (chatCall !== undefined) ok('MiMo 请求用 image_url 传图')
    else fail('MiMo 请求体', JSON.stringify(seenBodies))
    if (chatCall !== undefined) eq('MiMo 请求带上用户提示词', chatCall.messages[1].content[1].text, '这是什么？')

    // ---- A2. 一次性：第二次 pre-step 不再注入 ----
    ;({ next, claimed } = makeNext(1))
    decision = await boot.listener({ agent: { id: 'session-A' }, messages: claimed, signal: fakeSignal() }, next)
    eq('暂存是一次性的（第二次不注入）', decision.messages.length, 2)

    // ---- A3. 没有暂存时不干预 ----
    ;({ next, claimed } = makeNext(1))
    decision = await boot.listener({ agent: { id: 'session-unknown' }, messages: claimed, signal: fakeSignal() }, next)
    eq('未知会话原样放行', decision.messages.length, 2)

    // ---- A4. 识别失败 → 插一条失败说明 ----
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      async text() {
        return 'upstream exploded'
      },
    })
    boot = await bootHostWithPreStep({ credentials: fakeCredentials({ MIMO_VISION_API_KEY: 'sk-test' }) })
    await callRoute(boot.ctx, 'prepare', { sessionId: 'session-B', images: [{ mediaType: 'image/png', data: ONE_PIXEL_PNG }] })
    ;({ next, claimed } = makeNext(1))
    decision = await boot.listener({ agent: { id: 'session-B' }, messages: claimed, signal: fakeSignal() }, next)
    eq('失败时仍注入一条消息', decision.messages.length, 3)
    const failureText = decision.messages[1].content[0].text
    if (failureText.includes('识别失败')) ok('失败说明写明「识别失败」')
    else fail('失败说明', failureText)
    if (decision.messages[1].source?.plugin === 'mimo-vision') ok('失败说明也带插件来源')
    else fail('失败说明来源', JSON.stringify(decision.messages[1].source))

    // ---- A5. 未配置密钥 → 静默放行（回退原生） ----
    globalThis.fetch = async () => {
      throw new Error('不应发起请求')
    }
    boot = await bootHostWithPreStep({ credentials: fakeCredentials({}) })
    await callRoute(boot.ctx, 'prepare', { sessionId: 'session-C', images: [{ mediaType: 'image/png', data: ONE_PIXEL_PNG }] })
    ;({ next, claimed } = makeNext(1))
    decision = await boot.listener({ agent: { id: 'session-C' }, messages: claimed, signal: fakeSignal() }, next)
    eq('未配密钥时不注入（回退原生）', decision.messages.length, 2)
    eq('未配密钥时暂存被消费掉', decision.messages.length, 2)

    // ---- A6. 取消 → 向上抛 ----
    globalThis.fetch = async (_url, init) => {
      if (init?.signal?.aborted === true) {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: 'x' } }] }) } }
    }
    boot = await bootHostWithPreStep({ credentials: fakeCredentials({ MIMO_VISION_API_KEY: 'sk-test' }) })
    await callRoute(boot.ctx, 'prepare', { sessionId: 'session-D', images: [{ mediaType: 'image/png', data: ONE_PIXEL_PNG }] })
    ;({ next, claimed } = makeNext(1))
    let threw = false
    try {
      await boot.listener({ agent: { id: 'session-D' }, messages: claimed, signal: fakeSignal({ aborted: true }) }, next)
    } catch (error) {
      threw = error?.name === 'AbortError'
    }
    if (threw) ok('取消信号向上传播')
    else fail('取消信号', '期望抛 AbortError')

    // ---- A7. 多图：逐张识别并拼接 ----
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: `第 ${calls} 张的描述` } }] }) } }
    }
    boot = await bootHostWithPreStep({ credentials: fakeCredentials({ MIMO_VISION_API_KEY: 'sk-test' }) })
    await callRoute(boot.ctx, 'prepare', {
      sessionId: 'session-E',
      images: [
        { mediaType: 'image/png', data: ONE_PIXEL_PNG },
        { mediaType: 'image/png', data: ONE_PIXEL_PNG },
      ],
    })
    ;({ next, claimed } = makeNext(1))
    decision = await boot.listener({ agent: { id: 'session-E' }, messages: claimed, signal: fakeSignal() }, next)
    eq('两张图 → 两次请求', calls, 2)
    const multi = decision.messages[1].content[0].text
    if (multi.includes('第 1 张的描述') && multi.includes('第 2 张的描述')) ok('两张描述都拼进注入内容')
    else fail('多图内容', multi)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ───────────────────────── [B] 客户端发送拦截 ─────────────────────────

/**
 * 造一个客户端假 ctx 并执行客户端半的 apply，返回捕获到的拦截面。
 * @param {object} options - conversation 服务、configForms 行为等。
 * @returns {Promise<object>} { conversation, slots, disposed }
 */
async function bootClient(options = {}) {
  const captured = { registrations: [], intervals: [], disposers: [], styles: [] }
  const remote = {
    $on() {
      return () => {}
    },
    credentials: {
      async describe(refs) {
        const out = {}
        for (const ref of refs) {
          out[ref] = (options.credentials ?? {})[ref] ?? { configured: false, writable: true }
        }
        return { ok: true, value: out }
      },
      async set(ref, value) {
        options.credentialWrites?.push({ ref, value })
        return undefined
      },
    },
  }

  /** 共享表单的极简替身：够 SettingsFormModel 用。 */
  const makeScope = () => {
    const listeners = new Set()
    const snapshot = {
      status: 'ready',
      writable: true,
      revision: 1,
      value: {
        apiKeyEnv: 'MIMO_VISION_API_KEY',
        model: 'mimo-v2.5-pro',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        maxTokens: 2048,
        temperature: 0.3,
        defaultPrompt: '描述这张图',
        systemPrompt: '',
        autoConvertImages: options.autoConvertImages !== false,
      },
      base: {},
      user: {},
    }
    return {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async mutate() {
        return options.mutateOk !== false
      },
    }
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') captured.disposers.push(disposer)
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on() {
      return () => {}
    },
    get(name) {
      if (name === 'conversation') return options.conversation
      return undefined
    },
    locale: {
      register() {
        return () => {}
      },
      /** 字典替身：与真实字典同形 —— `testOk`/`statusLine` 取出来要是函数。 */
      bind() {
        return (key, params) => {
          if (key === 'testOk') return (count) => `ok:${count}`
          if (key === 'statusLine') return (configured, apiKeyEnv) => `status-line:${configured}:${apiKeyEnv}`
          if (key === 'description') return 'description'
          void params
          return key
        }
      },
    },
    slots: {
      inject(slot, callback) {
        captured.registrations.push({ slot, callback })
        // 真实实现（ui-renderer 的 Slots.inject）在槽位被声明后会调用 callback；
        // 这里立刻调用，好让 slots.register 的注册物被捕获。
        const off = callback()
        if (typeof off === 'function') captured.disposers.push(off)
        return () => {}
      },
      register(registerOptions, component) {
        captured.registrations.push({ register: registerOptions, component })
        return () => {}
      },
      entries() {
        return []
      },
      getVersion() {
        return 0
      },
      subscribe() {
        return () => {}
      },
    },
    configForms: {
      get() {
        return makeScope()
      },
      whileServed(namespaces, register) {
        captured.registrations.push({ whileServed: namespaces })
        const off = register(new Set(namespaces))
        return typeof off === 'function' ? off : () => {}
      },
    },
    remote,
    timer: {
      interval(callback, delay) {
        captured.intervals.push({ callback, delay })
        return () => {}
      },
    },
  }

  // 让客户端半能被加载：stub 掉 window / document / fetch。
  const capturedModules = []
  globalThis.window = { __ModuleLoader__: { load: (registration) => capturedModules.push(registration) } }
  globalThis.document = {
    baseURI: options.baseURI ?? 'http://127.0.0.1:19387/',
    head: {
      appendChild(node) {
        captured.styles.push(node)
      },
    },
    querySelector() {
      return null
    },
    createElement() {
      return { dataset: {}, textContent: '', remove() {} }
    },
  }
  if (options.fetch !== undefined) globalThis.fetch = options.fetch

  await import(`${pathToFileURL(path.join(PKG_ROOT, 'lib', 'client.js')).href}?t=${Date.now()}`)
  const registration = capturedModules.at(-1)
  const factoryRequire = (specifier) => {
    if (specifier === 'react') {
      return {
        createElement: (type, props, ...children) => makeElement(type, props, children),
        useEffect() {},
        useState: (initial) => hookState(initial),
        useMemo: (fn) => fn(),
      }
    }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        SettingsForm: stubComponent('SettingsForm'),
        SettingsFormModel: class {
          constructor(scope, specs, secrets) {
            this.scope = scope
            this.specs = specs
            this.secrets = secrets
            this.staged = new Map()
          }
          shell() {
            return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
          }
          field(field) {
            const snapshot = this.scope.getSnapshot()
            const value = snapshot.value?.[field]
            return {
              text: value === undefined ? '' : String(value),
              overridden: options.overriddenFields?.includes(field) === true,
              invalid: false,
            }
          }
          bind(project) {
            return { getSnapshot: project, set() {}, subscribe() { return () => {} } }
          }
          actions() {
            const self = this
            return {
              edit() {},
              resetField() {},
              save: () => self.secrets?.[0]?.write('sk-from-form'),
              discard() {},
            }
          }
          dispose() {}
        },
        SettingsSecretField: stubComponent('SettingsSecretField'),
        SettingsValueField: stubComponent('SettingsValueField'),
        Button: stubComponent('Button'),
        Pill: stubComponent('Pill'),
        StateDot: stubComponent('StateDot'),
        Switch: stubComponent('Switch'),
        Tag: stubComponent('Tag'),
        IconInfoOutlineRegular: stubComponent('IconInfoOutlineRegular'),
        settingsNumberField: (field) => ({ field, format: String, parse: () => ({ kind: 'set', value: 1 }) }),
        settingsTextField: (field) => ({ field, format: String, parse: () => ({ kind: 'set', value: 'x' }) }),
      }
    }
    throw new Error(`client half required unexpected module "${specifier}"`)
  }
  const exported = registration.factory(factoryRequire)
  exported.apply(ctx)
  return { ctx, conversation: options.conversation, captured, exported }
}

/** 造一个假 conversation 服务，记录每次 sendSession 的入参。 */
function fakeConversation({ attachments, throws = false } = {}) {
  const calls = []
  const released = []
  const service = {
    async sendSession(session, text, attachmentIds, mode, signal) {
      calls.push({ text, attachmentIds, mode, signal })
      if (throws) throw new Error('boom')
      return { kind: 'success' }
    },
    resolveDraftAttachments(ids) {
      if (attachments === undefined) return []
      return ids.map((id) => attachments[id]).filter(Boolean)
    },
    async encodeImage(file) {
      return { mediaType: 'image/png', data: file.data, name: file.name }
    },
    releaseDraftAttachments(list) {
      released.push(...list)
    },
    _calls: calls,
    _released: released,
  }
  return service
}

async function testClientInterception() {
  console.log('\n[B] 客户端发送拦截')
  const originalFetch = globalThis.fetch
  try {
    // ---- B1. 正路：带图 + 开关开 + 已配密钥 ----
    let posted = []
    let conversation = fakeConversation({
      attachments: {
        'img-1': { kind: 'image', file: { data: ONE_PIXEL_PNG, name: 'a.png' } },
        'file-1': { kind: 'file', file: { name: 'doc.pdf' } },
      },
    })
    await bootClient({
      conversation,
      credentials: { MIMO_VISION_API_KEY: { configured: true, writable: true } },
      fetch: async (url, init) => {
        posted.push({ url: String(url), body: JSON.parse(init.body) })
        if (String(url).endsWith('prepare')) {
          return { ok: true, status: 200, async json() { return { ok: true, count: 1 } } }
        }
        return { ok: true, status: 200, async json() { return { ok: true } } }
      },
    })
    // 等 readStatus 的微任务跑完（controller 首屏会读一次凭据）
    await new Promise((resolve) => setTimeout(resolve, 20))
    const result = await conversation.sendSession({ sessionId: 's1' }, '这张图是什么？', ['img-1', 'file-1'], 'queue', undefined)
    eq('原始 sendSession 返回值透传', result, { kind: 'success' })
    eq('原始 sendSession 被调用一次', conversation._calls.length, 1)
    eq('剔除图片后的附件 id', conversation._calls[0].attachmentIds, ['file-1'])
    eq('文本原样带过', conversation._calls[0].text, '这张图是什么？')
    const prepareCall = posted.find((item) => item.url.endsWith('prepare'))
    if (prepareCall !== undefined) ok('发出了 prepare 请求')
    else fail('prepare 请求', JSON.stringify(posted.map((item) => item.url)))
    eq('prepare 的 sessionId', prepareCall?.body?.sessionId, 's1')
    eq('prepare 带 1 张图', prepareCall?.body?.images?.length, 1)
    eq('prepare 的 prompt', prepareCall?.body?.prompt, '这张图是什么？')
    if (String(prepareCall?.url).includes('mimo-vision/api/prepare')) ok('prepare 走的是 /mimo-vision/api 前缀')
    else fail('prepare URL', String(prepareCall?.url))
    eq('图片草稿被释放', conversation._released.length, 1)
    eq('释放的是图片而非文件', conversation._released[0]?.kind, 'image')

    // ---- B2. 开关关闭 → 原样放行 ----
    conversation = fakeConversation({ attachments: { 'img-1': { kind: 'image', file: {} } } })
    await bootClient({
      conversation,
      autoConvertImages: false,
      credentials: { MIMO_VISION_API_KEY: { configured: true, writable: true } },
      fetch: async () => {
        throw new Error('不应请求')
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await conversation.sendSession({ sessionId: 's1' }, 'text', ['img-1'], 'queue')
    eq('开关关闭 → 附件原样带过', conversation._calls[0].attachmentIds, ['img-1'])

    // ---- B3. 未配置密钥 → 原样放行 ----
    conversation = fakeConversation({ attachments: { 'img-1': { kind: 'image', file: {} } } })
    await bootClient({
      conversation,
      credentials: {},
      fetch: async () => {
        throw new Error('不应请求')
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await conversation.sendSession({ sessionId: 's1' }, 'text', ['img-1'], 'queue')
    eq('未配密钥 → 附件原样带过', conversation._calls[0].attachmentIds, ['img-1'])

    // ---- B4. prepare 失败 → 原样放行 ----
    conversation = fakeConversation({ attachments: { 'img-1': { kind: 'image', file: { data: ONE_PIXEL_PNG } } } })
    await bootClient({
      conversation,
      credentials: { MIMO_VISION_API_KEY: { configured: true, writable: true } },
      fetch: async () => ({ ok: true, status: 200, async json() { return { ok: false, error: '宿主拒绝' } } }),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await conversation.sendSession({ sessionId: 's1' }, 'text', ['img-1'], 'queue')
    eq('prepare 失败 → 附件原样带过', conversation._calls[0].attachmentIds, ['img-1'])
    eq('prepare 失败 → 不释放草稿', conversation._released.length, 0)

    // ---- B5. 无图 → 完全不插手 ----
    conversation = fakeConversation({ attachments: { 'file-1': { kind: 'file', file: {} } } })
    await bootClient({
      conversation,
      credentials: { MIMO_VISION_API_KEY: { configured: true, writable: true } },
      fetch: async () => {
        throw new Error('不应请求')
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await conversation.sendSession({ sessionId: 's1' }, 'text', ['file-1'], 'queue')
    eq('无图 → 不请求宿主', conversation._calls[0].attachmentIds, ['file-1'])

    // ---- B6. 空文本 → 补一句默认提示 ----
    conversation = fakeConversation({ attachments: { 'img-1': { kind: 'image', file: { data: ONE_PIXEL_PNG } } } })
    posted = []
    await bootClient({
      conversation,
      credentials: { MIMO_VISION_API_KEY: { configured: true, writable: true } },
      fetch: async (url, init) => {
        posted.push({ url: String(url), body: JSON.parse(init.body) })
        return { ok: true, status: 200, async json() { return { ok: true, count: 1 } } }
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await conversation.sendSession({ sessionId: 's1' }, '   ', ['img-1'], 'queue')
    const body = posted.find((item) => item.url.endsWith('prepare'))?.body
    if (typeof body?.prompt === 'string' && body.prompt.length > 0) ok('空文本时补默认提示词')
    else fail('空文本处理', JSON.stringify(body))
    eq('空文本时消息正文也用默认提示', conversation._calls[0].text, '请识别这张图片并回复我。')

    // ---- B7. 原始 sendSession 抛错 → 不吞异常 ----
    conversation = fakeConversation({ attachments: { 'img-1': { kind: 'image', file: { data: ONE_PIXEL_PNG } } }, throws: true })
    await bootClient({
      conversation,
      credentials: { MIMO_VISION_API_KEY: { configured: true, writable: true } },
      fetch: async () => ({ ok: true, status: 200, async json() { return { ok: true, count: 1 } } }),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    let propagated = false
    try {
      await conversation.sendSession({ sessionId: 's1' }, 'text', ['img-1'], 'queue')
    } catch (error) {
      propagated = String(error?.message) === 'boom'
    }
    if (propagated) ok('原始调用的异常原样抛出')
    else fail('异常传播', '期望抛 boom')

    // ---- B8. 卸载恢复 ----
    const restored = fakeConversation({ attachments: {} })
    const original = restored.sendSession
    const boot = await bootClient({
      conversation: restored,
      credentials: {},
      fetch: async () => ({ ok: true, status: 200, async json() { return { ok: true } } }),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (restored.sendSession !== original) ok('拦截已装上（sendSession 被替换）')
    else fail('拦截安装', 'sendSession 没变')
    for (const dispose of boot.captured.disposers) {
      try {
        dispose()
      } catch {
        // 忽略个别清理失败
      }
    }
    if (restored.sendSession === original) ok('卸载时恢复原始方法')
    else fail('卸载恢复', 'sendSession 未恢复')

    // ---- B9. 座位注册 ----
    conversation = fakeConversation({})
    const boot2 = await bootClient({
      conversation,
      credentials: {},
      fetch: async () => ({ ok: true, status: 200, async json() { return { ok: true } } }),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const slots = boot2.captured.registrations.filter((item) => item.slot !== undefined).map((item) => item.slot)
    if (slots.includes('settings.section')) ok('注册了 settings.section 座位（设置侧栏一页）')
    else fail('settings.section 座位', JSON.stringify(slots))
    if (slots.includes('plugins.item')) ok('注册了 plugins.item 座位（插件页卡片）')
    else fail('plugins.item 座位', JSON.stringify(slots))
    if (!slots.includes('settings.plugin.item')) ok('没有使用已不存在的 settings.plugin.item 槽')
    else fail('槽位', 'rc.6+ 的客户端没有 settings.plugin.item')
    const registered = boot2.captured.registrations.filter((item) => item.register !== undefined).map((item) => item.register)
    const section = registered.find((item) => item.name === 'settings.section')
    eq('设置页 id', section?.id, 'mimo-vision')
    eq('设置页标签', section?.label?.(), 'title')
    const card = registered.find((item) => item.name === 'plugins.item')
    eq('插件页 id', card?.id, 'mimo-vision')
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
}

/**
 * [C] 渲染层：官方组件复用的回归断言。
 *
 * 这一段守的是「不再自己造控件」：把两个座位各自注册的组件真渲染一遍，按组件名
 * 与 CSS 指标核对 —— 用的是内核 0.2.0-rc.2 的真实契约（已从 asar 源码逐条抄下）。
 */
async function testRenderedSurface() {
  console.log('\n[C] 渲染层：官方组件与设计指标')
  const boot = await bootClient({
    credentials: { MIMO_VISION_API_KEY: { configured: true, writable: true } },
    overriddenFields: ['autoConvertImages'],
    fetch: async () => ({ ok: true, status: 200, async json() { return { ok: true, models: [{ id: 'mimo-v2.5-pro' }] } } }),
  })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const registered = boot.captured.registrations.filter((item) => item.register !== undefined)

  /**
   * 取一个座位的完整组件 props：注入面 + 插槽契约要求的 `t` / `useForm`。
   * @param {string} slotName - 槽位名。
   * @param {object} [extra] - 额外 owner props（`view` 等）。
   * @returns {object} 组件 props。
   */
  const seatProps = (slotName, extra = {}) => {
    const entry = registered.find((item) => item.register.name === slotName)
    if (entry === undefined) throw new Error(`未注册座位 ${slotName}`)
    const injected = typeof entry.register.inject === 'function' ? entry.register.inject() : {}
    const store = injected.hooks?.form
    /** 字典替身：statusLine / testOk 要能当函数调用。 */
    const t = (key) => {
      if (key === 'statusLine') return () => 'status'
      if (key === 'testOk') return (count) => `ok:${count}`
      return key
    }
    return {
      entry,
      injected,
      props: {
        view: undefined,
        ...injected,
        t,
        useForm: (selector) => selector(store.getSnapshot()),
        ...extra,
      },
    }
  }

  /**
   * 渲染一个座位并展开成元素树。
   * @param {string} slotName - 槽位名。
   * @param {object} [extra] - 额外 owner props（`view` 等）。
   * @returns {{tree: object, ids: string[]}} 展开后的树与字段 id。
   */
  const renderSeat = (slotName, extra = {}) => {
    const { entry, props } = seatProps(slotName, extra)
    const runtime = createHookRuntime()
    activeHooks = runtime
    try {
      const tree = expand(entry.component(props), `root:${slotName}`, runtime)
      const ids = []
      for (const element of collectAll(tree)) {
        if (typeof element?.props?.id === 'string') ids.push(element.props.id)
      }
      return { tree, ids }
    } finally {
      activeHooks = null
    }
  }

  // 模型候选只有「测试连接」成功后才有内容，先跑一次让 extra.models 落地。
  await seatProps('settings.section').injected.test()
  await new Promise((resolve) => setTimeout(resolve, 20))

  // —— 组件复用 ——
  const section = renderSeat('settings.section')
  const sectionStubs = collectAll(section.tree).map((node) => node.stubName).filter(Boolean)
  if (sectionStubs.includes('Switch')) ok('布尔项用官方 Switch')
  else fail('Switch', JSON.stringify([...new Set(sectionStubs)]))
  if (sectionStubs.includes('SettingsForm')) ok('表单骨架用官方 SettingsForm')
  else fail('SettingsForm', JSON.stringify([...new Set(sectionStubs)]))
  if (sectionStubs.includes('SettingsValueField')) ok('单行字段用官方 SettingsValueField')
  else fail('SettingsValueField', JSON.stringify([...new Set(sectionStubs)]))
  if (sectionStubs.includes('SettingsSecretField')) ok('密钥框用官方 SettingsSecretField')
  else fail('SettingsSecretField', JSON.stringify([...new Set(sectionStubs)]))
  const buttons = collectStubs(section.tree, 'Button')
  if (buttons.length > 0) ok(`「测试连接」用官方 Button（${buttons.length} 个）`)
  else fail('Button', JSON.stringify([...new Set(sectionStubs)]))
  eq('Button variant=outline', buttons[0]?.props?.variant, 'outline')
  eq('Button size=sm', buttons[0]?.props?.size, 'sm')
  const pills = collectStubs(section.tree, 'Pill')
  if (pills.length > 0) ok(`模型候选用官方 Pill（${pills.length} 个）`)
  else fail('Pill', '候选列表未渲染出 Pill')

  // —— 不再有手写 checkbox ——
  const boxy = collectAll(section.tree).filter(isCheckboxInput)
  eq('渲染树里没有 input[type=checkbox]', boxy.length, 0)
  const allTags = collectHostTags(section.tree)
  if (allTags.length > 0) ok(`渲染树展开出 ${allTags.length} 个 host 标签`)

  // —— 两个座位的字段 id 不重叠 ——
  const card = renderSeat('plugins.item', { view: 'page' })
  const overlap = section.ids.filter((id) => card.ids.includes(id))
  eq('两个座位无重复字段 id', overlap, [])
  if (section.ids.length > 0) ok(`字段 id 带实例前缀（${section.ids[0]}）`)
  // 源码层面的兜底：自建 help 区的 id 也必须带实例前缀，不能写死。
  const source = readFileSync(path.join(PKG_ROOT, 'lib', 'client.js'), 'utf8')
  if (!source.includes('`mimo-${field}-help`')) ok('自建 help 区 id 走实例前缀')
  else fail('help 区 id', '布尔行的 help id 写死了，两个座位会撞')

  // —— plugins.item 的 page 视图不再重复渲染说明文字 ——
  const pageText = JSON.stringify(collectAll(card.tree).map((node) => node.children.filter((c) => typeof c === 'string')))
  if (!pageText.includes('description') && !pageText.includes('mimo-pageIntro')) {
    ok('插件页 page 视图不含重复说明文字')
  } else {
    fail('插件页重复描述', pageText.slice(0, 200))
  }
  const summary = seatProps('plugins.item', { view: 'summary' })
  const summaryRuntime = createHookRuntime()
  activeHooks = summaryRuntime
  let summaryTree = null
  try {
    summaryTree = expand(summary.entry.component(summary.props), 'summary', summaryRuntime)
  } finally {
    activeHooks = null
  }
  eq('summary 视图仍返回纯文本', typeof summaryTree, 'string')
}

/** [D] CSS 指标：与内核 settings-form / DeveloperToolsRow 逐项对齐。 */
async function testStylesheet() {
  console.log('\n[D] 样式表：指标与 token')
  const boot = await bootClient({
    credentials: {},
    fetch: async () => ({ ok: true, status: 200, async json() { return { ok: true } } }),
  })
  const css = boot.captured.styles.map((node) => node.textContent).join('\n')
  if (css.length === 0) {
    fail('样式表注入', '没有捕获到 style 节点')
    return
  }
  ok(`捕获到注入的 CSS（${css.length} 字符）`)
  const want = [
    ['字段分隔线 0.5px', 'border-top:.5px solid var(--dsw-alias-border-l2)'],
    ['section max-width 720px', 'max-width:720px'],
    ['标题 16px/500', 'font-size:16px;font-weight:500;line-height:24px'],
    ['简介 14px/22px', 'font-size:14px;line-height:22px'],
    ['成功提示用 success-primary', '.mimo-noteOk{color:var(--dsw-alias-state-success-primary)}'],
    ['提醒用 warn-label', '.mimo-noteWarn{color:var(--dsw-alias-state-warn-label)}'],
    ['help 折叠区 12px/1.6', 'line-height:1.6'],
  ]
  for (const [label, needle] of want) {
    if (css.includes(needle)) ok(label)
    else fail(label, needle)
  }
  const forbidden = [
    ['不再用 state-success-secondary', 'state-success-secondary'],
    ['reset 不带下划线', 'text-decoration:underline'],
    ['不再有手写 checkbox 类', '.mimo-check'],
    ['不再有手写测试按钮类', '.mimo-test'],
    ['不再有手写模型 chip 类', '.mimo-modelChip'],
  ]
  for (const [label, needle] of forbidden) {
    if (!css.includes(needle)) ok(label)
    else fail(label, `仍包含 ${needle}`)
  }
}

/** [E] 文案：zh / en 字典键必须完全对齐（少一个键就是一处英文页面报 key）。 */
async function testDictionaryParity() {
  console.log('\n[E] 文案：zh / en 键对齐')
  const source = readFileSync(path.join(PKG_ROOT, 'lib', 'client.js'), 'utf8')
  const zhStart = source.indexOf('const zh = {')
  const enStart = source.indexOf('const en = {')
  const endMarker = source.indexOf('const settingsBooleanField')
  if (zhStart < 0 || enStart < 0 || endMarker < 0) {
    fail('字典定位', '在 client.js 里找不到 zh / en / settingsBooleanField')
    return
  }
  /** 取一段字典里的顶层键名。 */
  const keysOf = (block) => [...block.matchAll(/^\s{6}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1])
  const zhKeys = keysOf(source.slice(zhStart, enStart))
  const enKeys = keysOf(source.slice(enStart, endMarker))
  const onlyZh = zhKeys.filter((key) => !enKeys.includes(key))
  const onlyEn = enKeys.filter((key) => !zhKeys.includes(key))
  eq('zh 独有键', onlyZh, [])
  eq('en 独有键', onlyEn, [])
  if (zhKeys.length > 0 && onlyZh.length === 0 && onlyEn.length === 0) {
    ok(`zh / en 键完全对齐（各 ${zhKeys.length} 个）`)
  }
  for (const key of ['autoConvertHelp', 'autoConvertHelpLabel', 'switchUnavailable']) {
    if (zhKeys.includes(key) && enKeys.includes(key)) ok(`新增文案 ${key} 双语齐备`)
    else fail(`新增文案 ${key}`, `${key} 缺一侧`)
  }
  // 收短后的文案不应再带 emoji 对勾。
  const zhBlock = source.slice(zhStart, enStart)
  if (!zhBlock.includes('✓')) ok('文案不再使用 ✓ emoji')
  else fail('文案 emoji', 'zh 字典里仍有 ✓')
}

/**
 * [F] 包名一致性：npm 包名 / 客户端模块 id / 补丁 row 的 `name` 必须三方一致，
 * 而 row 的 `id` 必须保持 `mimo-vision`（设置命名空间，与包名解耦）。
 *
 * 这条守的是一个会把「所有插件 UI」打挂的失败模式：客户端产物注册的 id 与包名
 * 不一致时，`ClientModuleLoader.arrive()` 判定 `loaded without registering`，
 * 整个插件面板都报 Failed to load plugins。
 */
async function testPackageIdentity() {
  console.log('\n[F] 包名一致性')
  const manifest = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'))
  const clientSource = readFileSync(path.join(PKG_ROOT, 'lib', 'client.js'), 'utf8')
  const patchText = readFileSync(path.join(PKG_ROOT, 'cordis.patch.yml'), 'utf8')

  ok(`package.json name = ${manifest.name}`)
  const moduleId = /__ModuleLoader__\.load\(\{\s*\n?\s*id:\s*'([^']+)'/.exec(clientSource)?.[1]
  eq('客户端注册 id == 包名', moduleId, manifest.name)
  const patchName = /name:\s*'([^']+)'/.exec(patchText)?.[1]
  eq('补丁 row 的 name == 包名', patchName, manifest.name)
  const patchRowId = /- id:\s*(\S+)/.exec(patchText)?.[1]
  eq('补丁 row 的 id 保持 mimo-vision', patchRowId, 'mimo-vision')
  if (typeof manifest.repository?.url === 'string') ok(`repository = ${manifest.repository.url}`)
  else fail('repository', '缺少 repository 字段')
  if (manifest.name.startsWith('@deepseek-ai/')) {
    fail('包名占用官方 scope', 'npm publish 会被 403 拒绝，且会与官方包冲突')
  } else {
    ok('没有占用官方 @deepseek-ai scope')
  }
}

async function main() {
  console.log('══ MiMo 视觉识别 · 行为集成测试 ══')
  console.log(`包目录：${PKG_ROOT}`)
  console.log(`profile 依赖：${profileNodeModules()}`)
  await testPreStep()
  await testClientInterception()
  await testRenderedSurface()
  await testStylesheet()
  await testDictionaryParity()
  await testPackageIdentity()

  console.log(`\n结果：${passes.length} 通过，${failures.length} 失败`)
  if (failures.length > 0) {
    console.error('\n失败项：')
    for (const item of failures) console.error(`  - ${item}`)
    process.exit(1)
  }
}

await main()
