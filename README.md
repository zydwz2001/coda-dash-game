# CODE / 26

支持 Dash（`-`）百搭牌规则的网页版《达芬奇密码》。前端为纯 HTML、Tailwind CSS 和原生 JavaScript，后端为 Node.js、Express 与 Socket.IO。

## 已实现

- 2–4 人房间、准备状态与房主开局
- 黑白 `0–11` 及黑白 Dash，共 26 张牌
- `LOBBY → SETUP_DASH → PLAYING → FINISHED` 服务端状态机
- 开局 Dash 任意位置调整；数字牌保持升序，同数字黑牌在白牌左边
- Dash 玩家完成准备前，对手看不到该玩家的颜色、牌值或手牌数量
- 回合摸牌、Dash 插入、猜数字或 Dash、继续猜牌、结束回合
- 猜错时强制翻开并归位本回合摸到的牌
- 淘汰与最终胜者判定
- 基于 `playerToken` 的刷新重连和原座位、原手牌恢复
- 每位玩家单独生成的 `game_state`，不会下发对手暗牌的 `value`

## 目录

```text
Coda/
├── backend/
│   ├── server.js
│   ├── server.test.js
│   ├── e2e-server.js
│   └── package.json
├── frontend/
│   ├── index.html
│   ├── app.js
│   ├── src.css
│   ├── styles.css
│   ├── tests/
│   └── vendor/
└── .github/workflows/deploy-pages.yml
```

## 本地启动

需要 Node.js 20 或更高版本。

### 1. 启动后端

```bash
cd backend
npm ci
npm start
```

默认监听 `http://localhost:3000`，健康检查为：

```text
http://localhost:3000/health
```

### 2. 启动前端

打开另一个终端：

```bash
cd frontend
npm ci
npm run build
npm run serve
```

访问：

```text
http://localhost:4173
```

前端默认使用 `http://localhost:3000`。首页不建立连接；创建、加入或刷新现有房间时才连接后端，退出房间后主动断开。冷启动期间会自动重试并在连接成功后继续刚才的操作。

## Localtunnel 联机测试

先保持后端运行，再打开另一个终端：

```bash
cd backend
npm run tunnel
```

命令会输出类似：

```text
https://example-name.loca.lt
```

在前端右上角打开连接设置，粘贴该 HTTPS 地址。GitHub Pages 本身使用 HTTPS，因此远程后端也必须使用 HTTPS，不能填 `http://localhost:3000`。

客户端初始化包含：

```js
io(BACKEND_URL, {
  extraHeaders: {
    "Bypass-Tunnel-Reminder": "true",
  },
});
```

后端同时允许该自定义请求头通过 CORS。若需要限制正式环境来源，可在启动后端时设置：

```bash
CORS_ORIGINS=https://YOUR-NAME.github.io npm start
```

多个来源使用英文逗号分隔。

## GitHub Pages

把 `Coda` 目录作为仓库根目录推送到 GitHub，然后：

1. 打开仓库的 **Settings → Pages**。
2. 将 **Build and deployment / Source** 设为 **GitHub Actions**。
3. 推送到 `main`，或在 Actions 页面手动运行 `Deploy frontend to GitHub Pages`。

工作流会直接发布 `frontend/`。页面加载后，在连接设置中填写 Localtunnel 的 HTTPS 地址。

## 测试

后端 Socket.IO 集成测试：

```bash
cd backend
npm test
```

双浏览器端到端测试：

```bash
cd frontend
npm run build
npm run test:e2e
```

端到端测试会自动启动固定牌序的测试后端和静态前端，使用两个隔离 Chromium 浏览器验证：

- 建房、加入和双方准备
- Dash 开局遮罩与位置调整
- 摸牌和猜错翻牌
- 跨玩家回合状态
- 刷新后 `playerToken` 不变并恢复原手牌

测试截图保存在：

```text
frontend/artifacts/coda-game-after-rejoin.png
```

## Socket 事件

客户端到服务端：

```text
create_room
join_room
rejoin_room
set_ready
start_game
confirm_dash_position
draw_tile
place_drawn_dash
guess_tile
continue_guess
end_turn
```

服务端到客户端：

```text
room_state
game_state
action_error
session_replaced
```

所有行动均通过 Socket 当前绑定的服务端身份判定，客户端提交的玩家身份不会被信任。

## 当前运行边界

房间保存在后端内存中。浏览器刷新不会丢失身份，但后端进程重启会清空所有房间。正式长期部署时可再接入 Redis，并增加房间过期清理和多实例 Socket.IO Adapter。
