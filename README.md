# MiMo 视觉识别（DSH 全局插件）

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）具备**图片识别能力**的全局插件：对接小米 [MiMo](https://platform.xiaomimimo.com) 模型，发送带图片的消息时自动调用 MiMo 识别，识别结果作为上下文注入对话，主模型即可正常回复——不再被"当前模型不支持图片"挡住。

> 这是**全局静态插件**：安装一次，所有会话共享，重启部署后依然生效（不同于会话级动态插件）。

## ✨ 功能特性

- 🖼️ **发送即识别**：聊天框粘贴/上传图片后发送，自动调用 MiMo 识别，结果注入上下文，agent 直接围绕图片内容回复
- 🔧 **全局工具** `mimo_analyze_image`：所有会话可见，支持本地图片路径 / http(s) URL / base64 图片
- ⚙️ **配置卡片**：设置 → 插件 → 插件配置 →「MiMo 视觉」，样式与内置"网页搜索"卡片一致
- 🛡️ **原生回退**：插件未启用 / 自动识别开关关闭 / 未配置密钥 / MiMo 调用失败时，一律回退 DSH 原生流程，保留"当前模型不支持图片"提示，绝不静默吞图
- 🔐 **密钥安全**：API Key 存储在部署凭据（`MIMO_VISION_CONFIG`），不落配置文件、不进代码仓库

## 📥 获取源码

```bash
git clone https://gitee.com/liiikk/dsh-mimo-vision.git
```

## 🚀 一键安装

### 推荐：`node install.mjs`

```bash
git clone https://gitee.com/liiikk/dsh-mimo-vision.git
cd dsh-mimo-vision
node install.mjs
```

脚本自动完成三步：**定位 dsh 安装目录 → 拷贝插件包 → 写入组合补丁**（幂等，重复执行安全，已有旧版自动覆盖）。装完后重启 dsh 服务、刷新页面，到配置卡片填 API Key 即可。

> 为什么不是 `npm install`？DSH 插件的加载需要"包文件 + 组合注册行"两件事，而组合注册行（`cordis.patch.yml`）不在 npm 的管理范围内，所以用脚本把两步合并为一条命令。

### 手动安装（备选）

1. 把仓库里的 `@deepseek-ai/dsh-mimo-vision/` 目录整体拷到 dsh 安装目录的包目录下（与内置包同目录）：

   ```
   <dsh安装目录>\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-mimo-vision\
   ```

2. 在 profile 补丁文件 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 中追加：

   ```yaml
   - insert:
       - id: mimo-vision
         name: '@deepseek-ai/dsh-mimo-vision'
   ```

3. 重启 dsh 服务并刷新页面。

### 换一台电脑

重复上面的安装步骤即可；重启后到配置卡片里**单独填写一次 API Key**（凭据按机器隔离）。

## ⚙️ 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| API Key | 空 | 小米开放平台获取；`sk-` 开头为按量付费，`tp-` 开头为 Token 套餐 |
| 接口地址 | `https://api.xiaomimimo.com/v1` | 按量付费与 Token 套餐使用不同地址 |
| 模型 | `mimo-v2.5-pro` | 官方标注 `mimo-v2.5` 亦支持图片理解，可切换 |
| 最大输出 tokens | `2048` | 识别结果长度上限 |
| 温度 | `0.3` | 0–2，越低越稳定 |
| 发送时自动用 MiMo 识别图片 | 开 | 关闭后按原生方式发送图片，保留"不支持图片"提示 |
| 默认提示词 | 中文描述提示 | 未写提示词时用于描述图片 |
| 系统提示词 | 内置 | 可自定义 MiMo 的角色设定 |

## 🧰 使用

**方式一：自动识别**（推荐）
保持"发送时自动用 MiMo 识别图片"开启，聊天框直接粘贴图片发送即可。消息正文可不写文字，识别后 agent 会自动基于图片内容回复。

**方式二：工具调用**
agent 在对话中直接调用 `mimo_analyze_image` 工具分析图片：

```json
{
  "image": "C:\\Users\\me\\Pictures\\screenshot.png",
  "prompt": "这张图里有哪些文字？"
}
```

## 🔬 工作原理

```
[浏览器] 发送带图消息 ── 插件拦截（已配置+开启?）──> [宿主] mimoVision.prepare()
                                 │ 否（回退原生流程，保留原生提示）
[宿主] agent/pre-step 事件 ── 逐张调用 Node 子进程 ──> MiMo API
[宿主] 识别结果注入步骤上下文 ──> agent 正常回复
```

- **宿主端**：`TypertRemoteService` 子类注册 Remote 服务 `mimoVision`（`configGet` / `configSet` / `test` / `prepare` / `analyzeData`），注册全局工具，监听 `agent/pre-step` 注入上下文；图片经真实 Node 子进程（`subprocess` 服务 + 内嵌脚本）Base64 编码后请求 MiMo API
- **浏览器端**：`settings.plugin.item` 槽注册配置卡片；经内置 connection RPC 通道（`/api/mimoVision/*`）直连宿主 Remote；发送拦截仅在 插件存活 + 开启 + 已配置 时生效，其余情况回退原生

## 📦 目录结构

```
@deepseek-ai/dsh-mimo-vision/
├── package.json        # 包声明：dsh.client、exports["./client"]
└── lib/
    ├── index.js        # 宿主端（编译后形态，Node 22 免编译直接加载）
    └── client.js       # 浏览器端（window.__ModuleLoader__.load 格式）
```

## 📌 版本历史

- **0.1.1** — 修复客户端挂载失败：rc.6 客户端仅挂载编译期生成的 Remote 清单（`dsh-api-remotes`），运行时注册的 `remote.mimoVision` 永远 pending；改为经内置 connection RPC 通道直连宿主 gateway（宿主端 SRC 回退链路，实测标记正确）
- **0.1.0** — 由动态插件 pkg-14 迁移为全局静态插件（通信层改用 typert Remote，逻辑等价）

## 📄 许可证

MIT
