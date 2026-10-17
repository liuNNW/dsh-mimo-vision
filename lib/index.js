/**
 * MiMo 视觉识别 —— 宿主半。
 *
 * 提供三件事：
 *
 * 1. **同源 HTTP 面** `/mimo-vision/api/*`：给浏览器半的设置页（读写配置、测试连接）
 *    和发送拦截（暂存图片）用。走 webServer 的 prefix 路由，与 dsh-better-sidebar
 *    的 `/sidebar/api` 同机制。webServer 缺失时插件其余功能照常工作。
 * 2. **全局工具** `mimo_analyze_image`：任意会话可分析本地路径 / URL / data URL。
 * 3. **`agent/pre-step` 注入**：浏览器半把发送时的图片暂存在这里，本插件在模型
 *    调用前逐张识别，把结果作为一条插件来源的用户消息插进本次步骤上下文。
 *
 * 回退契约（绝不静默吞图）：未配置密钥 / 自动识别关闭 / 插件未加载 / MiMo 调用
 * 失败，都让 DSH 走原生流程，保留「当前模型不支持图片」提示。
 *
 * 与 0.2.x 内核对齐的几个要点（0.2.2 及更早版本在这里踩过坑）：
 *   - 消息来源必须是 `plugin:<包名>`，裸 `kind: 'plugin'` 会被 session 格式 v4 拒收；
 *   - 凭据服务是可选的，`ctx.get('credentials')` 拿不到时退到环境变量；
 *   - **本文件不 import 任何 `@deepseek-ai/*` 包**。profile 里安装的插件按 Node 的
 *     目录查找解析这些名字，命中的是 `~/.dsh/profiles/node_modules` 那批 junction，
 *     它们指向 npm 全局 dsh 的**旧副本**；桌面版内核在 app.asar 里，两者版本可以
 *     差一个 minor。早期版本 `import { defineTool }`、`import { credentialRef }`
 *     就是踩在这条裂缝上：升级后被解析到形状不同的旧模块。
 *     现在工具定义直接用 `ctx.tools.register()` 接受的 JSON 形态提交，零内核 import。
 *
 * @module dsh-mimo-vision
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import {
  CONFIG_DEFAULTS,
  CONFIG_FIELDS,
  DEFAULT_API_KEY_REF,
  IMAGE_LIMITS,
  IMAGE_MEDIA_TYPES,
  LEGACY_CONFIG_REF,
  PENDING_TTL_MS,
  SETTINGS_NAMESPACE,
  name as pluginName,
  normalizeConfig,
  persistentConfig,
} from './config.js'
import { analyzeImage, listModels, measureBrowserImage, resolveApiKey } from './mimo.js'

export const name = pluginName

/**
 * 必需服务。
 * `tools` 必须在列：不声明 inject 就用 `ctx.tools` 会在加载时报
 * `cannot get property "tools" without inject`，进而让整棵插件树 FAILED。
 * `webServer` 与 `credentials` 故意不列在这里：它们是可选增强，缺了也要能启动。
 */
export const inject = ['tools']

/** HTTP 面挂载前缀。 */
const ROUTE_PREFIX = '/mimo-vision/api'

/**
 * 注入消息的来源标签。
 *
 * session 格式 v4 拒绝裸 `kind: 'plugin'`，要求生产方自带命名空间：
 * `plugin:<包名>`。缺了它，注入内容会在历史里被当成用户输入渲染。
 */
const PLUGIN_SOURCE = Object.freeze({ kind: `plugin:${pluginName}`, form: 'notice', summary: 'MiMo 视觉识别结果' })

/**
 * 全局工具 `mimo_analyze_image` 的 JSON Schema 参数。
 *
 * `ctx.tools.register()` 接受的就是这份「参数即 JSON Schema」的形态；早期版本
 * 依赖内核的 `defineTool()` 去编译一个属性映射，那条 import 在 profile 安装形态下
 * 会解析到旧版内核模块，升级即失效。
 */
