# 多平台去水印解析工具

粘贴短视频分享链接，一键解析并下载**无水印**原视频 / 高清原图。

零依赖（只用 Node.js 内置模块 + 全局 fetch），无需 `npm install`。

## 支持的平台

| 平台 | 状态 | 说明 |
|---|---|---|
| 抖音 | ✅ 实测可用 | 视频、图集、笔记均支持，含短链/口令/长链 |
| 哔哩哔哩 | ✅ 实测可用 | 视频 + 封面（未登录最高 360P） |
| 快手 | ⚠️ 未实测 | 接口已适配，缺少可用链接验证 |
| 小红书 | ⚠️ 未实测 | 风控较严，可能需要第三方 API |
| 微博 | ⚠️ 未实测 | 视频 + 图集已适配 |

## 本地运行

```bash
cd watermark-remover
node server.js
# 浏览器打开 http://localhost:3000
```

可选环境变量：
- `PORT` 端口（默认 3000）
- `DEBUG=1` 开启解析/下载调试日志
- `THIRD_PARTY_API` 第三方兜底解析 API

## 工作原理

1. **链接还原**：从分享口令文本中提取链接，短链跟随重定向拿到真实作品 ID
2. **风控绕过**：抖音需先向 `ttwid.bytedance.com` 注册设备凭证，带 cookie 请求分享页才能拿到内嵌数据
3. **去水印**：视频地址中 `playwm`（带水印）替换为 `play`（无水印）
4. **代理下载**：服务端流式转发，自动补 Referer 绕过防盗链，支持重定向和断点续传

## 目录结构

```
watermark-remover/
├── server.js                  # 本地 HTTP 服务（Node 原生，node server.js 启动）
├── package.json               # type: module（零依赖）
├── scripts/
│   └── build.mjs              # EdgeOne 部署前打包：生成 dist/
├── cloud-functions/           # EdgeOne Pages 边缘函数（部署到 EdgeOne 时使用）
│   └── api/
│       ├── parse/index.js        # POST  /api/parse
│       ├── download/index.js     # GET  /api/download
│       ├── image/index.js        # GET  /api/image
│       └── platforms/index.js    # GET  /api/platforms
│       └── _proxy.js             # 下载/图片代理共享逻辑
├── lib/
│   ├── http.js                # 请求封装（重定向、解压、UA）
│   ├── referer.js             # 防盗链 Referer 猜测
│   └── parsers/               # 各平台解析器（ESM）
│       ├── douyin.js          # 抖音（ttwid + 多策略降级）
│       ├── kuaishou.js        # 快手
│       ├── bilibili.js        # B站
│       ├── weibo.js           # 微博
│       └── xiaohongshu.js     # 小红书
└── public/                    # 前端页面（本地开发 / 部署源）
    ├── index.html
    ├── style.css
    └── app.js
```

两套入口共用 `lib/`：本地用 `server.js`（原生 http 服务），上线用 `cloud-functions/`（EdgeOne 边缘函数），逻辑一致。

## API

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/parse` | POST | `{url, thirdPartyApi?}` → 解析结果 |
| `/api/download?url=&name=` | GET | 代理下载（附件） |
| `/api/download?url=&inline=1` | GET | 在线预览 |
| `/api/image?url=` | GET | 图片/封面代理 |
| `/api/platforms` | GET | 平台列表 |

> 设置里的第三方 API 存于浏览器 `localStorage`（serverless 环境无状态，不写服务端），解析时随请求带上。

## 部署到 EdgeOne Pages（推荐）

EdgeOne Pages 提供**国内节点**，解析抖音/快手的成功率比海外服务器高得多。

### 方式一：连 GitHub 自动部署

1. 确保代码已推送到 GitHub（本项目已对应 `LIF1FFF/watermark-remover`）
2. 打开 [EdgeOne Pages 控制台](https://console.edgeone.ai/pages) → 新建项目 → 连接 GitHub → 选中 `watermark-remover`
3. 构建设置：
   - **框架预设**：`Others`（无框架）
   - **安装命令**：留空（零依赖，无需 npm install）
   - **构建命令**：`npm run build`
   - **输出目录**：`dist`
4. 点击「部署」，等待完成
5. `dist/cloud-functions/` 目录下的函数会自动挂载到对应 `/api/*` 路由

> 为什么输出目录是 `dist` 而不是 `public`？因为 `cloud-functions/` 里的函数通过相对路径 `../../lib/` 引用了 `lib/`，必须把 `public/` 的静态文件、`cloud-functions/`、`lib/`、`package.json` 一起打包到同一个根目录。`npm run build` 会自动完成这件事。

### 路由映射

| 函数文件 | 线上路由 |
|---|---|
| `cloud-functions/api/parse/index.js` | `https://你的域名/api/parse` |
| `cloud-functions/api/download/index.js` | `https://你的域名/api/download` |
| `cloud-functions/api/image/index.js` | `https://你的域名/api/image` |
| `cloud-functions/api/platforms/index.js` | `https://你的域名/api/platforms` |

### 方式二：GitHub Actions 自动部署

（可选）如需改用 GitHub Actions 推送部署，自行在仓库创建 `.github/workflows/deploy.yml` 并配置 Secret `EDGEONE_API_TOKEN`（值取 EdgeOne Pages 控制台生成的 API Token）。

本仓库默认推荐 **方式一（Git 集成）**：push 到 `main` 即由 EdgeOne 自动执行 `npm run build` 并部署，无需额外配置。

### 可选：配置第三方兜底 API

在项目环境变量（控制台「环境变量」）中添加：

```
THIRD_PARTY_API=https://your-api.com/parse?url={{url}}
```

`{{url}}` 会被自动替换为待解析链接；官方接口失效时自动切换过去。

> 若 EdgeOne 要求函数目录名为 `node-functions` 而非 `cloud-functions`，直接重命名该目录即可，内部结构不变。

## 其他部署方式

- **Nginx + Node**：`node server.js` 后由 Nginx 反代
- **Vercel / Render**：把 `server.js` 改造成平台函数入口（本项目 `cloud-functions/` 已给出边缘函数范式，可参照迁移）

> 部署在**国内服务器**解析成功率最高。抖音等平台对海外 IP 有额外限制。

## 常见问题

**Q：解析失败？**
- 确认链接完整（从 `https://` 开始）
- 视频可能已删除或设为私密
- 抖音风控较严，可稍后重试或在设置中配置第三方 API

**Q：下载的文件无法播放？**
- 检查文件是否为 0 字节（多为防盗链 403，检查服务端 Referer 配置）
- 部分平台地址有时效，过期需重新解析

## 免责声明

仅供下载本人拥有版权的作品，请勿用于侵犯他人知识产权的用途。
