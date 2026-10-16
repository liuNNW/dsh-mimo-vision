/**
 * MiMo 视觉识别 —— 宿主半。
 *
 * 作为 profile 级永久插件挂载（`dsh plugin --profile <p> add` + 本包的
 * cordis.patch.yml），提供四件事：
 *
 * 1. **原生设置页的数据面**：插件 Config 的每个字段都 `.volatile()`，
 *    @deepseek-ai/dsh-settings 会把它投影成表单；设置页存在
 *    <DSH_HOME>/profiles/<profile>/cordis.patch.yml 的 `- id: mimo-vision`
 *    条目里。密钥不进配置文件，只写凭据引用名（默认 MIMO_VISION_API_KEY）。
 * 2. **同源 HTTP 面** `/mimo-vision/api/*`：给浏览器半的「测试连接」「暂存图片」
 *    用。走 webServer 的 prefix 路由（与 dsh-better-sidebar 的 /sidebar/api 同机制），
 *    不用 typert Remote —— rc.6+ 的客户端只挂载编译期生成的 Remote 清单，
 *    运行时注册的 Remote 命名空间在浏览器侧永远 pending。
 * 3. **全局工具** `mimo_analyze_image`：任意会话可分析本地路径 / URL / data URL。
 * 4. **`agent/pre-step` 注入**：浏览器半把发送时的图片暂存在这里，本插件在
 *    模型调用前逐张识别，把结果作为一条插件来源的用户消息插进本次步骤上下文。
 *
 * 回退契约（绝不静默吞图）：未配置密钥 / 自动识别关闭 / 插件未加载 / MiMo 调用
 * 失败，都让 DSH 走原生流程，保留「当前模型不支持图片」提示。
 *
 * @module dsh-mimo-vision
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  Config,
  DEFAULT_API_KEY_REF,
  IMAGE_LIMITS,
  IMAGE_MEDIA_TYPES,
  LEGACY_CONFIG_REF,
  PENDING_TTL_MS,
  SETTINGS_NAMESPACE,
  name as pluginName,
  normalizeConfig,
} from './config.js'
import { analyzeImage, createLocalImageReader, listModels, measureBrowserImage, resolveApiKey } from './mimo.js'

export const name = pluginName
export { Config }

/**
 * 必需服务。
 *
 * `tools` 必须在列：构造函数式的插件里用 `ctx.tools` 而不声明 inject，会在
 * 加载时报 `cannot get property "tools" without inject`，进而让整棵插件树
 * FAILED（历史版本就是这样把 dsh 启动打挂的）。
 */
export const inject = ['tools', 'webServer', 'credentials']

/** HTTP 面的挂载前缀。 */
const ROUTE_PREFIX = '/mimo-vision/api'

/** 注入消息里的来源标签：没有它，注入内容在历史里会被当成用户输入渲染。 */
const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin', plugin: pluginName })

/**
 * 全局工具 `mimo_analyze_image` 的作者态参数表。
 *
 * 必须是「属性映射」形态（`{字段: 值 schema}`，属性级 `required: true`）：
 * 内核的 defineTool 会把这份映射编译成 JSON Schema，写成
 * `{type:'object',properties,required:[]}` 那种 JSON Schema 形态会让它抛
 * JsonSchemaError（`parameters.type must be a value schema object`），
 * 进而让整棵插件树 FAILED、dsh 起不来。历史版本正是这么挂的。
 *
 * 导出它，是为了让自检脚本能对同一份定义做编译验证。
 */
export const MIMO_ANALYZE_TOOL_PARAMETERS = Object.freeze({
  image: { type: 'string', required: true, description: '本地图片的绝对路径，或 http(s) 开头的图片 URL，或 data:image/...;base64,... 数据。' },
  prompt: { type: 'string', description: '针对该图片的具体问题或分析要求（可选，缺省使用设置页的默认提示词）。' },
  model: { type: 'string', description: 'MiMo 模型名称（可选，缺省使用设置页选择的模型）。' },
  maxTokens: { type: 'integer', description: '最大输出 token 数（可选，缺省使用设置页配置值）。' },
})

/** 全局工具的输出 schema。 */
export const MIMO_ANALYZE_TOOL_OUTPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    description: { type: 'string' },
    model: { type: 'string' },
    usage: { type: 'object', additionalProperties: true },
    error: { type: 'string' },
  },
})

/**
 * 装一个插件实例。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {unknown} rawConfig - Loader 传入的 Config（volatile 引用或普通对象）。
 */