const ANALYZE_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    image: { type: 'string', description: '本地图片绝对路径、http(s) 图片 URL，或 data:image/...;base64,... 数据。' },
    prompt: { type: 'string', description: '针对该图片的具体问题或分析要求（可选，缺省用设置页的默认提示词）。' },
    model: { type: 'string', description: 'MiMo 模型名称（可选，缺省用设置页选择的模型）。' },
    maxTokens: { type: 'integer', description: '最大输出 token 数（可选，缺省用设置页配置值）。' },
  },
  required: ['image'],
})

/**
 * 全局工具的输出 schema。
 *
 * 内核的 `assertSupportedJsonSchema` 只接受标准 JSON Schema：属性级不能写
 * `required: true`（那是输入侧参数 spec 的写法），必填与否只由顶层 `required`
 * 数组表达。
 */
const ANALYZE_OUTPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    description: { type: 'string' },
    model: { type: 'string' },
    usage: { type: 'object', additionalProperties: true },
    error: { type: 'string' },
  },
  required: ['ok'],
})

/**
 * 装一个插件实例。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {unknown} [rawConfig] - Loader 传入的配置（可选）。
 */
export function apply(ctx, rawConfig) {
  /** 运行期配置：初值来自 Loader，之后由设置页通过 HTTP 面改写。 */
  let current = normalizeConfig(rawConfig)

  /** sessionId → {images, prompt, at}：发送时暂存，pre-step 时消费。 */
  const pending = new Map()

  /** 持久化配置文件路径。 */
  const configPath = join(dshHome(), '.dsh-mimo-vision.json')

  const readConfig = () => current

  // 启动时把磁盘上用户保存的配置叠加进来（Loader 配置作为基线）。
  loadStoredConfig(configPath).then((stored) => {
    if (stored !== undefined) current = normalizeConfig({ ...current, ...stored })
  }).catch((error) => {
    ctx.logger?.warn?.(`mimo-vision: 读取本地配置失败（使用默认值）：${errorText(error)}`)
  })

  // ---- 1. 同源 HTTP 面 ----
  //
  // webServer 是可选的：走 ctx.inject 让插件在没有 HTTP 载体的 profile 里照常激活，
  // 而不是把整棵树拖进 pending。
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => sctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => handleApi(ctx, {
        readConfig,
        writeConfig: async (patch) => {
          current = normalizeConfig({ ...current, ...patch })
          await saveStoredConfig(configPath, persistentConfig(current))
          return current
        },
        configPath,
        pending,
      }, req, res),
    }), 'mimo-vision: HTTP surface')
  })

  // ---- 2. 全局工具 ----
  ctx.effect(() => ctx.tools.register({
    name: 'mimo_analyze_image',
    description: '调用小米 MiMo 模型分析一张图片，返回图片内容的结构化描述（主体、场景、细节、文字等）。支持本地图片绝对路径、http(s) 图片 URL 或 data: URL。需要在 设置 → MiMo 视觉 里先配置模型密钥。',
    parameters: ANALYZE_PARAMETERS,
    output: {
      schema: ANALYZE_OUTPUT,
      render: (_args, value) => {
        const result = value ?? {}
        if (result.ok !== true) return [{ type: 'text', text: `[MiMo 视觉] 分析失败：${result.error ?? '未知错误'}` }]
        const usage = result.usage ? `\n（用量：${JSON.stringify(result.usage)}）` : ''
        return [{ type: 'text', text: `[MiMo 视觉] 模型 ${result.model ?? ''} 的分析结果：\n${result.description ?? ''}${usage}` }]
      },
    },
    execute: async (args, exec) => {
      try {
        const config = readConfig()
        const image = String(args?.image ?? '').trim()
        if (image.length === 0) return { ok: false, error: '缺少 image 参数：请提供本地图片路径、http(s) URL 或 data: URL' }
        const apiKey = await resolveApiKey(ctx, config)
        if (apiKey === undefined) return { ok: false, error: missingKeyMessage(config) }
        const prepared = await prepareImage(image)
        if (prepared.error !== undefined) return { ok: false, error: prepared.error }
        if (prepared.bytes > IMAGE_LIMITS.maxImageBytes) {
          return { ok: false, error: `图片过大（${humanBytes(prepared.bytes)}），上限 ${humanBytes(IMAGE_LIMITS.maxImageBytes)}` }
        }
        const outcome = await analyzeImage({
          baseUrl: config.baseUrl,
          apiKey,
          model: String(args?.model ?? '').trim() || config.model,
          imageUrl: prepared.url,
          prompt: typeof args?.prompt === 'string' && args.prompt.trim().length > 0 ? args.prompt : config.defaultPrompt,
          systemPrompt: config.systemPrompt,
          maxTokens: Number.isFinite(args?.maxTokens) ? args.maxTokens : config.maxTokens,
          temperature: config.temperature,
          signal: exec?.signal,
        })
        if (outcome.ok !== true) return { ok: false, error: outcome.error }
        return { ok: true, description: outcome.description, model: outcome.model, ...(outcome.usage === null ? {} : { usage: outcome.usage }) }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },
  }), 'mimo-vision: mimo_analyze_image tool')

  // ---- 3. 发送带图消息时把识别结果注入本次步骤上下文 ----
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const sessionId = agentKey(agent)
    const entry = sessionId === undefined ? undefined : pending.get(sessionId)
    if (entry === undefined) return next()
    pending.delete(sessionId)
    if (Date.now() - entry.at > PENDING_TTL_MS) return next()

    let note = null
    try {
      const config = readConfig()
      const apiKey = await resolveApiKey(ctx, config)
      if (apiKey === undefined) return next()
      const parts = []
      for (const image of entry.images) {
        if (signal?.aborted === true) throw abortError()
        const outcome = await analyzeImage({
          baseUrl: config.baseUrl,
          apiKey,
          model: config.model,
          imageUrl: `data:${image.mediaType};base64,${image.data}`,
          prompt: entry.prompt.length > 0 ? entry.prompt : config.defaultPrompt,
          systemPrompt: config.systemPrompt,
          maxTokens: config.maxTokens,
          temperature: config.temperature,
          signal,
        })
        if (outcome.ok !== true) {
          note = `【用户上传了图片，但 MiMo 识别失败：${outcome.error}】`
          break
        }
        parts.push(outcome.description)
      }
      if (note === null) note = `【用户上传的图片 · MiMo 视觉识别】\n${parts.join('\n\n')}`
    } catch (error) {
      if (signal?.aborted === true) throw error
      note = `【用户上传了图片，但 MiMo 识别失败：${errorText(error)}】`
    }

    signal?.throwIfAborted?.()
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const injected = {
      id: `mimo-vision-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`,
      role: 'user',
      content: [{ type: 'text', text: note }],
      source: PLUGIN_SOURCE,
    }
    // 紧跟本步骤「已认领的用户消息」之后；没有认领消息时放末尾。
    const claimedIndex = decision.messages.findLastIndex((message) => messages.includes(message))
    const nextMessages = claimedIndex === -1
      ? [...decision.messages, injected]
      : [...decision.messages.slice(0, claimedIndex + 1), injected, ...decision.messages.slice(claimedIndex + 1)]
    return { ...decision, messages: nextMessages }
  }), 'mimo-vision: pre-step context injection')

  // ---- 4. 历史配置一次性迁移 ----
  migrateLegacy(ctx, configPath).catch((error) => {
    ctx.logger?.warn?.(`mimo-vision: 迁移旧配置失败（不影响使用）：${errorText(error)}`)
  })
}

