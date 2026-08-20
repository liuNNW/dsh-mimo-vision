/**
 * MiMo 视觉识别 — 全局插件（浏览器端）
 *
 * 浏览器模块格式（window.__ModuleLoader__.load），与内置客户端包一致。
 * 宿主端 Remote 服务 mimoVision 经内置 connection.rpc 通道直连（/api/mimoVision/*），
 * 不依赖 remote.mimoVision 命名空间（rc.6 客户端仅挂载编译期生成的 Remote 清单）。
 * 设置卡片注册在 settings.plugin.item 槽，id `mimo-vision`，样式复刻内置“网页搜索”卡片。
 * 发送时仅在 插件存活 + 开启自动识别 + 已配置密钥 时才拦截图片并交给宿主，
 * 其余情况一律回退原生流程（保留“当前模型不支持图片”提示）。
 */
window.__ModuleLoader__.load({
  id: '@deepseek-ai/dsh-mimo-vision',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const react = require('react');
    const { createElement: h, useState, useEffect } = react;

    const inject = ['slots', 'timer', 'connection'];

    // ---- 样式：与内置包一致的注入方式（<style data-plugin-css>） ----
    const css = '.mc-card { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3); border-radius: 12px; list-style: none; transition: border-color .16s, background .16s; }\n.mc-card:hover { border-color: var(--dsw-alias-label-dimmed); }\n.mc-cardOpen { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-dimmed); }\n.mc-header { appearance: none; width: 100%; font: inherit; color: inherit; text-align: left; cursor: pointer; background: 0 0; border: 0; border-radius: 12px; align-items: center; gap: 12px; padding: 14px 16px; display: flex; }\n.mc-header:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }\n.mc-headText { flex-direction: column; flex: 1; gap: 4px; min-width: 0; display: flex; }\n.mc-name { color: var(--dsw-alias-label-primary); font-size: 15px; font-weight: 600; line-height: 1.4; }\n.mc-desc { color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 1.5; }\n.mc-chevron { color: var(--dsw-alias-label-tertiary); flex: none; transition: transform .16s; }\n.mc-chevronOpen { transform: rotate(180deg); }\n.mc-body { border-top: 1px solid var(--dsw-alias-border-l2); margin: 0 16px; padding-bottom: 8px; }\n.mc-pending { white-space: nowrap; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); border-radius: 999px; flex: none; padding: 1px 8px; font-size: 11px; font-weight: 500; line-height: 17px; }\n.mc-field { flex-direction: column; gap: 6px; padding: 12px 0; display: flex; }\n.mc-field + .mc-field { border-top: 1px solid var(--dsw-alias-border-l2); }\n.mc-head { align-items: center; gap: 8px; display: flex; }\n.mc-label { min-width: 0; color: var(--dsw-alias-label-primary); flex: 1; font-size: 13px; font-weight: 500; line-height: 1.5; }\n.mc-badges { align-items: center; gap: 8px; display: inline-flex; }\n.mc-badge { white-space: nowrap; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 500; line-height: 17px; }\n.mc-badgeMuted { white-space: nowrap; color: var(--dsw-alias-label-tertiary); border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; }\n.mc-reset { font: inherit; color: var(--dsw-alias-label-secondary); cursor: pointer; background: 0 0; border: none; padding: 0; font-size: 12px; line-height: 1.5; }\n.mc-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }\n.mc-reset:disabled { cursor: default; }\n.mc-input { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3); height: 34px; font: inherit; color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 0 12px; font-size: 13px; line-height: 1.5; box-sizing: border-box; width: 100%; }\n.mc-input:focus-visible { border-color: var(--dsw-alias-brand-primary); outline: none; }\n.mc-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }\n.mc-inputInvalid { border-color: var(--dsw-alias-label-error); }\n.mc-area { height: auto; min-height: 64px; padding: 8px 12px; resize: vertical; font-family: inherit; }\n.mc-invalid { color: var(--dsw-alias-label-error); margin: 0; font-size: 12px; line-height: 1.5; }\n.mc-hint { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 12px; line-height: 1.5; }\n.mc-check { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: var(--dsw-alias-label-primary); cursor: pointer; line-height: 1.5; }\n.mc-check input { margin-top: 2px; accent-color: var(--dsw-alias-brand-primary); }\n.mc-footer { border-top: 1px solid var(--dsw-alias-border-l2); justify-content: flex-end; align-items: center; gap: 8px; padding: 12px 0 4px; display: flex; }\n.mc-note { min-width: 0; flex: 1; margin: 0; font-size: 12px; line-height: 1.5; }\n.mc-noteError { color: var(--dsw-alias-label-error); }\n.mc-noteOk { color: var(--dsw-alias-label-primary); }\n.mc-test, .mc-discard, .mc-save { appearance: none; font: inherit; cursor: pointer; border: 1px solid transparent; border-radius: 8px; padding: 5px 14px; font-size: 13px; line-height: 1.5; }\n.mc-test, .mc-discard { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); background: 0 0; }\n.mc-test:hover:not(:disabled), .mc-discard:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }\n.mc-save { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }\n.mc-test:disabled, .mc-discard:disabled, .mc-save:disabled { opacity: .4; cursor: default; }\n.mc-test:focus-visible, .mc-discard:focus-visible, .mc-save:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }';
    const tagId = '@deepseek-ai/dsh-mimo-vision/settings.css';
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = '@deepseek-ai/dsh-mimo-vision';
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

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
    const STATIC_MODELS = ['mimo-v2.5-pro', 'mimo-v2.5'];

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
    }

    // ---- 宿主 RPC 直连：经内置 connection 通道调用宿主 gateway 的 /api/mimoVision/* 端点。
    //      rc.6 的客户端 remote.<namespace> 只挂载编译期生成的 Remote 清单（dsh-api-remotes），
    //      运行时注册的 TypertRemoteService 仅宿主端 SRC 回退支持，客户端没有对应命名空间，
    //      因此直接走底层 RPC 通道（ui-cordis / pluginInventory 同用此通道）。
    //      宿主端 gateway：payload 必须恰好含一个 plain-object 字段 args；
    //      无参方法发 {args:{}}，单参方法发 {args:{args:<值>}}（wire 名 = 方法参数名）。
    //      返回 {ok:true, value} 或 {ok:false, error:{message}}；这里解包为与旧 host.call 一致的形状。 ----
    function makeRpc(ctx) {
      const conn = ctx.connection;
      const call = async (method, arg) => {
        const payload = arg === undefined ? { args: {} } : { args: { args: arg } };
        let outcome;
        try {
          outcome = await conn.rpc.call('/api', 'mimoVision/' + method, payload);
        } catch (err) {
          return { ok: false, error: String((err && err.message) || err) };
        }
        if (outcome && outcome.ok) return outcome.value;
        const e = (outcome && outcome.error) || {};
        return { ok: false, error: String((e && e.message) || JSON.stringify(e) || 'MiMo RPC 失败') };
      };
      return {
        configGet: () => call('configGet'),
        configSet: (config) => call('configSet', { config }),
        test: () => call('test'),
        prepare: (p) => call('prepare', p),
        analyzeData: (p) => call('analyzeData', p),
      };
    }

    // ---- 发送时拦截：仅在插件存活 + 开启自动识别 + 已配置密钥时才把图片交给宿主（mimoVision.prepare），
    //      消息本体只发送用户文本，宿主在 agent/pre-step 用 MiMo 识别结果注入上下文，agent 正常回复。
    //      其余任何情况（插件已停用、未开启、未配置、MiMo 不可用）一律回退原生流程，
    //      保留 DSH 原有的“当前模型不支持图片”提示。 ----
    let installed = false;
    function installWrap(ctx, service, rpc) {
      if (installed || !service || typeof service.sendSession !== 'function') return;
      installed = true;
      const original = service.sendSession;
      const wrapped = async function (session, text, imageIds, mode, signal) {
        const ids = Array.isArray(imageIds) ? imageIds : [];
        if (ids.length > 0) {
          try {
            const cfgRes = await rpc.configGet();
            const cfg = (cfgRes && cfgRes.config) || {};
            if (cfg.autoConvertImages !== false && cfg.apiKey) {
              const sessionId = (session && session.sessionId) ? String(session.sessionId) : '';
              const attachments = this.draftImages(ids);
              const dataUrls = [];
              for (const att of attachments) {
                if (!att || !att.file) throw new Error('图片附件已失效，请重新粘贴');
                dataUrls.push(await readFileAsDataUrl(att.file));
              }
              const sendText = (typeof text === 'string' && text.trim()) ? text : '请识别这张图片并回复我。';
              const prep = await rpc.prepare({ sessionId: sessionId, dataUrls: dataUrls, prompt: sendText });
              if (!prep || !prep.ok) {
                try { this.releaseDraftImages(attachments); } catch (e) { /* 忽略 */ }
                return original.call(this, session, text, imageIds, mode, signal);
              }
              const result = await original.call(this, session, sendText, [], mode, signal);
              try { this.releaseDraftImages(attachments); } catch (e) { /* 尽力释放预览资源 */ }
              return result;
            }
          } catch (err) {
            // 插件已停用或配置服务不可达 → 走原生流程，保留原生提示
          }
        }
        return original.call(this, session, text, imageIds, mode, signal);
      };
      service.sendSession = wrapped;
      ctx.effect(() => () => {
        if (service && service.sendSession === wrapped) service.sendSession = original;
      });
    }

    function Chevron(props) {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', className: 'mc-chevron' + (props.open ? ' mc-chevronOpen' : ''), 'aria-hidden': true },
        h('path', { d: 'M4 6l4 4 4-4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    function MimoSettings({ rpc }) {
      const [base, setBase] = useState(null);
      const [drafts, setDrafts] = useState(null);
      const [apiKeyDraft, setApiKeyDraft] = useState('');
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState('');
      const [failed, setFailed] = useState(false);
      const [note, setNote] = useState({ kind: '', text: '' });
      const [models, setModels] = useState([]);

      useEffect(() => {
        let alive = true;
        rpc.configGet().then((res) => {
          if (!alive) return;
          const cfg = (res && res.config) || {};
          const merged = { ...DEFAULT_CONFIG, ...cfg };
          setBase(merged);
          setDrafts({
            baseUrl: merged.baseUrl,
            model: merged.model,
            maxTokens: String(merged.maxTokens),
            temperature: String(merged.temperature),
            defaultPrompt: merged.defaultPrompt || '',
            systemPrompt: merged.systemPrompt || '',
            autoConvertImages: merged.autoConvertImages !== false,
          });
        }).catch((err) => {
          if (alive) setNote({ kind: 'error', text: '读取配置失败：' + String((err && err.message) || err) });
        });
        return () => { alive = false; };
      }, []);

      const title = 'MiMo 视觉识别';
      const desc = '对接小米 MiMo 模型，让 DSH 具备图片识别能力。';

      if (!base || !drafts) {
        return h('li', { className: 'mc-card' },
          h('button', { type: 'button', className: 'mc-header', 'aria-expanded': false },
            h('span', { className: 'mc-headText' },
              h('span', { className: 'mc-name' }, title),
              h('span', { className: 'mc-desc' }, desc)),
            h(Chevron, { open: false })));
      }

      const configured = Boolean(base.apiKey);
      const setDraft = (key) => (text) => setDrafts((d) => ({ ...d, [key]: text }));

      const dirty = apiKeyDraft.trim() !== '' ||
        drafts.baseUrl !== String(base.baseUrl) ||
        drafts.model !== String(base.model) ||
        drafts.maxTokens !== String(base.maxTokens) ||
        drafts.temperature !== String(base.temperature) ||
        drafts.defaultPrompt !== String(base.defaultPrompt || '') ||
        drafts.systemPrompt !== String(base.systemPrompt || '') ||
        drafts.autoConvertImages !== (base.autoConvertImages !== false);

      const mt = drafts.maxTokens.trim();
      const tt = drafts.temperature.trim();
      const mtInvalid = mt !== '' && !/^\d+$/.test(mt);
      const ttInvalid = tt !== '' && !Number.isFinite(Number(tt));
      const invalid = mtInvalid || ttInvalid;
      const blocked = !dirty || invalid || busy !== '';
      const overriddenOf = (key) => drafts[key] !== String(DEFAULT_CONFIG[key]);
      const autoOverridden = drafts.autoConvertImages !== DEFAULT_CONFIG.autoConvertImages;

      const buildNext = () => ({
        apiKey: apiKeyDraft.trim() !== '' ? apiKeyDraft.trim() : base.apiKey,
        baseUrl: drafts.baseUrl.trim() !== '' ? drafts.baseUrl.trim() : DEFAULT_CONFIG.baseUrl,
        model: drafts.model || DEFAULT_CONFIG.model,
        maxTokens: mt !== '' ? parseInt(mt, 10) : DEFAULT_CONFIG.maxTokens,
        temperature: tt !== '' ? Number(tt) : DEFAULT_CONFIG.temperature,
        defaultPrompt: drafts.defaultPrompt,
        systemPrompt: drafts.systemPrompt,
        autoConvertImages: drafts.autoConvertImages,
      });

      const applySave = async () => {
        setBusy('saving');
        setFailed(false);
        setNote({ kind: '', text: '' });
        try {
          const res = await rpc.configSet({ config: buildNext() });
          if (res && res.ok) {
            const saved = { ...DEFAULT_CONFIG, ...res.config };
            setBase(saved);
            setDrafts({
              baseUrl: saved.baseUrl,
              model: saved.model,
              maxTokens: String(saved.maxTokens),
              temperature: String(saved.temperature),
              defaultPrompt: saved.defaultPrompt || '',
              systemPrompt: saved.systemPrompt || '',
              autoConvertImages: saved.autoConvertImages !== false,
            });
            setApiKeyDraft('');
            setFailed(false);
            return true;
          }
          setFailed(true);
          setNote({ kind: 'error', text: String((res && res.error) || '保存失败') });
          return false;
        } catch (err) {
          setFailed(true);
          setNote({ kind: 'error', text: '保存失败：' + String((err && err.message) || err) });
          return false;
        } finally {
          setBusy('');
        }
      };

      const onSave = async () => {
        if (blocked) return;
        await applySave();
      };

      const onDiscard = () => {
        if (busy !== '') return;
        setDrafts({
          baseUrl: base.baseUrl,
          model: base.model,
          maxTokens: String(base.maxTokens),
          temperature: String(base.temperature),
          defaultPrompt: base.defaultPrompt || '',
          systemPrompt: base.systemPrompt || '',
          autoConvertImages: base.autoConvertImages !== false,
        });
        setApiKeyDraft('');
        setFailed(false);
        setNote({ kind: '', text: '' });
      };

      const onTest = async () => {
        if (busy !== '') return;
        if (dirty) {
          const saved = await applySave();
          if (!saved) return;
        }
        setBusy('testing');
        setNote({ kind: '', text: '正在测试连接…' });
        try {
          const res = await rpc.test();
          if (res && res.ok) {
            const list = Array.isArray(res.models) ? res.models : [];
            setModels(list);
            setNote({ kind: 'ok', text: '连接成功 ✓ 发现 ' + list.length + ' 个模型（' + list.map((m) => m.id).join('、') + '）' });
          } else {
            setNote({ kind: 'error', text: '连接失败：' + String((res && res.error) || '未知错误') });
          }
        } catch (err) {
          setNote({ kind: 'error', text: '测试失败：' + String((err && err.message) || err) });
        } finally {
          setBusy('');
        }
      };

      const valueField = (opts) => {
        const { id, label, hint, text, onEdit, numeric, isInvalid, overridden, onReset, select, area } = opts;
        const badges = overridden ? h('span', { className: 'mc-badges' },
          h('span', { className: 'mc-badge' }, '已覆盖'),
          h('button', { type: 'button', className: 'mc-reset', disabled: busy !== '', onClick: onReset }, '恢复默认')) : null;
        let control;
        const cls = 'mc-input' + (isInvalid ? ' mc-inputInvalid' : '');
        if (select) {
          control = h('select', { id, className: cls, value: text, disabled: busy !== '', onChange: (ev) => onEdit(ev.target.value), 'aria-invalid': isInvalid || undefined }, select);
        } else if (area) {
          control = h('textarea', { id, className: cls + ' mc-area', value: text, disabled: busy !== '', onChange: (ev) => onEdit(ev.target.value), 'aria-invalid': isInvalid || undefined });
        } else {
          control = h('input', { id, className: cls, type: 'text', inputMode: numeric ? 'numeric' : undefined, value: text, disabled: busy !== '', onChange: (ev) => onEdit(ev.target.value), 'aria-invalid': isInvalid || undefined });
        }
        return h('div', { className: 'mc-field' },
          h('div', { className: 'mc-head' },
            h('label', { className: 'mc-label', htmlFor: id }, label),
            badges),
          control,
          h('p', { className: isInvalid ? 'mc-invalid' : 'mc-hint' }, isInvalid ? '请填数字；留空表示使用默认值。' : hint));
      };

      const secretField = (opts) => {
        const { id, label, hint, text, onEdit, configured: isConfigured } = opts;
        return h('div', { className: 'mc-field' },
          h('div', { className: 'mc-head' },
            h('label', { className: 'mc-label', htmlFor: id }, label),
            h('span', { className: 'mc-badges' },
              h('span', { className: isConfigured ? 'mc-badge' : 'mc-badgeMuted' },
                isConfigured ? '已配置密钥。' : '未配置密钥；配置之前图片识别不可用。'))),
          h('input', { id, className: 'mc-input', type: 'password', autoComplete: 'off', value: text, disabled: busy !== '', onChange: (ev) => onEdit(ev.target.value) }),
          h('p', { className: 'mc-hint' }, hint));
      };

      const seen = {};
      const modelOpts = [];
      STATIC_MODELS.concat(models.map((m) => m.id)).forEach((id) => {
        if (seen[id]) return;
        seen[id] = true;
        let noteTxt = '';
        if (id === 'mimo-v2.5-pro') noteTxt = '（默认·深度思考）';
        else if (id === 'mimo-v2.5') noteTxt = '（全模态理解）';
        modelOpts.push(h('option', { key: id, value: id }, id + noteTxt));
      });

      const noteCls = note.kind === 'error' ? ' mc-noteError' : (note.kind === 'ok' ? ' mc-noteOk' : '');

      return h('li', { className: 'mc-card' + (open ? ' mc-cardOpen' : '') },
        h('button', { type: 'button', className: 'mc-header', 'aria-expanded': open, 'aria-label': (open ? '收起设置' : '展开设置') + ': ' + title, onClick: () => setOpen(!open) },
          h('span', { className: 'mc-headText' },
            h('span', { className: 'mc-name' }, title),
            h('span', { className: 'mc-desc' }, desc)),
          dirty ? h('span', { className: 'mc-pending' }, '未保存') : null,
          h(Chevron, { open: open })),
        open ? h('div', { className: 'mc-body' },
          secretField({
            id: 'plugin-config-mimo-api-key',
            label: 'API Key',
            hint: '不写入配置文件。留空表示保持当前密钥。',
            text: apiKeyDraft,
            onEdit: setApiKeyDraft,
            configured: configured,
          }),
          valueField({
            id: 'plugin-config-mimo-base-url',
            label: '接口地址',
            hint: '按量付费与 Token 套餐使用不同地址；留空使用默认地址。',
            text: drafts.baseUrl,
            onEdit: setDraft('baseUrl'),
            overridden: overriddenOf('baseUrl'),
            onReset: () => setDraft('baseUrl')(DEFAULT_CONFIG.baseUrl),
          }),
          valueField({
            id: 'plugin-config-mimo-model',
            label: '模型',
            hint: '默认 mimo-v2.5-pro；若图片理解报错可切换 mimo-v2.5（官方标注支持图片理解）。',
            text: drafts.model,
            onEdit: setDraft('model'),
            overridden: overriddenOf('model'),
            onReset: () => setDraft('model')(DEFAULT_CONFIG.model),
            select: modelOpts,
          }),
          valueField({
            id: 'plugin-config-mimo-max-tokens',
            label: '最大输出 tokens',
            hint: '留空表示使用默认值 2048。',
            text: drafts.maxTokens,
            onEdit: setDraft('maxTokens'),
            numeric: true,
            isInvalid: mtInvalid,
            overridden: overriddenOf('maxTokens'),
            onReset: () => setDraft('maxTokens')(String(DEFAULT_CONFIG.maxTokens)),
          }),
          valueField({
            id: 'plugin-config-mimo-temperature',
            label: '温度',
            hint: '0–2，留空表示使用默认值 0.3。',
            text: drafts.temperature,
            onEdit: setDraft('temperature'),
            numeric: true,
            isInvalid: ttInvalid,
            overridden: overriddenOf('temperature'),
            onReset: () => setDraft('temperature')(String(DEFAULT_CONFIG.temperature)),
          }),
          h('div', { className: 'mc-field' },
            h('div', { className: 'mc-head' },
              h('label', { className: 'mc-label' }, '发送时自动用 MiMo 识别图片'),
              autoOverridden ? h('span', { className: 'mc-badges' },
                h('span', { className: 'mc-badge' }, '已覆盖'),
                h('button', { type: 'button', className: 'mc-reset', disabled: busy !== '', onClick: () => setDraft('autoConvertImages')(DEFAULT_CONFIG.autoConvertImages) }, '恢复默认')) : null),
            h('label', { className: 'mc-check' },
              h('input', { type: 'checkbox', checked: drafts.autoConvertImages, disabled: busy !== '', onChange: (ev) => setDraft('autoConvertImages')(ev.target.checked) }),
              h('span', null, '开启后，发送带图片的消息时自动调用 MiMo 识别，识别结果作为上下文进入对话')),
            h('p', { className: 'mc-hint' }, '关闭后按原生方式发送图片，界面会提示「当前模型不支持图片」（建议保持开启）')),
          valueField({
            id: 'plugin-config-mimo-default-prompt',
            label: '默认提示词',
            hint: '发送时未写提示词的情况下，用于让 MiMo 描述图片。',
            text: drafts.defaultPrompt,
            onEdit: setDraft('defaultPrompt'),
            overridden: overriddenOf('defaultPrompt'),
            onReset: () => setDraft('defaultPrompt')(''),
            area: true,
          }),
          valueField({
            id: 'plugin-config-mimo-system-prompt',
            label: '系统提示词（可选）',
            hint: '留空使用内置的 MiMo 图片分析提示词。',
            text: drafts.systemPrompt,
            onEdit: setDraft('systemPrompt'),
            overridden: overriddenOf('systemPrompt'),
            onReset: () => setDraft('systemPrompt')(''),
            area: true,
          }),
          h('div', { className: 'mc-footer' },
            note.text ? h('p', { className: 'mc-note' + noteCls, role: failed ? 'status' : undefined }, note.text) : null,
            h('button', { type: 'button', className: 'mc-test', disabled: busy !== '', onClick: onTest }, busy === 'testing' ? '测试中…' : '测试连接'),
            h('button', { type: 'button', className: 'mc-discard', disabled: !dirty || busy !== '', onClick: onDiscard }, '放弃修改'),
            h('button', { type: 'button', className: 'mc-save', disabled: blocked, onClick: onSave }, busy === 'saving' ? '保存中…' : '保存')))
        : null);
    }

    function apply(ctx) {
      const rpc = makeRpc(ctx);
      // 发送拦截（conversation 服务可能晚于本插件激活，用 timer 轮询兜底）
      const convNow = ctx.get('conversation');
      if (convNow) {
        installWrap(ctx, convNow, rpc);
      } else {
        let dispose = null;
        dispose = ctx.timer.interval(() => {
          const s = ctx.get('conversation');
          if (s) { installWrap(ctx, s, rpc); if (dispose) dispose(); }
        }, 300);
      }

      // 设置页卡片：settings.plugin.item 槽，样式与内置“网页搜索”一致
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
        { name: 'settings.plugin.item', id: 'mimo-vision', order: 25, label: 'MiMo 视觉' },
        () => react.createElement(MimoSettings, { rpc })
      ));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
