# 5Why 分析审核工具（AI 逻辑链校验）

审核他人已完成的 5Why 分析：**一次性**填写问题背景 + 逐层「为什么 / 分析」（可扩充至最多 10 层，后几层可选，无需凑满），AI 逐层审核整条逻辑链是否存在漏洞（答非所问、跳层、猜测当事实、归咎个人、过早停止等），输出结论、漏洞清单、逐层点评与修改建议。

与 `5why`（对话式引导分析）的区别：**输入方式与功能定位不同，其余（界面风格、会话历史、设置、导出报告、双模式运行）保持一致**。

支持**两种运行方式**：本地模式（Node 代理）和 GitHub Pages 静态部署（浏览器直连 AI，使用者自填 Key）。

## 方式一：本地运行

```bash
cd server
npm install
npm start
```

访问 http://localhost:3001（AI 调用走 `server/server.js` 代理；端口 3001，与 5why 项目的 3000 互不冲突）。

### 配置（推荐用环境变量，不要把 Key 提交进仓库）

```powershell
$env:AI_API_KEY   = "你的Key"                                          # 必填，否则走内置模拟回复
$env:AI_ENDPOINT  = "https://open.bigmodel.cn/api/paas/v4/chat/completions"  # 可选
$env:AI_MODEL     = "glm-4.7-flash"                                    # 可选
$env:AI_CONCURRENCY = "1"        # 同时发给 AI 的请求数（免费档一般填 1）
$env:AI_QUEUE_LIMIT = "20"       # 最多允许多人排队，超出直接提示稍后再试
$env:AI_MAX_RETRIES = "3"        # 遇到限流/过载时自动重试次数
npm start
```

也可直接改 `server/server.js` 顶部的 `AI_CONFIG`（环境变量优先）。未配置 Key 时返回内置模拟回复，便于先跑通界面。

### 排队与限流（多人同时使用时的重要保障）

免费模型档位通常只允许 **1 个并发**，两人同时提交，后者会直接吃到 `1302 触发用户速率限制` 报错。因此 `server.js` 内置了**全局串行队列**：

- 所有使用者的提交排成一条队，按先来后到一个一个发给 AI；
- 排队中的使用者会在界面上看到「**排队中：前面还有 N 位**」，位置会随前面的人完成而自动前移；
- 遇到 `1302`/`1305`/`429`（限流、平台过载）会自动退避重试，不会把报错直接甩给使用者；
- 使用者中途关掉页面，会自动从队列里移除，不占位置；
- 队列超过上限时返回「当前排队人数过多，请稍后再试」。

> 注意：这套队列只在**本地/内网模式**（跑 `server.js`）下有效。GitHub Pages 静态部署没有服务端，浏览器是直连 AI 的，无法跨使用者排队；那种模式下每个使用者用各自的 Key，浏览器侧只能保证自己不发并发请求，并对限流做退避重试。

### 换 AI 供应商 / 换模型

**改 `providers.json` 即可，不需要动任何代码**——这个文件就是设置弹窗里那个「服务提供方」下拉框的内容来源。改完 push，GitHub Pages 会自动生效（使用者按 Ctrl+F5 强制刷新）。

```json
{
  "default": "zhipu",
  "providers": [
    { "id": "zhipu", "name": "智谱 GLM（有完全免费的档位）",
      "endpoint": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      "model": "glm-4.7-flash", "needKey": true, "thinking": "disabled",
      "hint": "glm-4.7-flash 免费；注意不要选带 X 的 flashx，那个收费。" },
    { "id": "custom", "name": "自定义（自己填地址和模型）",
      "endpoint": "", "model": "", "needKey": true, "thinking": "auto" }
  ]
}
```

- 每个供应商可配 `endpoint` / `model` / `needKey` / `thinking` / `mode` / `hint`
- `"thinking"` 支持 `disabled`（发并关闭推理）/ `omit`（不发）/ `auto`（先试，接口不认该参数就自动去掉重试一次）
- 读不到这个文件时前端会用内置兜底预设，不影响使用

**内部网关不需要在这里配置**：当使用者直接用浏览器打开网关机器提供的网址（`http://网关IP:3001`）时，页面由网关自己发出，前端会自动探测到 `gateway.json` 标记并切到网关模式（同源、免 Key、享排队）。

> ⚠️ 反过来不成立：如果网页是从 https 站点（GitHub Pages）打开的，浏览器会以**「混合内容」**拦截对 http 网关的请求。因此代码里会**自动把这类用不了的网关供应商从下拉框里隐藏**，并在万一被选中时给出明确提示。要做"使用者零配置 + 自动排队"的形态，见 **[部署指南-内网网关.md](部署指南-内网网关.md)**（含一键启动脚本 `启动网关.cmd`）。

## 方式二：GitHub Pages 部署（供他人使用）

站点文件在**仓库根目录**，GitHub Pages 由浏览器直接调用大模型 API，每个使用者点击「设置」填入自己的 API Key（仅存于各自浏览器 localStorage，不会泄露你的 Key）。

### 启用步骤（设置一次即可）

1. 打开仓库 Settings → Pages
2. **Source 选择「Deploy from a branch」**
3. Branch 选择 **`main`**，目录选择 **`/ (root)`** → 点 Save
4. 等待 1-2 分钟（首次构建），访问 `https://<你的用户名>.github.io/<仓库名>/`

之后每次 `git push` 都会自动重新部署。