// ─────────────────────────── 配置文件 ───────────────────────────

/**
 * DSH 家目录。
 * @returns {string} 目录路径。
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * 读磁盘上的用户配置。
 * @param {string} path - 配置文件路径。
 * @returns {Promise<object | undefined>} 解析后的对象；文件不存在或损坏时 undefined。
 */
async function loadStoredConfig(path) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 原子写用户配置。
 * @param {string} path - 配置文件路径。
 * @param {object} value - 要写入的配置。
 * @returns {Promise<void>} 完成。
 */
async function saveStoredConfig(path, value) {
  const { writeFile, rename, mkdir } = await import('node:fs/promises')
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temp, path)
}

// ─────────────────────────── 工具函数 ───────────────────────────

/**
 * 取 agent 的会话 id。
 * @param {unknown} agent - agent 对象。
 * @returns {string | undefined} 会话 id。
 */
function agentKey(agent) {
  const id = agent?.id ?? agent?.sessionId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** 从扩展名推 MIME。 */
const MIME_BY_EXT = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
})

/**
 * 把图片来源归一成 `image_url` 的值。
 * @param {string} image - 来源。
 * @returns {Promise<{url: string, bytes: number} | {error: string}>} 结果。
 */
async function prepareImage(image) {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(image)) {
    const comma = image.indexOf(',')
    return { url: image, bytes: Math.floor(((image.length - comma - 1) * 3) / 4) }
  }
  if (/^https?:\/\//i.test(image)) return { url: image, bytes: 0 }
  try {
    const bytes = await readFile(image)
    const ext = extname(image).replace('.', '').toLowerCase()
    const mediaType = MIME_BY_EXT[ext] ?? 'application/octet-stream'
    return { url: `data:${mediaType};base64,${bytes.toString('base64')}`, bytes: bytes.byteLength }
  } catch (error) {
    return { error: `读取本地图片失败：${errorText(error)}` }
  }
}