export function apply(ctx, rawConfig) {
  const readConfig = () => normalizeConfig(unwrap(rawConfig))
  const readLocalImage = createLocalImageReader()

  /** sessionId → {images, prompt, at}：发送时暂存，pre-step 时消费。 */
  const pending = new Map()

  // ---- 1. 设置页策略：本插件自带页面，关掉「按 schema 自动生成页面」 ----
  // settings 服务是可选的：没装时插件其余功能照常工作。
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(
      () => sctx.settings.configure({ auto: false }, sctx.fiber),
      'mimo-vision: settings page policy',
    )
  })

  // ---- 2. 同源 HTTP 面 ----
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => handleApi(ctx, readConfig, pending, readLocalImage, req, res),
    }),
    'mimo-vision: HTTP surface',
  )

  // ---- 3. 全局工具 ----
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mimo_analyze_image',
    description: '调用小米 MiMo 模型分析一张图片，返回图片内容的结构化描述（主体、场景、细节、文字等）。支持本地图片绝对路径、http(s) 图片 URL 或 data: URL。需要在 设置 → MiMo 视觉（或 插件 → MiMo 视觉）里先配置模型密钥。',
    parameters: MIMO_ANALYZE_TOOL_PARAMETERS,
    output: {
      schema: MIMO_ANALYZE_TOOL_OUTPUT,
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
        const prepared = await prepareImage(image, readLocalImage)
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
  })), 'mimo-vision: mimo_analyze_image tool')

  // ---- 4. 发送带图消息时把识别结果注入本次步骤上下文 ----
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

  // ---- 5. 历史配置一次性迁移（旧版把整份 JSON 塞在一个凭据里） ----
  migrateLegacy(ctx).catch((error) => {
    ctx.logger?.warn?.('mimo-vision: 迁移旧配置失败（不影响使用）')
    ctx.logger?.warn?.(error)
  })
}

/**
 * Loader 传入的 Config 可能整份都是 volatile 引用（少见），也可能是逐字段引用。
 * 引用形态由 config.js 的 readConfigField 逐个解开；这里只剩「整份是不是一个引用」
 * 这一层兜底。
 *
 * @param {unknown} value - Loader 配置。
 * @returns {object} 可被 normalizeConfig 读取的对象。
 */
function unwrap(value) {
  if (value === undefined || value === null) return {}
  if (typeof value.get === 'function') {
    try {
      return value.get() ?? {}
    } catch {
      return {}
    }
  }
  return value
}

/**
 * 取 agent 的会话 id。
 * @param {unknown} agent - agent 对象。
 * @returns {string | undefined} 会话 id。
 */
