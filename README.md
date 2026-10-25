# 应用下载站 · App Download Hub

一个纯静态的开源应用下载站：**站点托管在 GitHub Pages，安装包托管在 GitHub Releases**。
零后端、零构建依赖，加应用只改一个 JSON。

线上地址：<https://prodesign2021.github.io/app-download-hub/>

---

## 它解决什么问题

- 下载直连 GitHub Releases 官方资产，不经第三方网盘中转，无广告无捆绑；
- 安装包文件名随版本变化（`VSCodeUserSetup-x64-1.105.0.exe`），站点运行时通过 GitHub API
  用正则匹配最新 release 里**真实存在**的资产，不会给出 404 死链；
- 匹配失败或 API 限流时自动回退到「发布页」按钮，用户永远有路可走。

## 目录结构

```
.
├── index.html                  # 页面骨架
├── assets/
│   ├── styles.css              # 样式（深浅色主题、响应式）
│   └── app.js                  # 渲染、搜索筛选、资产解析
├── data/apps.json              # 应用清单（唯一需要日常维护的文件）
├── scripts/
│   ├── publish.mjs             # 自托管应用：上传安装包到 Releases 并同步清单
│   └── check-data.mjs          # 清单结构校验（CI 与本地都跑）
├── demo/                       # 示例应用源码，用于验证发布链路
└── .github/workflows/pages.yml # 推 main 自动部署 Pages
```

## 本地预览

```bash
npm run dev          # http://localhost:4321
npm run check        # 校验 app.js 语法 + apps.json 结构
```

> `fetch('data/apps.json')` 需要 HTTP 协议，直接双击 `index.html` 打不开，请用上面的本地服务器。

## 添加一个应用

编辑 `data/apps.json`，在 `apps` 数组里追加一项：

```json
{
  "id": "localsend",
  "name": "LocalSend",
  "tagline": "局域网跨设备传文件",
  "description": "不经过服务器，同一 WiFi 下互传文件……",
  "category": "工具",
  "repo": "localsend/localsend",
  "icon": "📡",
  "accent": "#0ea5e9",
  "downloads": [
    { "platform": "windows", "label": "Windows x64", "match": "^LocalSend-.*-windows-x86-64\\.exe$" },
    { "platform": "macos",   "label": "macOS",       "match": "^LocalSend-.*\\.dmg$" }
  ]
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | kebab-case，全局唯一 |
| `name` / `tagline` / `description` | ✅ | 卡片标题、副标题、两行描述 |
| `repo` | ✅ | `owner/name`，用于拉取 latest release |
| `downloads[].platform` | ✅ | `windows` / `macos` / `linux` / `android` |
| `downloads[].match` | ✅ | 匹配资产文件名的正则，**先匹配到的胜出** |
| `downloads[].asset` | ⬜ | 兜底：直接拼 `releases/latest/download/<asset>` |
| `category` | ⬜ | 分类筛选的取值，新分类会自动出现在筛选栏 |
| `icon` / `accent` | ⬜ | 卡片图标与主题色 |
| `featured` | ⬜ | 是否置顶并显示「推荐」徽标 |

改完跑一次 `npm run check`，再 commit + push，Pages 会自动重新部署。

## 发布自托管应用版本

外部项目（VS Code、OBS 等）直接用它们的官方 Release，不需要你发布任何东西。
只有**托管在本仓库**的应用（如示例应用 `harness-demo`）需要走发布脚本：

```bash
# 1. 打包（示例：把 demo/ 压成两个平台的 zip）
mkdir -p dist
zip -qr dist/harness-demo.windows.zip demo -x '*.DS_Store'
zip -qr dist/harness-demo.macos.zip   demo -x '*.DS_Store'

# 2. 发布：创建 release + 上传资产 + 同步 apps.json
node scripts/publish.mjs --app harness-demo --version 0.1.0 \
  --file dist/harness-demo.windows.zip \
  --file dist/harness-demo.macos.zip \
  --notes "首个测试版本" --commit
```

脚本会：

1. 校验版本号、文件存在、`gh` 登录状态；
2. 创建 `v<version>` release 并上传资产（已存在则覆盖上传）；
3. 逐个检查 `apps.json` 里的 `match` 正则是否命中真实资产，不命中的打印 ⚠；
4. 回写 `data/apps.json` 的 `version` / `updated`；
5. 带 `--commit` 时自动 commit + push，触发 Pages 重新部署。

加 `--dry-run` 只看命令不执行。

## 部署与首次配置

1. 推送到 `main` 后，Actions 里的 **Deploy to GitHub Pages** 会自动构建部署；
2. 仓库需在 **Settings → Pages → Source** 选择 **GitHub Actions**（首次可用下面命令切换）：
   ```bash
   gh api -X POST repos/prodesign2021/app-download-hub/pages -f build_type=workflow
   ```
3. 站点地址：`https://prodesign2021.github.io/app-download-hub/`

## 运行原理

```
浏览器
  ├─ GET data/apps.json ─────────────► 渲染卡片 + 骨架屏
  ├─ GET api.github.com/repos/{repo}/releases/latest  （限 4 并发）
  │     ├─ 命中 match 正则 → 按钮指向 browser_download_url（带真实体积）
  │     ├─ 未命中 → 按钮回退到 /releases/latest
  │     └─ 403/429 → 全站提示限流，按钮回退发布页
  └─ 解析结果写入 localStorage，30 分钟内不重复请求
```

匿名访问 GitHub API 限流为 **每小时 60 次/IP**，当前清单约 7 个仓库，正常浏览远低于上限；
`localStorage` 缓存与并发限制进一步压低请求数。若需更高额度，可在 `assets/app.js` 的
fetch 头里加 Token（不建议把它写进前端仓库）。

## 安全提醒

本项目的 GitHub 登录只使用 `gh` 的设备码授权 / Token，**任何时候都不需要、也不应该把
账号密码写进仓库或聊天记录**。如果你曾在不受信任的地方粘贴过密码，请立刻到
<https://github.com/settings/security> 修改密码并开启 2FA。

## 许可

站点代码 MIT；各应用图标与安装包版权归各自项目作者所有。
