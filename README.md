# 5Why 分析审核工具（AI 逻辑链校验）

审核他人已完成的 5Why 分析：**一次性**填写问题背景 + 逐层「为什么 / 分析」（最多 5 层，后几层可选，无需凑满），AI 逐层审核整条逻辑链是否存在漏洞（答非所问、跳层、猜测当事实、归咎个人、过早停止等），输出结论、漏洞清单、逐层点评与修改建议。

与 `5why`（对话式引导分析）的区别：**输入方式与功能定位不同，其余（界面风格、会话历史、设置、导出报告、双模式运行）保持一致**。

支持**两种运行方式**：本地模式（Node 代理）和 GitHub Pages 静态部署（浏览器直连 AI，使用者自填 Key）。

## 方式一：本地运行

```bash
cd server
npm install
npm start
```

访问 http://localhost:3001（AI 调用走 `server/server.js` 代理，配置见其顶部 `AI_CONFIG`；端口 3001，与 5why 项目的 3000 互不冲突）。

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
- 在表单中填写：问题背景（可选）、第 1 层「为什么 + 分析」（必填）、第 2~5 层（可选，按实际层数填，留空即忽略）、问题总结（可选）
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
├── app.js                   # 自动识别本地/部署模式
├── promt.txt                # AI 审核提示词（修改后部署即生效）
├── server/                  # 本地模式：Node 代理服务
│   ├── server.js            #   Express + AI 代理（AI_CONFIG 在此配置，默认端口 3001）
│   └── package.json
└── .github/workflows/deploy.yml  # GitHub Actions 部署工作流（可选）
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

服务端自动注入 `promt.txt` 作为系统提示词（最多携带最近 30 条消息）。返回 SSE 流：`data: {"type":"chunk","content":"..."}` 直至 `data: {"type":"done"}`。

## 页面功能

- 表单审核：问题背景 + 1~5 层「为什么 / 分析」一次性提交（第 2~5 层可选，填一半会提示补全），Enter 提交，Shift+Enter 换行
- 链条回显：提交后以「编号 + 逐层卡片」形式展示原链条，AI 结论按 合格/基本合格/不合格 着色
- 审核记录：多记录自动保存至浏览器 localStorage，侧边栏可新建 / 切换 / 删除 / 清空
- API 设置：部署模式下使用者自填 Key / 接口地址 / 模型（存 localStorage）
- 导出报告：将当前审核记录导出为 Markdown
