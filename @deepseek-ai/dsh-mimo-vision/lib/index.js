/**
 * MiMo 视觉识别 — 全局插件（宿主端）
 *
 * 作为静态 Cordis 插件行挂载在部署宿主组合（cordis.patch.yml）中：
 * - 提供 Remote 服务 `mimoVision`（TypertRemoteService），设置页客户端经
 *   ctx.remote.mimoVision 调用：configGet / configSet / test / prepare / analyzeData。
 * - 注册全局工具 `mimo_analyze_image`（所有会话可见）。
 * - 监听 agent/pre-step：发送带图片的消息时，把 MiMo 识别结果注入上下文。
 *
 * 本文件为编译后形态（与内置包一致）：装饰器经 __esDecorate 手工展开，
 * 使 Node 22 无需编译即可直接加载。
 * 配置（API Key 等）持久化在部署凭据 CRED_REF = MIMO_VISION_CONFIG。
 * 图片识别由真实 Node 子进程执行（subprocess 服务 + 内嵌 HELPER 脚本）。
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { defineTool } from '@deepseek-ai/dsh-tools';

const CRED_REF = 'MIMO_VISION_CONFIG';
const FALLBACK_NODE = 'C:\\Program Files\\nodejs\\node.exe';
const MODEL_CHOICES = ['mimo-v2.5-pro', 'mimo-v2.5'];
const DEFAULT_CONFIG = {
  apiKey: '',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.5-pro',
  maxTokens: 2048,
  temperature: 0.3,
  defaultPrompt: '请详细描述这张图片的内容，包括主体、场景、细节、文字信息等。',
  systemPrompt: '',
  autoConvertImages: true,
};

// Node helper 脚本：在真实 Node 子进程中读取图片、Base64 编码并调用 MiMo API。
// 注意：此字符串会被 node -e 执行，因此内部不得出现反引号或 ${}。
const HELPER = String.raw`
const fs = require('fs');
const path = require('path');
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  tiff: 'image/tiff', avif: 'image/avif'
};
function emit(v) { process.stdout.write(JSON.stringify(v)); }
function cleanBase(s) { return String(s || '').replace(/\/+$/, ''); }
(async () => {
  try {
    const raw = process.argv[1] || '{}';
    const a = JSON.parse(raw);
    const mode = a.mode || 'analyze';
    const apiKey = process.env.MIMO_API_KEY || '';
    if (!apiKey) { emit({ ok: false, error: 'MIMO_API_KEY 为空' }); return; }
    const base = cleanBase(a.baseUrl);
    const authHeaders = { 'api-key': apiKey, 'Authorization': 'Bearer ' + apiKey };
    if (mode === 'test' || mode === 'models') {
      const resp = await fetch(base + '/models', { headers: authHeaders, signal: AbortSignal.timeout(30000) });
      const text = await resp.text();
      if (!resp.ok) { emit({ ok: false, error: 'HTTP ' + resp.status + ': ' + text.slice(0, 500) }); return; }
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
      const models = list.map(function (m) { return { id: String(m.id || '') }; }).filter(function (m) { return m.id; });
      emit({ ok: true, models: models });
      return;
    }
    const image = String(a.image || '');
    const model = String(a.model || 'mimo-v2.5-pro');
    const maxTokens = parseInt(a.maxTokens, 10) || 2048;
    const temperature = typeof a.temperature === 'number' ? a.temperature : (parseFloat(a.temperature) || 0.3);
    const prompt = String(a.prompt || '');
    let imageUrl = image;
    if (a.imageFromStdin) {
      imageUrl = String(fs.readFileSync(0, 'utf8')).trim();
    } else if (/^data:/i.test(image)) {
      imageUrl = image;
    } else if (!/^https?:\/\//i.test(image)) {
      const buf = fs.readFileSync(image);
      const ext = path.extname(image).replace('.', '').toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      imageUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
    }
    const now = new Date();
    const dateStr = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日';
    const sys = (a.systemPrompt && String(a.systemPrompt).trim())
      ? String(a.systemPrompt).trim()
      : '你是MiMo，是小米公司研发的AI智能助手，同时是专业的图片分析助手。今天是' + dateStr + '。你的知识截止日期是2024年12月。请仔细观察图片，根据用户要求给出准确、详细、结构化的分析。';
    const body = {
      model: model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: prompt || '请详细描述这张图片的内容。' }
        ] }
      ],
      max_completion_tokens: maxTokens,
      temperature: temperature,
      stream: false
    };
    const resp = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000)
    });
    const text = await resp.text();
    if (!resp.ok) {
      emit({ ok: false, error: 'HTTP ' + resp.status + ': ' + text.slice(0, 800) });
      return;
    }
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    const choice = data && data.choices && data.choices[0];
    const description = (choice && choice.message && typeof choice.message.content === 'string')
      ? choice.message.content : '';
    emit({
      ok: true,
      model: (data && data.model) || model,
      description: description,
      usage: (data && data.usage) || null
    });
  } catch (err) {
    emit({ ok: false, error: String((err && err.message) || err) });
  }
})();
`;

// ---- 装饰器展开样板（与内置包编译产物一致，Node 22 可直接执行） ----
var __runInitializers = function(thisArg, initializers, value) {
  var useValue = arguments.length > 2;
  for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
  return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
  function accept(f) {
    if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
    return f;
  }
  var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
  var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
  var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
  var _, done = false;
  for (var i = decorators.length - 1; i >= 0; i--) {
    var context = {};
    for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
    for (var p in contextIn.access) context.access[p] = contextIn.access[p];
    context.addInitializer = function(f) {
      if (done) throw new TypeError("Cannot add initializers after decoration has completed");
      extraInitializers.push(accept(f || null));
    };
    var result = (0, decorators[i])(kind === "accessor" ? {
      get: descriptor.get,
      set: descriptor.set
    } : descriptor[key], context);
    if (kind === "accessor") {
      if (result === void 0) continue;
      if (result === null || typeof result !== "object") throw new TypeError("Object expected");
      if (_ = accept(result.get)) descriptor.get = _;
      if (_ = accept(result.set)) descriptor.set = _;
      if (_ = accept(result.init)) initializers.unshift(_);
    } else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
    else descriptor[key] = _;
  }
  if (target) Object.defineProperty(target, contextIn.name, descriptor);
  done = true;
};
// ---- /装饰器展开样板 ----

let MimoVision = (() => {
  let _classSuper = TypertRemoteService;
  let _instanceExtraInitializers = [];
  let _configGet_decorators;
  let _configSet_decorators;
  let _test_decorators;
  let _prepare_decorators;
  let _analyzeData_decorators;
  return class MimoVision extends _classSuper {
    static {
      const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
      _configGet_decorators = [Remote("configGet")];
      __esDecorate(this, null, _configGet_decorators, {
        kind: "method",
        name: "configGet",
        static: false,
        private: false,
        access: { has: (obj) => "configGet" in obj, get: (obj) => obj.configGet },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      _configSet_decorators = [Remote("configSet")];
      __esDecorate(this, null, _configSet_decorators, {
        kind: "method",
        name: "configSet",
        static: false,
        private: false,
        access: { has: (obj) => "configSet" in obj, get: (obj) => obj.configSet },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      _test_decorators = [Remote("test")];
      __esDecorate(this, null, _test_decorators, {
        kind: "method",
        name: "test",
        static: false,
        private: false,
        access: { has: (obj) => "test" in obj, get: (obj) => obj.test },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      _prepare_decorators = [Remote("prepare")];
      __esDecorate(this, null, _prepare_decorators, {
        kind: "method",
        name: "prepare",
        static: false,
        private: false,
        access: { has: (obj) => "prepare" in obj, get: (obj) => obj.prepare },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      _analyzeData_decorators = [Remote("analyzeData")];
      __esDecorate(this, null, _analyzeData_decorators, {
        kind: "method",
        name: "analyzeData",
        static: false,
        private: false,
        access: { has: (obj) => "analyzeData" in obj, get: (obj) => obj.analyzeData },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      if (_metadata) Object.defineProperty(this, Symbol.metadata, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: _metadata
      });
    }

    static inject = ['subprocess', 'credentials', 'sandboxPolicy'];

    constructor(ctx) {
      super(ctx, 'mimoVision');
      __runInitializers(this, _instanceExtraInitializers);
      this.config = { ...DEFAULT_CONFIG };
      this.liveModels = [];
      // agentId -> { dataUrls, prompt, at }：发送时客户端先把图片交到这里，
      // agent/pre-step 阶段取出并调用 MiMo，把识别结果注入上下文。
      this.pendingImages = new Map();
      this.nodePath = null;

      this.loadConfig().catch((err) => console.error('[mimo-vision] 初始化配置失败', (err && err.message) || err));

      // 在模型调用前把 MiMo 识别结果注入到本次步骤的上下文中（紧跟在用户消息之后）
      ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
        const entry = this.pendingImages.get(agent.id);
        if (!entry) return next();
        this.pendingImages.delete(agent.id);
        let note = null;
        try {
          const parts = [];
          for (const dataUrl of entry.dataUrls) {
            if (signal && signal.aborted) throw new Error('aborted');
            const res = await this.runHelperData(dataUrl, {
              model: this.config.model,
              maxTokens: this.config.maxTokens,
              prompt: entry.prompt ? String(entry.prompt) : (this.config.defaultPrompt || ''),
            }, signal);
            if (res && res.ok) {
              parts.push(String(res.description || ''));
            } else {
              note = '【用户上传了一张图片，但 MiMo 识别失败：' + String((res && res.error) || '未知错误') + '】';
              break;
            }
          }
          if (note === null) {
            note = '【用户上传的图片 · MiMo 视觉识别】\n' + parts.join('\n\n');
          }
        } catch (err) {
          if (signal && signal.aborted) throw err;
          note = '【用户上传了一张图片，但 MiMo 识别失败：' + String((err && err.message) || err) + '】';
        }
        if (signal) signal.throwIfAborted();
        const decision = await next();
        if (decision.kind === 'reject') return decision;
        const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message));
        const injected = {
          id: 'mimo-vision-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12),
          role: 'user',
          content: [{ type: 'text', text: note }],
          source: { kind: 'plugin', plugin: 'mimo-vision' },
        };
        const nextMessages = lastClaimedIndex === -1
          ? [...decision.messages, injected]
          : decision.messages.toSpliced(lastClaimedIndex + 1, 0, injected);
        return { kind: 'enter', messages: nextMessages };
      }));

      // 全局工具：所有会话可见
      ctx.effect(() => ctx.tools.register(defineTool({
        name: 'mimo_analyze_image',
        description: '调用小米 MiMo 模型（默认 mimo-v2.5-pro，官方标注 mimo-v2.5 亦支持图片理解）分析一张图片，返回图片内容的结构化描述（主体、场景、细节、文字等），供进一步处理。支持本地图片绝对路径或 http(s) 图片 URL。需要在 设置 → 插件 → 插件配置 → MiMo 视觉 中先配置 API Key。',
        parameters: {
          type: 'object',
          properties: {
            image: { type: 'string', description: '本地图片的绝对路径，或 http(s) 开头的图片 URL。' },
            prompt: { type: 'string', description: '针对该图片的具体问题或分析要求（可选，缺省使用配置中的默认提示词）。' },
            model: { type: 'string', enum: ['mimo-v2.5-pro', 'mimo-v2.5'], description: 'MiMo 模型（可选，缺省使用配置中选择的模型，默认 mimo-v2.5-pro）。' },
            maxTokens: { type: 'integer', description: '最大输出 token 数（可选，缺省使用配置值）。' },
          },
          required: ['image'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              description: { type: 'string' },
              model: { type: 'string' },
              usage: { type: 'object', additionalProperties: true },
              error: { type: 'string' },
            },
          },
          render: (args, value) => {
            const v = value || {};
            if (!v.ok) {
              return [{ type: 'text', text: '[MiMo 视觉] 分析失败：' + (v.error || '未知错误') }];
            }
            let text = '[MiMo 视觉] 模型 ' + (v.model || '') + ' 的分析结果：\n' + (v.description || '');
            if (v.usage) {
              text += '\n（用量：' + JSON.stringify(v.usage) + '）';
            }
            return [{ type: 'text', text: text }];
          },
        },
        execute: async (args, exec) => {
          try {
            const image = String((args && args.image) || '').trim();
            if (!image) {
              return { ok: false, error: '缺少 image 参数：请提供本地图片路径或图片 URL' };
            }
            const extra = {
              image: image,
              model: (args && args.model) || this.config.model,
              maxTokens: (args && args.maxTokens) || this.config.maxTokens,
              prompt: (args && args.prompt) ? String(args.prompt) : (this.config.defaultPrompt || ''),
            };
            return await this.runHelper('analyze', extra, exec.signal);
          } catch (err) {
            return { ok: false, error: String((err && err.message) || err) };
          }
        },
      })));
    }

    async loadConfig() {
      try {
        const resolved = await this.ctx.credentials.resolve(CRED_REF);
        if (resolved && resolved.value) {
          const parsed = JSON.parse(resolved.value);
          if (parsed && typeof parsed === 'object') {
            this.config = { ...DEFAULT_CONFIG, ...parsed };
          }
        }
      } catch (err) {
        console.error('[mimo-vision] 读取配置失败', (err && err.message) || err);
      }
    }

    async persistConfig(next) {
      const merged = { ...DEFAULT_CONFIG, ...this.config, ...next };
      if (typeof merged.apiKey !== 'string' || !merged.apiKey.trim()) {
        throw new Error('API Key 不能为空（sk- 开头为按量付费，tp- 开头为 Token 套餐）');
      }
      merged.apiKey = merged.apiKey.trim();
      if (typeof merged.baseUrl !== 'string' || !/^https?:\/\//i.test(merged.baseUrl.trim())) {
        throw new Error('Base URL 必须是 http(s) 地址');
      }
      merged.baseUrl = merged.baseUrl.trim().replace(/\/+$/, '');
      if (MODEL_CHOICES.indexOf(merged.model) === -1) {
        throw new Error('不支持的模型：' + merged.model + '（可选：' + MODEL_CHOICES.join(', ') + '）');
      }
      const mt = parseInt(merged.maxTokens, 10);
      merged.maxTokens = Number.isFinite(mt) ? Math.max(64, Math.min(65536, mt)) : 2048;
      const tt = parseFloat(merged.temperature);
      merged.temperature = Number.isFinite(tt) ? Math.max(0, Math.min(2, tt)) : 0.3;
      merged.defaultPrompt = typeof merged.defaultPrompt === 'string' ? merged.defaultPrompt : '';
      merged.systemPrompt = typeof merged.systemPrompt === 'string' ? merged.systemPrompt : '';
      merged.autoConvertImages = merged.autoConvertImages !== false;
      this.config = merged;
      await this.ctx.credentials.set(CRED_REF, JSON.stringify(merged));
      return merged;
    }

    async resolveNode() {
      if (this.nodePath) return this.nodePath;
      try {
        this.nodePath = await this.ctx.subprocess.resolveExecutable('node');
      } catch (err) {
        this.nodePath = FALLBACK_NODE;
      }
      return this.nodePath;
    }

    async awaitHelper(handle) {
      const outcome = await handle.done;
      const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : '';
      const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : '';
      if (outcome.exitCode !== 0) {
        return { ok: false, error: 'MiMo 调用进程异常退出 (code ' + outcome.exitCode + ')：' + (stderr || stdout).slice(0, 400) };
      }
      try {
        const parsed = JSON.parse(stdout);
        return parsed && typeof parsed === 'object' ? parsed : { ok: false, error: 'MiMo 返回格式异常' };
      } catch (err) {
        return { ok: false, error: 'MiMo 调用输出解析失败：' + stdout.slice(0, 400) + (stderr ? ' | stderr: ' + stderr.slice(0, 200) : '') };
      }
    }

    async runHelper(mode, extra, signal) {
      if (!this.config.apiKey) {
        return { ok: false, error: '未配置 MiMo API Key，请在 设置 → 插件 → 插件配置 → MiMo 视觉 中填写。' };
      }
      const nodePathResolved = await this.resolveNode();
      const payload = {
        mode: mode,
        baseUrl: this.config.baseUrl,
        model: this.config.model,
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
        prompt: this.config.defaultPrompt || '',
        systemPrompt: this.config.systemPrompt || '',
        ...extra,
      };
      const handle = this.ctx.subprocess.spawn({
        argv: [nodePathResolved, '-e', HELPER, JSON.stringify(payload)],
        cwd: this.ctx.sandboxPolicy.workspaceRoot,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1024 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 5000,
        env: { MIMO_API_KEY: this.config.apiKey },
        signal: signal,
      });
      return await this.awaitHelper(handle);
    }

    async runHelperData(dataUrl, extra, signal) {
      if (!this.config.apiKey) {
        return { ok: false, error: '未配置 MiMo API Key，请在 设置 → 插件 → 插件配置 → MiMo 视觉 中填写。' };
      }
      const nodePathResolved = await this.resolveNode();
      const payload = {
        mode: 'analyze',
        imageFromStdin: true,
        baseUrl: this.config.baseUrl,
        model: this.config.model,
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
        prompt: this.config.defaultPrompt || '',
        systemPrompt: this.config.systemPrompt || '',
        ...extra,
      };
      const handle = this.ctx.subprocess.spawn({
        argv: [nodePathResolved, '-e', HELPER, JSON.stringify(payload)],
        cwd: this.ctx.sandboxPolicy.workspaceRoot,
        stdio: {
          stdin: { data: dataUrl },
          stdout: { maxBytes: 1024 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 5000,
        env: { MIMO_API_KEY: this.config.apiKey },
        signal: signal,
      });
      return await this.awaitHelper(handle);
    }

    async configGet() {
      return { config: this.config };
    }

    async configSet(args) {
      const next = (args && typeof args === 'object' && args.config && typeof args.config === 'object') ? args.config : {};
      try {
        const merged = await this.persistConfig(next);
        return { ok: true, config: merged };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }

    async test() {
      try {
        const result = await this.runHelper('test');
        if (result.ok && Array.isArray(result.models)) {
          this.liveModels = result.models;
        }
        return result;
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }

    // 客户端发送前先把图片数据交给宿主暂存，等 agent/pre-step 时识别并注入上下文
    async prepare(args) {
      try {
        const sessionId = String((args && args.sessionId) || '');
        const dataUrls = (args && Array.isArray(args.dataUrls))
          ? args.dataUrls.filter((u) => typeof u === 'string' && /^data:image\//i.test(u))
          : [];
        if (!sessionId || dataUrls.length === 0) {
          return { ok: false, error: '参数不完整：缺少会话或图片数据' };
        }
        if (!this.config.apiKey) {
          return { ok: false, error: '未配置 MiMo API Key，请在 设置 → 插件 → 插件配置 → MiMo 视觉 中填写。' };
        }
        this.pendingImages.set(sessionId, {
          dataUrls: dataUrls,
          prompt: (args && args.prompt) ? String(args.prompt) : '',
          at: Date.now(),
        });
        return { ok: true, count: dataUrls.length };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }

    async analyzeData(args) {
      try {
        const dataUrl = String((args && args.dataUrl) || '');
        if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) {
          return { ok: false, error: '不是有效的 base64 图片数据' };
        }
        return await this.runHelperData(dataUrl, {
          model: this.config.model,
          maxTokens: this.config.maxTokens,
          prompt: (args && args.prompt) ? String(args.prompt) : (this.config.defaultPrompt || ''),
        });
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }
  };
})();

export { MimoVision };
export default MimoVision;