function agentKey(agent) {
  const id = agent?.id ?? agent?.sessionId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * 把图片来源归一成 `image_url` 的值。
 * @param {string} image - 来源。
 * @param {(path: string) => Promise<{bytes: Uint8Array, mediaType: string}>} readLocal - 本地读取器。
 * @returns {Promise<{url: string, bytes: number} | {error: string}>} 结果。
 */
async function prepareImage(image, readLocal) {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(image)) {
    const comma = image.indexOf(',')
    return { url: image, bytes: Math.floor(((image.length - comma - 1) * 3) / 4) }
  }
  if (/^https?:\/\//i.test(image)) return { url: image, bytes: 0 }
  try {
    const { bytes, mediaType } = await readLocal(image)
    return { url: `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`, bytes: bytes.byteLength }
  } catch (error) {
    return { error: `读取本地图片失败：${errorText(error)}` }
  }
}

/** 未配置密钥时的统一提示。 */
function missingKeyMessage(config) {
  return `未配置 MiMo 模型密钥：请到 设置 → MiMo 视觉（或 插件 → MiMo 视觉）里填写，或把环境变量 ${config.apiKeyEnv} 设为密钥。`
}

/** 任意抛出物转文本。 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 造一个取消错误（沿用 AbortSignal 语义，让上层按取消处理）。 */
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
 * @param {() => object} readConfig - 读归一化配置。
 * @param {Map<string, object>} pending - 图片暂存表。
 * @param {(path: string) => Promise<{bytes: Uint8Array, mediaType: string}>} readLocalImage - 本地读取器。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @returns {Promise<void>} 完成。
 */
async function handleApi(ctx, readConfig, pending, readLocalImage, req, res) {
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
    const config = readConfig()
    switch (method) {
      case 'status':
        send(res, 200, await statusPayload(ctx, config))
        return
      case 'test':
        send(res, 200, await testPayload(ctx, config))
        return
      case 'prepare':
        send(res, 200, preparePayload(config, pending, body))
        return
      case 'analyze':
        send(res, 200, await analyzePayload(ctx, config, readLocalImage, body))
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
 * @returns {Promise<object>} 结果。
 */
async function statusPayload(ctx, config) {
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
  return {
    ok: true,
    configured,
    apiKeyEnv: config.apiKeyEnv,
    baseUrl: config.baseUrl,
    model: config.model,
    autoConvertImages: config.autoConvertImages,
  }
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
  // 过期条目顺手清掉，避免长时间挂着的会话泄漏内存。
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
 * `analyze`：给设置页的「试一下」用，也可被其他前端调用。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 上下文。
 * @param {object} config - 归一化配置。
 * @param {(path: string) => Promise<{bytes: Uint8Array, mediaType: string}>} readLocalImage - 本地读取器。
 * @param {object} body - 请求体。
 * @returns {Promise<object>} 结果。
 */
async function analyzePayload(ctx, config, readLocalImage, body) {
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
  const prepared = await prepareImage(source, readLocalImage)
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
 * @param {object} payload - 负载（永远带 ok 字段）。
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
 * 把旧版 `MIMO_VISION_CONFIG`（一段 JSON 字符串）迁移成
 * 「Config 字段 + 独立密钥引用」，成功后删掉旧引用。幂等：迁移过一次即无动作。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @returns {Promise<void>} 完成。
 */
async function migrateLegacy(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return
  let resolved
  try {
    resolved = await credentials.resolve(LEGACY_CONFIG_REF)
  } catch (error) {
    ctx.logger?.warn?.(`mimo-vision: 读取旧凭据 ${LEGACY_CONFIG_REF} 失败：${errorText(error)}`)
    return
  }
  const raw = resolved === undefined || resolved === null ? undefined : resolved.value
  if (typeof raw !== 'string' || raw.trim().length === 0) return

  let legacy = null
  try {
    legacy = JSON.parse(raw)
  } catch {
    ctx.logger?.warn?.(`mimo-vision: ${LEGACY_CONFIG_REF} 不是合法 JSON，已跳过迁移`)
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
      await credentials.set(credentialRef(targetRef), source.apiKey.trim())
      ctx.logger?.info?.(`mimo-vision: 已把旧密钥迁移到凭据 ${targetRef}`)
    }
  } catch (error) {
    ctx.logger?.warn?.(`mimo-vision: 迁移旧密钥失败（继续处理其余字段）：${errorText(error)}`)
  }

  // ② 其余字段：只补齐用户没保存过的项。
  const patch = {}
  if (typeof source.baseUrl === 'string' && source.baseUrl.trim().length > 0) patch.baseUrl = source.baseUrl.trim()
  if (typeof source.model === 'string' && source.model.trim().length > 0) patch.model = source.model.trim()
  if (Number.isFinite(source.maxTokens)) patch.maxTokens = Math.trunc(source.maxTokens)
  if (Number.isFinite(source.temperature)) patch.temperature = source.temperature
  if (typeof source.defaultPrompt === 'string' && source.defaultPrompt.length > 0) patch.defaultPrompt = source.defaultPrompt
  if (typeof source.systemPrompt === 'string' && source.systemPrompt.length > 0) patch.systemPrompt = source.systemPrompt
  if (typeof source.autoConvertImages === 'boolean') patch.autoConvertImages = source.autoConvertImages

  const settings = ctx.get('settings')
  let fieldsMigrated = true
  if (settings !== undefined && Object.keys(patch).length > 0) {
    try {
      const current = settings.describe().find((row) => row.ns === SETTINGS_NAMESPACE)
      const user = current?.user !== null && typeof current?.user === 'object' ? current.user : {}
      const missing = Object.fromEntries(Object.entries(patch).filter(([key]) => !Object.hasOwn(user, key)))
      if (Object.keys(missing).length > 0) {
        await settings.update(SETTINGS_NAMESPACE, missing)
        ctx.logger?.info?.('mimo-vision: 已把旧配置迁移到设置页字段')
      }
    } catch (error) {
      // 字段没搬成功就别删旧凭据 —— 那份 JSON 是它们唯一还完整的来源。
      fieldsMigrated = false
      ctx.logger?.warn?.(`mimo-vision: 迁移旧配置字段失败，保留 ${LEGACY_CONFIG_REF} 以便下次重试：${errorText(error)}`)
    }
  }

  // ③ 只有在字段确实搬完（或本就没有字段要搬）时才清理旧引用。
  //    这里必须独立于上面任何一步的成败 —— 否则一次 settings 异常就会让旧凭据
  //    永久留在 .credentials.yaml 里（历史现场就是这样残留的）。
  if (!fieldsMigrated) return
  try {
    await credentials.unset(LEGACY_CONFIG_REF)
    ctx.logger?.info?.(`mimo-vision: 旧凭据 ${LEGACY_CONFIG_REF} 已清理`)
  } catch (error) {
    ctx.logger?.warn?.(`mimo-vision: 清理旧凭据 ${LEGACY_CONFIG_REF} 失败：${errorText(error)}`)
  }
}