> 若希望使用 GitHub Actions 方式（需 Source 选「GitHub Actions」），本仓库已附带 `.github/workflows/deploy.yml`，两种方式均可。

### 使用说明

- 打开页面后点击右上角「设置」，填写自己的 **API Key**（DeepSeek 开放平台申请，默认可不改接口地址与模型）
- 在表单中填写：问题背景（可选，建议填写）、第 1 层「为什么 + 分析」（必填）、点击「＋ 添加下一层」可继续扩充至最多 10 层（留空即忽略，每层右侧 × 可删除）、问题总结（必填）
- 点击「提交审核」，AI 输出：结论（合格/基本合格/不合格）、漏洞数、漏洞清单、逐层点评、修改建议
- 修改提示词：编辑根目录 `promt.txt` 后推送即可

### 注意事项

- 仅 DeepSeek 等允许浏览器跨域（CORS）的接口可直接使用；更换其他供应商时若提示跨域错误，需改用方式一
- 页面地址若部署在非仓库根路径，所有资源均为相对路径引用，无需额外配置

## 目录结构

```
5why_check/
├── index.html               # 站点根目录（GitHub Pages 部署内容）
├── style.css
├── app.js                   # 自动识别本地/部署模式；含浏览器侧串行队列与排队状态显示
├── promt.txt                # AI 审核提示词（修改后部署即生效）
├── providers.json           # ★ 供应商预设：换 AI 供应商 / 换模型在这里改，不用动代码
├── 启动网关.cmd             # 内网网关一键启动（首次运行引导填 Key、自动装依赖）
├── 部署指南-内网网关.md      # 把工具部署成「使用者零配置 + 自动排队」的完整步骤
├── server/                  # 本地模式：Node 代理服务（这份代码同时就是内网网关）
│   ├── server.js            #   Express + AI 代理 + 全局串行队列（默认端口 3001）
│   └── package.json
├── test/                    # 回答质量测试台（可复跑，见 test/README 说明）
│   ├── run-test.mjs         #   真机测试：格式/一致性/截断/前端兼容 + 对照标准答案
│   ├── test-queue.mjs       #   队列验证：并发打多个请求，检查是否真的串行
│   ├── probe-format.mjs     #   抽取 app.js 真实 formatAI 做渲染取证
│   ├── probe-models.mjs     #   探测各模型可用性/限流
│   ├── cases/               #   带标准答案的 5Why 用例
│   └── reports/             #   历次测试报告
└── .github/workflows/deploy.yml  # GitHub Actions 部署工作流（可选）
```

### 回归测试怎么跑

```powershell
# 队列是否真的串行（先按上面的方式启动带队列的服务）
cd test; node test-queue.mjs

# 回答质量回归（直连模型，需要 Key）
$env:ZHIPU_API_KEY="你的Key"
node run-test.mjs --provider zhipu --model glm-4-flash-250414 --thinking none --max-tokens 2000

# 检测逻辑离线自检（不需要 Key）
node run-test.mjs --selftest
```

## 接口说明（本地模式）

`POST /api/5why/review`，请求体为完整审核记录：

```json
{
  "messages": [
    { "role": "user", "content": "【问题背景】\n...\n【第 1 层】\n问题：...\n分析：..." }
  ]
}
```

服务端自动注入 `promt.txt` 作为系统提示词（最多携带最近 6 条提交内容）。返回 SSE 流，事件类型：

```
data: {"type":"queued","ahead":2,"running":1,"total":3}   排队中，前面还有 2 位
data: {"type":"start"}                                    开始处理
data: {"type":"retry","attempt":1,"waitMs":3000,...}      被限流，等待后自动重试
data: {"type":"chunk","content":"..."}                    逐段返回内容
data: {"type":"done"}                                     结束
data: {"type":"error","message":"..."}                    失败
```

## 页面功能

- 表格导入：点击「下载模板」获取规定格式的 .xlsx 模板（字段 / 问题（为什么） / 分析（解答）三列），填写后点「上传表格」自动识别「问题背景」「第 1~10 层」「问题总结」并填充表单（支持 .xlsx/.xls/.csv，CSV 自动兼容 GBK 编码）；若当前记录已提交过，会自动新建一条记录再填充
- 表单审核：问题背景 + 1~10 层「为什么 / 分析」一次性提交（第 2 层起可选，填一半会提示补全），Enter 提交，Shift+Enter 换行；提交后输入区隐藏、对话区占满
- 链条回显：提交后以「编号 + 逐层卡片」形式展示原链条；AI 输出总评分（0~100 大号数字 + 进度条，按分着色）、结论（合格/基本合格/不合格着色）、漏洞清单整条高亮、逐层点评附（N/10）得分徽章、问题词句黄色标记
- 审核记录：多记录自动保存至浏览器 localStorage，侧边栏可新建 / 切换 / 删除 / 清空
- API 设置：部署模式下使用者自填 Key / 接口地址 / 模型（存 localStorage）；**首次打开若未配置，会自动弹出设置窗**，避免填完整份分析才发现要配 Key。供应商列表来自 `providers.json`，选中即自动填好地址与模型
- 导出报告：将当前审核记录导出为 Markdown
- 备份 / 恢复记录：把全部审核记录导出为一个 JSON 文件，或从该文件导入合并（不覆盖现有记录；id 重复的会另存为新记录）。用于换电脑、清缓存前留底，或把记录交给别人