/** 未配置密钥时的统一提示。 */
function missingKeyMessage(config) {
  return `未配置 MiMo 模型密钥：请到 设置 → MiMo 视觉 里填写，或把环境变量 ${config.apiKeyEnv} 设为密钥。`
}

/** 任意抛出物转文本。 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 造一个取消错误。 */
function abortError() {
  const error = new Error('mimo-vision: aborted')
  error.name = 'AbortError'
  return error
}

/** 字节数的人读文本。 */
function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ─────────────────────────── HTTP 面 ───────────────────────────

/**
 * `/mimo-vision/api/*` 的处理器：只接受 POST + JSON。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} deps - 依赖集合。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @returns {Promise<void>} 完成。
 */
async function handleApi(ctx, deps, req, res) {
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const method = url.pathname.startsWith(`${ROUTE_PREFIX}/`) ? url.pathname.slice(ROUTE_PREFIX.length + 1) : ''
  if (method.length === 0 || method.includes('/')) {
    send(res, 404, { ok: false, error: 'unknown mimo-vision api method' })
    return
  }
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  try {
    const body = await readJsonBody(req, IMAGE_LIMITS.maxRequestBytes)
    const config = deps.readConfig()
    switch (method) {
      case 'status':
        send(res, 200, await statusPayload(ctx, config, deps.configPath))
        return
      case 'save':
        send(res, 200, await savePayload(ctx, deps, body))
        return
      case 'fields':
        send(res, 200, { ok: true, fields: CONFIG_FIELDS, defaults: CONFIG_DEFAULTS })
        return
      case 'test':
        send(res, 200, await testPayload(ctx, config))
        return
      case 'prepare':
        send(res, 200, preparePayload(config, deps.pending, body))
        return
      case 'analyze':
        send(res, 200, await analyzePayload(ctx, config, body))
        return
      default:
        send(res, 404, { ok: false, error: `unknown mimo-vision api method "${method}"` })
    }
  } catch (error) {
    send(res, 200, { ok: false, error: errorText(error) })
  }
}

/**
 * `status`：设置页首屏要知道「密钥是否已配置」「自动识别开关」。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 上下文。
 * @param {object} config - 归一化配置。
 * @param {string} configPath - 配置文件路径。
 * @returns {Promise<object>} 结果。
 */
async function statusPayload(ctx, config, configPath) {
  const credentials = ctx.get('credentials')
  let configured = typeof config.apiKey === 'string' && config.apiKey.length > 0
  if (!configured && credentials !== undefined) {
    try {
      const described = await credentials.describe(config.apiKeyEnv)
      configured = described?.configured === true
    } catch {
      configured = false
    }
  }
  const value = { ...config }
  // 密钥字面值绝不出宿主进程。
  delete value.apiKey
  return {
    ok: true,
    configured,
    value,
    apiKeyEnv: config.apiKeyEnv,
    configPath,
    fields: CONFIG_FIELDS,
    defaults: CONFIG_DEFAULTS,
  }
}

