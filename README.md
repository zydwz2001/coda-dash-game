# CODE / 26

支持 Dash（`-`）百搭牌规则的多人在线《达芬奇密码》实现。静态前端使用原生 JavaScript 和 Tailwind CSS，权威后端使用 Node.js、Express 与 Socket.IO。

在线前端：<https://zydwz2001.github.io/coda-dash-game/>

## 功能

- 2–4 人房间、准备状态、房主开局与刷新重连
- 黑白 `0–11` 加黑白 Dash，共 26 张牌
- `LOBBY → SETUP_DASH → PLAYING → FINISHED` 服务端状态机
- 摸牌、Dash 插入、猜牌、连续猜测、淘汰和胜者判定
- 服务端为每位玩家生成独立状态，不向对手下发暗牌值

## 本地运行

需要 Node.js 20+，并打开两个终端。

### 1. 启动后端

```bash
git clone https://github.com/zydwz2001/coda-dash-game.git
cd coda-dash-game/backend
npm ci
npm start
```

后端默认监听 <http://localhost:3000>，健康检查地址为 <http://localhost:3000/health>。

### 2. 启动前端

```bash
cd coda-dash-game/frontend
npm ci
npm run build
npm run serve
```

打开 <http://localhost:4173>。本地页面默认连接 `http://localhost:3000`；连接地址也可在页面右上角修改。

## 配置

后端支持：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP / Socket.IO 端口 |
| `CORS_ORIGINS` | 空 | 允许的前端 Origin，多个值用英文逗号分隔 |

例如：

```bash
CORS_ORIGINS=https://example.github.io npm start
```

要部署自己的公开后端，请修改 `frontend/app.js` 中的 `PUBLIC_BACKEND_URL`，然后重新构建前端。

## 测试

后端集成测试：

```bash
cd backend
npm test
```

双浏览器端到端测试：

```bash
cd frontend
npm run build
npx playwright install chromium
npm run test:e2e
```

测试产物写入 `frontend/artifacts/`、`frontend/test-results/` 和 `frontend/playwright-report/`，这些目录不会提交。

## 临时公网联机

本地后端启动后，可另开终端运行：

```bash
cd backend
npm run tunnel
```

把输出的 HTTPS 地址填入前端连接设置。GitHub Pages 使用 HTTPS，远程后端也必须使用 HTTPS。

## GitHub Pages

1. 在仓库 **Settings → Pages** 中把 Source 设为 **GitHub Actions**。
2. 推送到 `main`，或手动运行 `Deploy frontend to GitHub Pages`。
3. 工作流会发布 `frontend/`。

房间状态只存在后端内存中，服务重启会清空房间。长期多实例部署需要共享状态存储和 Socket.IO Adapter。

## 目录

```text
backend/                       服务端、集成测试与 Dockerfile
frontend/                      静态前端
frontend/tests/                Playwright 端到端测试
.github/workflows/             GitHub Pages 部署工作流
```
