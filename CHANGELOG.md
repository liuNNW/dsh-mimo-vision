# 变更记录

## 0.2.2

**包名改为 `dsh-mimo-vision`**（从 `@deepseek-ai/dsh-mimo-vision`），以便公开发布。

### 为什么改名

`@deepseek-ai` 是 DeepSeek 官方 scope（维护者 `imccyu` / `tianyicui-deepseek`），第三方 `npm publish` 会被 403 拒绝。现在是无 scope 包名，与生态惯例一致（`dsh-context` / `dsh-better-sidebar` 等）。

### 破坏性变更

- **`dsh.profile.bundles` 里的包名变了**：旧条目 `@deepseek-ai/dsh-mimo-vision` 必须换成 `dsh-mimo-vision`。两个都留着会让插件**加载两次**。
- **profile `cordis.patch.yml` 里用户层 row 的 `name` 必须跟着改**：`applyEntryPatches` 会比对 `name`，不一致就整条跳过 —— 不改的话保存过的配置会**静默失效**（`model` / `defaultPrompt` 等回落默认值）。
- **设置命名空间（row id `mimo-vision`）没变**，所以配置值和凭据都不用迁移，`install.mjs` 会就地检测并提示这两处。
- **客户端模块 id 必须等于包名**：`dsh-client-modules` 的 `arrive()` 要求 bundle 注册的 id 与包名一致，否则判定 `loaded without registering`，**所有插件的 UI 都会报 Failed to load plugins**。已同步 `lib/client.js` 的 `id`。

### 修复

- `install.mjs` 不再误报「手工 insert 残留」：它现在按顶层条目切块，只对真正的 `- insert:` 重复块报警，并单独识别「用户层 row 仍是旧包名」这种需要迁移的情况（此前把用户保存的配置行误判为残留）。

### 新增

- `integration.mjs` 增加 `[F] 包名一致性`：package.json 的 `name`、客户端注册 id、补丁 row 的 `name` 三方必须一致，row 的 `id` 必须仍是 `mimo-vision`，且包名不得占用 `@deepseek-ai` scope。
- 补 `repository` / `homepage` / `bugs` 字段，npm 页面才有源码链接。

## 0.2.1

设置页改为**全量复用内核 primitives 组件**，并按 0.2.0-rc.2 的真实 CSS 指标逐项对齐；同时修掉两个功能缺陷与一个样式注入缺陷。

对齐依据：直接从运行中的 Electron 内核 `F:\软件\dsh\resources\app.asar` 取出 `@deepseek-ai/dsh@0.2.0-rc.2` 的 primitives 源码与 CSS（该版本导出 282 个符号），逐条抄下签名与数值，不靠猜。

### 修复

- **样式表从未注入**：`ctx.effect(() => () => { … })` 的双层箭头把「插入 `<style>`」推迟到了卸载时刻，所以设置页一直没有插件自己的布局样式。改为挂载即注入（cordis 的 `effect(callback)` 立即执行回调，把返回值当清理函数）。
- **两个座位的字段 id 会重复**：`idPrefix` 由 controller 生成却没进 `injected()`，导致 `props.idPrefix` 为 `undefined`，`settings.section` 与 `plugins.item` 生成同名 `plugin-config-mimo-*`。已把 `idPrefix` 放进注入面；布尔行自建的 help 区 id 也改成带实例前缀（原先写死 `mimo-<field>-help`）。
- **插件页重复说明文字**：`plugins.item` 的 page 视图不再渲染 `mimo-pageIntro`（`ItemDetail` 已渲染标题与摘要），只保留 `summary` 视图的纯文本契约。

### 变更

- 布尔项改用官方 `Switch`（`role="switch"` + `aria-checked`，轨道 36×20 / thumb 16px / `translateX(16px)`），外层行照 `DeveloperToolsRow` 真实 CSS：`space-between` / `gap:24px` / `padding:16px 0` / `border-bottom:.5px solid border-l2`。
- 「测试连接」改用 `Button variant="outline" size="sm"`（28px / 12px / `radius-sm` / 边框 `.5px border-l3`）；模型候选改用 `Pill`（24px / `padding:0 8px` / `radius:999px` / `bg-layer-2`）；「已覆盖」由 `SettingsValueField` 内部渲染的 `Tag` 承担。
- 长解释改走官方 help 折叠：`SettingsValueField` / `SettingsSecretField` 内建 `help={{ label, content }}`（ⓘ 按钮 + `role="region"` + `aria-describedby`），布尔行与多行字段自建的字段壳也照抄同一套（`.helpButton` 24×24 / `radius-sm` / `label-tertiary`，`.help` 12px / 1.6 / `label-secondary`）。
- 字段分隔线改为官方真实值 **`0.5px solid var(--dsw-alias-border-l2)`**（此前误为 1px）；section `max-width:720px`、title `16px/500/24px`、intro `14px/22px`、提示 `state-success-primary` / `state-warn-label`。
- 文案收短：`autoConvertHint`、`modelHint`、`apiKeyHint`、`apiKeyUnset`、`statusLine` 全部压到一行；`testOk` 去掉 ✓ emoji（改为「已连接 · N 个模型」）；长解释挪进新增的 `autoConvertHelp`。
- `defaultPrompt` / `systemPrompt` 渲染为多行 `<textarea>`（primitives 无 textarea 组件），结构同构官方 `.field`，样式照抄官方 `.input`（`.5px` 边框 / `radius-md` / `bg-layer-3` / 13px / 1.5）；暂存、校验、清除语义仍走官方 `settingsTextField`。
- 内核缺少 `Switch` 时不再退回 `input[type=checkbox]`（正是要清掉的手写控件），改为行内只读提示。