/**
 * `save`：把设置页的表单值写回。
 *
 * 密钥单独处理：`apiKey` 若给出非空值就写进凭据服务（或本地配置兜底），
 * 留空表示「保持当前密钥」——与内核内置的网页搜索设置同一套语义。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 上下文。
 * @param {object} deps - 依赖集合。
 * @param {object} body - 请求体。
 * @returns {Promise<object>} 结果。
 */
async function savePayload(ctx, deps, body) {
  const patch = body?.value !== null && typeof body?.value === 'object' ? body.value : body ?? {}
  /** @type {Record<string, unknown>} */
  const next = {}
  for (const field of CONFIG_FIELDS) {
    if (!Object.hasOwn(patch, field.key)) continue
    next[field.key] = patch[field.key]
  }

  const secret = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
  let secretSaved = false
  if (secret.length > 0) {
    const ref = typeof next.apiKeyEnv === 'string' && next.apiKeyEnv.trim().length > 0
      ? next.apiKeyEnv.trim()
      : deps.readConfig().apiKeyEnv || DEFAULT_API_KEY_REF
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        // 凭据服务把字符串当不透明引用名，不需要内核的品牌类型包装。
        await credentials.set(ref, secret)
        secretSaved = true
      } catch (error) {
        ctx.logger?.warn?.(`mimo-vision: 写入凭据失败，退回本地配置：${errorText(error)}`)
      }
    }
    if (!secretSaved) next.apiKey = secret
  }

  const value = await deps.writeConfig(next)
  return { ok: true, value: redact(value), secretSaved }
}

/** 去掉密钥字面值，供响应回传。 */
function redact(config) {
  const value = { ...config }
  delete value.apiKey
  return value
}

/**
 * `test`：拉一次模型列表，顺便告诉用户密钥/地址/模型名是否可用。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 上下文。
 * @param {object} config - 归一化配置。
 * @returns {Promise<object>} 结果。
 */
async function testPayload(ctx, config) {
  const apiKey = await resolveApiKey(ctx, config)
  if (apiKey === undefined) return { ok: false, error: missingKeyMessage(config) }
  const outcome = await listModels({ apiKey, baseUrl: config.baseUrl })
  if (outcome.ok !== true) return { ok: false, error: outcome.error }
  return { ok: true, models: outcome.models }
}

/**
 * `prepare`：浏览器半发送前把图片与提示词暂存到这里，等 pre-step 消费。
 * @param {object} config - 归一化配置。
 * @param {Map<string, object>} pending - 暂存表。
 * @param {object} body - 请求体。
 * @returns {object} 结果。
 */
function preparePayload(config, pending, body) {
  const sessionId = String(body?.sessionId ?? '').trim()
  if (sessionId.length === 0) return { ok: false, error: '缺少 sessionId' }
  const raw = Array.isArray(body?.images) ? body.images : []
  const images = []
  let total = 0
  for (const item of raw) {
    const measured = measureBrowserImage(item)
    if (measured.error !== undefined) return { ok: false, error: measured.error }
    if (!IMAGE_MEDIA_TYPES.includes(measured.mediaType)) return { ok: false, error: `不支持的图片类型：${measured.mediaType}` }
    if (measured.bytes > IMAGE_LIMITS.maxImageBytes) {
      return { ok: false, error: `单张图片过大（${humanBytes(measured.bytes)}），上限 ${humanBytes(IMAGE_LIMITS.maxImageBytes)}` }
    }
    total += measured.bytes
    images.push({ mediaType: measured.mediaType, data: String(item.data).replace(/[\r\n]/g, '') })
  }
  if (images.length === 0) return { ok: false, error: '没有可识别的图片' }
  if (images.length > IMAGE_LIMITS.maxCount) return { ok: false, error: `一次最多 ${IMAGE_LIMITS.maxCount} 张图片` }
  if (total > IMAGE_LIMITS.maxTotalBytes) {
    return { ok: false, error: `图片总量过大（${humanBytes(total)}），上限 ${humanBytes(IMAGE_LIMITS.maxTotalBytes)}` }
  }
  const now = Date.now()
  for (const [key, value] of pending) if (now - value.at > PENDING_TTL_MS) pending.delete(key)
  pending.set(sessionId, {
    images,
    prompt: typeof body?.prompt === 'string' ? body.prompt : '',
    at: now,
  })
  return { ok: true, count: images.length }
}