### 自检

四套脚本全绿：`schema-check` 24、`smoke` 62、`integration` 82、`verify-profile` 11。

`integration.mjs` 新增 [C] 渲染层 / [D] 样式表 / [E] 文案三组断言（带一个最小元素树与 hook 运行时，好让两个座位真被渲染一遍）：布尔项是 `Switch` 且树里没有 `input[type=checkbox]`、`Button{variant:'outline',size:'sm'}`、`Pill`、两个座位字段 id 无交集、page 视图无重复说明；CSS 含 `.5px` / `720px` / `16px` / `warn-label` 且不含 `state-success-secondary` / `text-decoration:underline` / `mimo-check` / `mimo-test` / `mimo-modelChip`；zh-en 字典键完全对齐。

## 0.2.0

从「拷进内核目录的静态插件」重构为 **profile 级永久插件**，并把配置体系、通信层、图片调用方式整体换到 rc.7/rc.8 的官方机制上。

### 破坏性变更

- **安装位置**：不再拷贝到 `<dsh>/node_modules/@deepseek-ai/`，改为装进 `<DSH_HOME>/profiles/<profile>/node_modules/` 并登记到该 profile 的 `dsh.profile.bundles`。`install.mjs` 会检测旧残留并给出清理命令 —— **升级前请先删掉旧拷贝**，否则两个版本会同时加载。
- **设置页座位**：`settings.plugin.item` → **`settings.section`**（设置侧栏一页）+ **`plugins.item`**（插件页卡片）。前者在 rc.6+ 的客户端里根本不存在，这正是历史版本设置页出不来的原因。
- **配置存储**：`MIMO_VISION_CONFIG`（一个塞满 JSON 的凭据）→ 拆成 **插件 Config 的 volatile 字段**（写在 profile 的 `cordis.patch.yml`，由 `@deepseek-ai/dsh-settings` 投影成表单）+ **独立密钥引用** `MIMO_VISION_API_KEY`（写在 `.credentials.yaml`）。
  首次启动会自动迁移：旧 JSON 里的密钥写进新引用、其余字段补进配置（**不覆盖**用户已在设置页保存过的值），然后删除旧引用。
- **客户端 ↔ 宿主通道**：typert Remote / `connection.rpc` SRC 回退 → **同源 HTTP 面** `/mimo-vision/api/{status,test,prepare,analyze}`（`webServer` prefix 路由）。
  原因：rc.6+ 的客户端只挂载编译期生成的 Remote 清单，运行时注册的 `TypertRemoteService` 在浏览器侧永远 pending。
- **模型名称**：不再限定 `mimo-v2.5-pro` / `mimo-v2.5` 白名单，改为自由文本；「测试连接」成功后可从候选 id 点选。

### 修复

- **启动崩溃**：`static inject` 漏 `tools` → 报 `cannot get property "tools" without inject`，导致整棵插件树 FAILED、dsh 起不来。现在 `inject = ['tools', 'webServer', 'credentials']`。
- **工具参数形态**：`parameters` 曾写成 JSON Schema 形态（`{type:'object',properties,required:[]}`），`defineTool` 会抛 `parameters.type must be a value schema object`。现改为属性映射形态（属性级 `required: true`），并抽成 `MIMO_ANALYZE_TOOL_PARAMETERS` 供自检脚本编译验证。
- **客户端 API 过时**：`draftImages` / `releaseDraftImages` → rc.8 实际的 `resolveDraftAttachments` / `encodeImage` / `releaseDraftAttachments`。
- **自动识别静默失效**：密钥状态原先只由设置页组件在挂载时读取，用户整场会话不打开设置页就永远不会触发识别。现由 `apply` 主动读取，并在 `connection/reset` 与凭据变更事件上刷新。
- **配置嵌套残留**：归一化时逐个解开 volatile 引用（Loader 传入的字段是 `{get(): T}` 引用对象，不是裸值），并保留对历史嵌套 `config` 字段的展平。

### 其它

- 图片识别从「`node -e` 子进程 + argv 传 base64」改为宿主**进程内 `fetch`**，去掉 `subprocess` / `sandboxPolicy` 注入面；`max_completion_tokens` 被网关拒绝时自动改用 `max_tokens` 重试一次。
- 错误信息对 `sk-` / `tp-` 密钥片段脱敏。
- 图片体积硬上限：单张 12 MB、总量 40 MB、最多 16 张、请求体 48 MB，超限报错而非静默截断。
- 暂存条目按会话合并 + 10 分钟 TTL，读取即删，避免长时间挂着的会话泄漏内存。
- 新增四套离线自检脚本：`schema-check.mjs`、`smoke.mjs`、`integration.mjs`、`verify-profile.mjs`。

## 0.1.1

- 修复客户端挂载失败：rc.6 客户端仅挂载编译期生成的 Remote 清单（`dsh-api-remotes`），运行时注册的 `remote.mimoVision` 永远 pending；改为经内置 connection RPC 通道直连宿主 gateway（宿主端 SRC 回退链路）。

## 0.1.0

- 由动态插件 pkg-14 迁移为全局静态插件（通信层改用 typert Remote，逻辑等价）。