/**
 * `analyze`：给设置页的「试一下」用。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 上下文。
 * @param {object} config - 归一化配置。
 * @param {object} body - 请求体。
 * @returns {Promise<object>} 结果。
 */
async function analyzePayload(ctx, config, body) {
  const source = typeof body?.dataUrl === 'string' && body.dataUrl.length > 0
    ? body.dataUrl
    : typeof body?.path === 'string' && body.path.length > 0
      ? body.path
      : typeof body?.url === 'string' && body.url.length > 0
        ? body.url
        : ''
  if (source.length === 0) return { ok: false, error: '缺少 dataUrl / path / url' }
  const apiKey = await resolveApiKey(ctx, config)
  if (apiKey === undefined) return { ok: false, error: missingKeyMessage(config) }
  const prepared = await prepareImage(source)
  if (prepared.error !== undefined) return { ok: false, error: prepared.error }
  const outcome = await analyzeImage({
    baseUrl: config.baseUrl,
    apiKey,
    model: typeof body?.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : config.model,
    imageUrl: prepared.url,
    prompt: typeof body?.prompt === 'string' && body.prompt.trim().length > 0 ? body.prompt : config.defaultPrompt,
    systemPrompt: config.systemPrompt,
    maxTokens: Number.isFinite(body?.maxTokens) ? body.maxTokens : config.maxTokens,
    temperature: config.temperature,
  })
  return outcome.ok === true
    ? { ok: true, description: outcome.description, model: outcome.model, usage: outcome.usage }
    : { ok: false, error: outcome.error }
}

/**
 * 读一个带体积上限的 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {number} limit - 字节上限。
 * @returns {Promise<object>} 解析后的对象。
 */
async function readJsonBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error(`请求体过大（上限 ${humanBytes(limit)}）`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {object} payload - 负载。
 */
function send(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

// ─────────────────────── 历史配置迁移 ───────────────────────

/**
 * 把旧版 `MIMO_VISION_CONFIG`（一段 JSON 字符串）迁移成本地配置文件 + 独立密钥引用。
 * 幂等：迁移过一次即无动作。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {string} configPath - 配置文件路径。
 * @returns {Promise<void>} 完成。
 */
async function migrateLegacy(ctx, configPath) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return
  let resolved
  try {
    resolved = await credentials.resolve(LEGACY_CONFIG_REF)
  } catch {
    return
  }
  const raw = resolved === undefined || resolved === null ? undefined : resolved.value
  if (typeof raw !== 'string' || raw.trim().length === 0) return

  let legacy = null
  try {
    legacy = JSON.parse(raw)
  } catch {
    return
  }
  if (legacy === null || typeof legacy !== 'object') return
  // 历史 bug：真正的配置可能被嵌在内层 config 里。
  const source = legacy.config !== null && typeof legacy.config === 'object' ? legacy.config : legacy

  // ① 密钥：只在目标 ref 尚未配置时搬过去，绝不覆盖用户已经填好的密钥。
  const targetRef = DEFAULT_API_KEY_REF
  try {
    const existing = await credentials.describe(targetRef)
    if (existing?.configured !== true && typeof source.apiKey === 'string' && source.apiKey.trim().length > 0) {
      await credentials.set(targetRef, source.apiKey.trim())
    }
  } catch {
    // 密钥没搬成功也能继续搬其余字段。
  }

  // ② 其余字段：只补齐磁盘上还没保存过的项。
  if (!(await fileExists(configPath))) {
    await saveStoredConfig(configPath, persistentConfig({ ...source, apiKey: '' }))
  }

  // ③ 字段搬完后清理旧引用。
  try {
    await credentials.unset(LEGACY_CONFIG_REF)
  } catch {
    // 清理失败不影响使用。
  }
}

/** 文件是否存在。 */
async function fileExists(path) {
  try {
    const { access } = await import('node:fs/promises')
    await access(path)
    return true
  } catch {
    return false
  }
}
