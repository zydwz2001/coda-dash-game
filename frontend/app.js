(() => {
  "use strict";

  const STORAGE_KEYS = {
    playerToken: "coda.playerToken",
    nickname: "coda.nickname",
    roomCode: "coda.roomCode",
    backendUrl: "coda.backendUrl",
  };
  const DASH = "-";

  const app = document.querySelector("#app");
  const toastRoot = document.querySelector("#toast-root");
  const query = new URLSearchParams(window.location.search);
  const randomNames = [
    "夜行侦探",
    "白塔学者",
    "黑猫推理家",
    "密码收藏家",
    "雾都观察员",
    "十一号证人",
  ];

  const storage = {
    get(key, fallback = "") {
      try {
        return window.localStorage.getItem(key) || fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Private browsing can deny storage. The current session still works.
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Ignore unavailable storage.
      }
    },
  };

  function createPlayerToken() {
    if (window.crypto?.randomUUID) {
      return window.crypto.randomUUID();
    }
    const bytes = new Uint8Array(24);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  const initialBackendUrl =
    query.get("server") ||
    storage.get(STORAGE_KEYS.backendUrl, "http://localhost:3000");
  const initialNickname =
    storage.get(STORAGE_KEYS.nickname) ||
    randomNames[Math.floor(Math.random() * randomNames.length)];
  const initialPlayerToken =
    storage.get(STORAGE_KEYS.playerToken) || createPlayerToken();

  storage.set(STORAGE_KEYS.playerToken, initialPlayerToken);
  storage.set(STORAGE_KEYS.nickname, initialNickname);

  const state = {
    socket: null,
    connected: false,
    connecting: false,
    backendUrl: normalizeBackendUrl(initialBackendUrl),
    playerToken: initialPlayerToken,
    playerId: null,
    nickname: initialNickname,
    roomCode: storage.get(STORAGE_KEYS.roomCode),
    roomState: null,
    gameState: null,
    dashOrder: null,
    guessTarget: null,
    showSettings: false,
    busyActions: new Set(),
    joinCode: (query.get("room") || "").toUpperCase().slice(0, 4),
    lastToast: {
      signature: "",
      timestamp: 0,
    },
  };

  storage.set(STORAGE_KEYS.backendUrl, state.backendUrl);

  function normalizeBackendUrl(value) {
    let url = String(value || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(url)) {
      url = `${url.startsWith("localhost") || url.startsWith("127.") ? "http" : "https"}://${url}`;
    }
    return url;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatPhase(phase) {
    return (
      {
        SETUP_DASH: "百搭牌准备",
        DRAW: "摸牌",
        PLACE_DASH: "摆放百搭牌",
        WAITING_FOR_PLAYER: "等待玩家操作",
        GUESS: "猜牌",
        DECIDE: "继续或收手",
      }[phase] || phase || "等待中"
    );
  }

  function playerById(playerId) {
    return state.gameState?.players.find((player) => player.id === playerId) || null;
  }

  function selfGamePlayer() {
    return playerById(state.gameState?.selfPlayerId);
  }

  function showToast(message, tone = "default") {
    const signature = `${tone}:${message}`;
    const now = Date.now();
    if (
      state.lastToast.signature === signature &&
      now - state.lastToast.timestamp < 500
    ) {
      return;
    }
    state.lastToast = { signature, timestamp: now };
    const toneClass =
      tone === "error"
        ? "border-red-400/30 bg-red-950/90 text-red-100"
        : tone === "success"
          ? "border-lime-300/30 bg-neutral-900/95 text-lime-100"
          : "border-white/10 bg-neutral-900/95 text-white";
    toastRoot.innerHTML = `
      <div class="toast-enter pointer-events-auto max-w-md rounded-2xl border px-4 py-3 text-sm font-semibold shadow-2xl ${toneClass}">
        ${escapeHtml(message)}
      </div>
    `;
    window.setTimeout(() => {
      if (toastRoot.textContent?.trim() === String(message).trim()) {
        toastRoot.innerHTML = "";
      }
    }, 3_000);
  }

  function setRoomInUrl(roomCode) {
    const url = new URL(window.location.href);
    if (roomCode) {
      url.searchParams.set("room", roomCode);
      url.searchParams.set("server", state.backendUrl);
    } else {
      url.searchParams.delete("room");
    }
    window.history.replaceState({}, "", url);
  }

  function rememberRoom(roomCode) {
    state.roomCode = roomCode;
    storage.set(STORAGE_KEYS.roomCode, roomCode);
    setRoomInUrl(roomCode);
  }

  function forgetRoom() {
    state.roomCode = "";
    state.playerId = null;
    state.roomState = null;
    state.gameState = null;
    state.dashOrder = null;
    state.guessTarget = null;
    storage.remove(STORAGE_KEYS.roomCode);
    setRoomInUrl("");
  }

  function syncDashOrder() {
    const self = selfGamePlayer();
    if (
      state.gameState?.status !== "SETUP_DASH" ||
      !state.gameState?.canAct?.confirmDash ||
      !self?.hand
    ) {
      state.dashOrder = null;
      return;
    }
    const serverIds = self.hand.map((tile) => tile.id);
    const localIds = state.dashOrder || [];
    const sameTiles =
      serverIds.length === localIds.length &&
      serverIds.every((tileId) => localIds.includes(tileId));
    if (!sameTiles) {
      state.dashOrder = serverIds;
    }
  }

  function emitAction(eventName, payload = {}) {
    return new Promise((resolve) => {
      if (!state.socket?.connected) {
        resolve({
          ok: false,
          error: {
            code: "OFFLINE",
            message: "尚未连接到游戏服务器。",
          },
        });
        return;
      }
      state.busyActions.add(eventName);
      render();
      const timeout = window.setTimeout(() => {
        state.busyActions.delete(eventName);
        render();
        resolve({
          ok: false,
          error: {
            code: "TIMEOUT",
            message: "服务器响应超时，请检查后端或 Localtunnel。",
          },
        });
      }, 8_000);
      state.socket.emit(eventName, payload, (response) => {
        window.clearTimeout(timeout);
        state.busyActions.delete(eventName);
        render();
        resolve(response);
      });
    });
  }

  async function runAction(eventName, payload = {}, options = {}) {
    const response = await emitAction(eventName, payload);
    if (!response?.ok) {
      if (!options.silent) {
        showToast(response?.error?.message || "操作失败。", "error");
      }
      return null;
    }
    if (options.successMessage) {
      showToast(options.successMessage, "success");
    }
    return response;
  }

  function connect() {
    if (!window.io) {
      showToast("Socket.IO 客户端资源加载失败。", "error");
      return;
    }
    if (state.socket) {
      state.socket.removeAllListeners();
      state.socket.disconnect();
    }

    state.connecting = true;
    state.connected = false;
    render();

    // extraHeaders is required by Localtunnel to bypass its reminder page.
    state.socket = window.io(state.backendUrl, {
      extraHeaders: {
        "Bypass-Tunnel-Reminder": "true",
      },
      // Localtunnel can hold browser polling requests open indefinitely while
      // still proxying WebSocket upgrades correctly. Prefer WebSocket and keep
      // polling as a fallback for ordinary deployments.
      transports: ["websocket", "polling"],
      tryAllTransports: true,
    });

    state.socket.on("connect", async () => {
      state.connected = true;
      state.connecting = false;
      render();

      if (state.roomCode) {
        const response = await runAction(
          "rejoin_room",
          {
            roomCode: state.roomCode,
            playerToken: state.playerToken,
            nickname: state.nickname,
          },
          { silent: true },
        );
        if (response) {
          state.playerId = response.playerId;
          rememberRoom(response.roomCode);
          showToast("已恢复原房间和座位。", "success");
        } else {
          forgetRoom();
          render();
          showToast("原房间已失效，请重新创建或加入。", "error");
        }
      }
    });

    state.socket.on("disconnect", () => {
      state.connected = false;
      state.connecting = false;
      render();
    });

    state.socket.on("connect_error", () => {
      state.connected = false;
      state.connecting = false;
      render();
    });

    state.socket.on("room_state", (roomState) => {
      state.roomState = roomState;
      rememberRoom(roomState.roomCode);
      if (roomState.status === "LOBBY") {
        state.gameState = null;
      }
      render();
    });

    state.socket.on("game_state", (gameState) => {
      state.gameState = gameState;
      state.playerId = gameState.selfPlayerId;
      syncDashOrder();
      if (state.guessTarget) {
        const target = playerById(state.guessTarget.playerId);
        const tile = target?.hand?.find(
          (candidate) => candidate.id === state.guessTarget.tileId,
        );
        if (!tile || tile.isRevealed) {
          state.guessTarget = null;
        }
      }
      render();
    });

    state.socket.on("action_error", (error) => {
      showToast(error.message || "服务器拒绝了该操作。", "error");
    });

    state.socket.on("session_replaced", () => {
      showToast("这个身份已在另一个页面恢复，本页已停止控制。", "error");
    });
  }

  function connectionBadge() {
    const label = state.connected
      ? "已连接"
      : state.connecting
        ? "连接中"
        : "离线";
    const dotClass = state.connected
      ? "bg-lime-300"
      : state.connecting
        ? "bg-amber-300 animate-pulse"
        : "bg-red-400";
    return `
      <button
        type="button"
        data-action="open-settings"
        class="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-white/65 transition hover:bg-white/10 hover:text-white"
        title="后端：${escapeHtml(state.backendUrl)}"
      >
        <span class="h-2 w-2 rounded-full ${dotClass}"></span>
        ${label}
      </button>
    `;
  }

  function renderShell(content) {
    return `
      <div class="mx-auto flex min-h-screen w-full max-w-[1480px] flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header class="flex items-center justify-between py-2">
          <button type="button" data-action="brand-home" class="group text-left">
            <div class="flex items-baseline gap-2">
              <span class="text-xl font-black tracking-[-0.06em] text-white">CODE</span>
              <span class="text-xs font-bold tracking-[0.18em] text-coral-500">/ 26</span>
            </div>
            <p class="mt-0.5 text-[0.62rem] font-semibold tracking-[0.16em] text-white/35">THE DEDUCTION GAME</p>
          </button>
          <div class="flex items-center gap-2">
            ${
              state.roomCode
                ? `<span class="hidden rounded-full border border-white/10 px-3 py-2 text-xs font-bold tracking-[0.16em] text-white/55 sm:inline">房间 ${escapeHtml(state.roomCode)}</span>`
                : ""
            }
            ${connectionBadge()}
          </div>
        </header>
        <main class="flex flex-1 flex-col py-5">${content}</main>
        <footer class="flex flex-wrap items-center justify-between gap-2 border-t border-white/8 py-5 text-xs text-white/30">
          <span>黑白 0–11 · Dash × 2 · 2–4 位玩家</span>
          <span>刷新页面会自动恢复身份与手牌</span>
        </footer>
      </div>
      ${state.showSettings ? renderSettingsModal() : ""}
      ${state.guessTarget ? renderGuessModal() : ""}
    `;
  }

  function renderLobby() {
    const roomPrefill = state.joinCode || query.get("room") || "";
    return `
      <div class="grid flex-1 items-center gap-8 py-6 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
        <section class="max-w-3xl">
          <p class="eyebrow mb-5">A SOCIAL DEDUCTION CLASSIC</p>
          <h1 class="max-w-3xl text-5xl font-black leading-[0.95] tracking-[-0.065em] text-white sm:text-7xl lg:text-[6.4rem]">
            看见颜色，<br />
            <span class="text-white/25">猜出密码。</span>
          </h1>
          <p class="mt-7 max-w-xl text-base leading-7 text-white/52 sm:text-lg">
            牌面越沉默，信息越响亮。按序排列你的数字，把 Dash 藏在任意位置，然后逐张拆穿对手。
          </p>
          <div class="mt-9 grid max-w-xl grid-cols-3 gap-3">
            ${[
              ["26", "张黑白密码牌"],
              ["2–4", "位推理玩家"],
              ["1", "位最后幸存者"],
            ]
              .map(
                ([value, label]) => `
                  <div class="border-l border-white/12 pl-4">
                    <div class="text-2xl font-black tracking-tight text-white">${value}</div>
                    <div class="mt-1 text-xs text-white/35">${label}</div>
                  </div>
                `,
              )
              .join("")}
          </div>
        </section>

        <section class="panel mx-auto w-full max-w-xl p-5 sm:p-7">
          <div class="mb-6 flex items-start justify-between gap-4">
            <div>
              <p class="eyebrow">ENTER THE TABLE</p>
              <h2 class="mt-2 text-2xl font-black tracking-tight">开始一局推理</h2>
            </div>
            <span class="rounded-full bg-lime-300/10 px-3 py-1.5 text-xs font-bold text-lime-300">无需登录</span>
          </div>

          <label class="mb-2 block text-xs font-bold text-white/55" for="nickname">你的昵称</label>
          <input
            id="nickname"
            name="nickname"
            class="input"
            maxlength="24"
            autocomplete="nickname"
            value="${escapeHtml(state.nickname)}"
            placeholder="输入昵称"
          />

          <form data-form="create-room" class="mt-5">
            <button class="btn-primary w-full" ${state.connected ? "" : "disabled"}>
              <span>创建新房间</span>
              <span aria-hidden="true">→</span>
            </button>
          </form>

          <div class="my-5 flex items-center gap-3">
            <span class="h-px flex-1 bg-white/8"></span>
            <span class="text-[0.65rem] font-bold uppercase tracking-[0.2em] text-white/25">OR JOIN</span>
            <span class="h-px flex-1 bg-white/8"></span>
          </div>

          <form data-form="join-room" class="flex gap-3">
            <input
              name="roomCode"
              class="input uppercase tracking-[0.24em]"
              maxlength="4"
              autocomplete="off"
              value="${escapeHtml(roomPrefill)}"
              placeholder="房间码"
            />
            <button class="btn-secondary shrink-0 px-6" ${state.connected ? "" : "disabled"}>加入</button>
          </form>

          <div class="mt-6 rounded-2xl border border-white/8 bg-black/20 p-4 text-xs leading-5 text-white/38">
            当前后端：<span class="font-mono text-white/60">${escapeHtml(state.backendUrl)}</span>
            ${
              state.connected
                ? ""
                : `<button type="button" data-action="open-settings" class="ml-1 font-bold text-coral-500 hover:text-coral-400">检查地址</button>`
            }
          </div>
        </section>
      </div>
    `;
  }

  function renderSeat(player, index) {
    if (!player) {
      return `
        <div class="flex min-h-32 items-center justify-center rounded-3xl border border-dashed border-white/10 bg-white/[0.025] text-sm text-white/20">
          空座位 ${index + 1}
        </div>
      `;
    }
    const isSelf = player.id === state.playerId;
    return `
      <div class="rounded-3xl border ${isSelf ? "border-coral-500/35 bg-coral-500/[0.06]" : "border-white/10 bg-white/[0.04]"} p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="flex min-w-0 items-center gap-3">
            <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${player.isConnected ? "bg-white/10" : "bg-white/5"} text-sm font-black">
              ${escapeHtml(player.nickname.slice(0, 1).toUpperCase())}
            </div>
            <div class="min-w-0">
              <p class="truncate font-bold">${escapeHtml(player.nickname)}${isSelf ? "（你）" : ""}</p>
              <p class="mt-1 text-xs ${player.isConnected ? "text-lime-300/65" : "text-red-300/60"}">
                ${player.isConnected ? "在线" : "等待重连"}
              </p>
            </div>
          </div>
          ${player.isHost ? `<span class="rounded-full bg-white/8 px-2.5 py-1 text-[0.62rem] font-black tracking-wider text-white/45">HOST</span>` : ""}
        </div>
        <div class="mt-5 flex items-center gap-2 text-xs font-bold">
          <span class="h-2 w-2 rounded-full ${player.isReady ? "bg-lime-300" : "bg-white/20"}"></span>
          <span class="${player.isReady ? "text-lime-200/80" : "text-white/35"}">${player.isReady ? "已准备" : "未准备"}</span>
        </div>
      </div>
    `;
  }

  function renderRoom() {
    const players = state.roomState?.players || [];
    const self = players.find((player) => player.id === state.playerId);
    const allReady =
      players.length >= 2 &&
      players.every((player) => player.isReady && player.isConnected);
    const busy = state.busyActions.size > 0;
    return `
      <div class="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center py-6">
        <div class="mb-8 flex flex-wrap items-end justify-between gap-5">
          <div>
            <p class="eyebrow">PRIVATE TABLE</p>
            <div class="mt-2 flex items-center gap-3">
              <h1 class="text-4xl font-black tracking-[-0.055em] sm:text-5xl">等待玩家</h1>
              <span class="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 font-mono text-lg font-black tracking-[0.2em]">${escapeHtml(state.roomCode)}</span>
            </div>
            <p class="mt-3 text-sm text-white/40">2–4 人 · 全员准备后由房主开始</p>
          </div>
          <button type="button" data-action="copy-room" class="btn-secondary">复制邀请链接</button>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          ${Array.from({ length: 4 }, (_, index) => renderSeat(players[index], index)).join("")}
        </div>

        <div class="panel mt-6 flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div class="text-sm text-white/45">
            ${
              allReady
                ? `<span class="font-bold text-lime-300">全员就绪，可以开始。</span>`
                : `还需要 ${Math.max(0, 2 - players.length)} 位玩家或等待其他人准备。`
            }
          </div>
          <div class="flex gap-3">
            <button
              type="button"
              data-action="toggle-ready"
              class="${self?.isReady ? "btn-secondary" : "btn-primary"}"
              ${busy ? "disabled" : ""}
            >
              ${self?.isReady ? "取消准备" : "我准备好了"}
            </button>
            ${
              self?.isHost
                ? `<button type="button" data-action="start-game" class="btn-primary" ${allReady && !busy ? "" : "disabled"}>开始游戏</button>`
                : ""
            }
          </div>
        </div>
      </div>
    `;
  }

  function tileMarkup(tile, options = {}) {
    const colorClass = tile.color === "white" ? "tile-white" : "tile-black";
    const showValue = options.isSelf || tile.isRevealed;
    const actionable = options.actionable && !tile.isRevealed;
    const value = tile.value === DASH ? "—" : tile.value;
    return `
      <button
        type="button"
        class="tile ${colorClass} ${showValue ? "" : "tile-hidden"} ${actionable ? "tile-actionable" : ""} ${tile.isDrawnThisTurn ? "ring-2 ring-coral-500" : ""}"
        ${actionable ? `data-action="open-guess" data-player-id="${escapeHtml(options.playerId)}" data-tile-id="${escapeHtml(tile.id)}"` : "disabled"}
        aria-label="${actionable ? "猜测这张暗牌" : showValue ? `牌面 ${value}` : "未揭开的牌"}"
      >
        <span class="relative z-10 text-[0.58rem] font-black uppercase tracking-widest opacity-45">${tile.color === "white" ? "W" : "B"}</span>
        <span class="relative z-10 text-3xl font-black tracking-tighter sm:text-4xl">${showValue ? escapeHtml(value) : ""}</span>
        <span class="relative z-10 text-[0.55rem] font-bold opacity-35">${tile.isRevealed ? "OPEN" : options.isSelf ? "PRIVATE" : "CODE"}</span>
      </button>
    `;
  }

  function renderPlayerHand(player, options = {}) {
    if (player.handHidden || !player.hand) {
      return `
        <div class="flex min-h-28 items-center justify-center rounded-2xl border border-dashed border-white/10 bg-black/15 px-6 text-center text-sm text-white/30">
          对方正在摆放手牌<br />颜色与张数已隐藏
        </div>
      `;
    }
    return `
      <div class="scrollbar-subtle flex gap-2 overflow-x-auto px-1 py-2">
        ${player.hand
          .map((tile) =>
            tileMarkup(tile, {
              isSelf: options.isSelf,
              playerId: player.id,
              actionable:
                !options.isSelf &&
                state.gameState?.canAct?.guess &&
                !player.isEliminated,
            }),
          )
          .join("")}
      </div>
    `;
  }

  function playerStatusLabel(player) {
    if (player.isEliminated) {
      return "已淘汰";
    }
    if (player.isCurrentTurn) {
      return "正在行动";
    }
    if (!player.isConnected) {
      return "等待重连";
    }
    return "推理中";
  }

  function renderOpponentZone(player) {
    return `
      <section class="rounded-3xl border ${player.isCurrentTurn ? "border-lime-300/30 bg-lime-300/[0.035]" : "border-white/8 bg-white/[0.025]"} p-4">
        <div class="mb-2 flex items-center justify-between gap-3">
          <div>
            <h3 class="font-bold ${player.isEliminated ? "text-white/35 line-through" : "text-white"}">${escapeHtml(player.nickname)}</h3>
            <p class="mt-0.5 text-[0.65rem] font-bold uppercase tracking-[0.16em] ${player.isCurrentTurn ? "text-lime-300" : "text-white/25"}">${playerStatusLabel(player)}</p>
          </div>
          <span class="h-2.5 w-2.5 rounded-full ${player.isConnected ? "bg-lime-300/70" : "bg-red-400/70"}"></span>
        </div>
        ${renderPlayerHand(player)}
      </section>
    `;
  }

  function renderSetupDash() {
    const self = selfGamePlayer();
    const orderedTiles = (state.dashOrder || [])
      .map((tileId) => self?.hand?.find((tile) => tile.id === tileId))
      .filter(Boolean);
    const opponents = state.gameState.players.filter((player) => !player.isSelf);
    const opponentGridClass =
      opponents.length >= 3
        ? "lg:grid-cols-3"
        : opponents.length === 2
          ? "lg:grid-cols-2"
          : "lg:grid-cols-1";
    return `
      <div class="mx-auto w-full max-w-7xl py-3">
        <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p class="eyebrow">SETUP / DASH</p>
            <h1 class="mt-2 text-3xl font-black tracking-tight sm:text-4xl">安排你的伪装牌</h1>
          </div>
          <span class="rounded-full border border-white/10 px-3 py-2 text-xs font-bold text-white/45">正式回合尚未开始</span>
        </div>

        <div class="grid gap-4 ${opponentGridClass}">
          ${opponents.map(renderOpponentZone).join("")}
        </div>

        <section class="panel mt-5 p-5 sm:p-7">
          ${
            state.gameState.canAct.confirmDash
              ? `
                <div class="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p class="eyebrow">YOUR PRIVATE HAND</p>
                    <h2 class="mt-2 text-xl font-black">用箭头把 Dash 移到任意位置</h2>
                    <p class="mt-2 text-sm text-white/40">数字牌的升序不会改变；提交前只有你能看到这些牌。</p>
                  </div>
                  <button type="button" data-action="confirm-dash" class="btn-primary shrink-0">确认牌序</button>
                </div>
                <div class="scrollbar-subtle mt-5 flex gap-3 overflow-x-auto py-2">
                  ${orderedTiles
                    .map((tile, index) => {
                      const isDash = tile.value === DASH;
                      return `
                        <div class="flex shrink-0 flex-col items-center gap-2">
                          ${tileMarkup(tile, { isSelf: true })}
                          ${
                            isDash
                              ? `
                                <div class="flex gap-1">
                                  <button type="button" data-action="move-dash" data-tile-id="${tile.id}" data-direction="-1" class="h-8 w-8 rounded-lg bg-white/8 text-sm font-black hover:bg-white/15" ${index === 0 ? "disabled" : ""}>←</button>
                                  <button type="button" data-action="move-dash" data-tile-id="${tile.id}" data-direction="1" class="h-8 w-8 rounded-lg bg-white/8 text-sm font-black hover:bg-white/15" ${index === orderedTiles.length - 1 ? "disabled" : ""}>→</button>
                                </div>
                              `
                              : `<span class="h-8 text-[0.6rem] font-bold text-white/20">LOCKED</span>`
                          }
                        </div>
                      `;
                    })
                    .join("")}
                </div>
              `
              : `
                <div class="flex min-h-44 flex-col items-center justify-center text-center">
                  <div class="mb-4 flex gap-2">
                    <span class="h-2.5 w-2.5 animate-bounce rounded-full bg-coral-500 [animation-delay:-0.2s]"></span>
                    <span class="h-2.5 w-2.5 animate-bounce rounded-full bg-coral-500 [animation-delay:-0.1s]"></span>
                    <span class="h-2.5 w-2.5 animate-bounce rounded-full bg-coral-500"></span>
                  </div>
                  <h2 class="text-xl font-black">${self?.hasSetupDash ? "你的牌序已提交" : "等待 Dash 玩家摆放手牌"}</h2>
                  <p class="mt-2 text-sm text-white/38">全员完成后会自动进入第一回合。</p>
                </div>
              `
          }
        </section>
      </div>
    `;
  }

  function renderDashInsertion(self) {
    const hand = self?.hand || [];
    return `
      <div class="mt-5">
        <p class="mb-3 text-xs font-bold text-white/45">点击加号选择 Dash 的插入位置</p>
        <div class="scrollbar-subtle flex items-center overflow-x-auto py-2">
          ${hand
            .map(
              (tile, index) => `
                <button type="button" data-action="place-dash" data-index="${index}" class="mx-1 flex h-10 w-8 shrink-0 items-center justify-center rounded-xl border border-dashed border-coral-500/40 text-xl text-coral-400 hover:bg-coral-500/10">+</button>
                ${tileMarkup(tile, { isSelf: true })}
              `,
            )
            .join("")}
          <button type="button" data-action="place-dash" data-index="${hand.length}" class="mx-1 flex h-10 w-8 shrink-0 items-center justify-center rounded-xl border border-dashed border-coral-500/40 text-xl text-coral-400 hover:bg-coral-500/10">+</button>
        </div>
      </div>
    `;
  }

  function renderTurnControl() {
    const game = state.gameState;
    const self = selfGamePlayer();
    const actor = playerById(game.currentTurnPlayerId);
    const isMyTurn = actor?.id === self?.id;
    const turnDraw = game.turnDraw;
    const counts = game.drawPileCounts;

    if (game.status === "FINISHED") {
      const winner = playerById(game.winnerPlayerId);
      return `
        <div class="text-center">
          <p class="eyebrow">CASE CLOSED</p>
          <h2 class="mt-2 text-3xl font-black">${winner?.id === self?.id ? "你破解了所有密码" : `${escapeHtml(winner?.nickname || "未知玩家")} 获胜`}</h2>
          <p class="mt-3 text-sm text-white/40">本局已经结束，刷新页面仍可查看最终牌面。</p>
        </div>
      `;
    }

    let actionContent = "";
    if (game.phase === "DRAW") {
      actionContent = isMyTurn
        ? `
          <div class="flex flex-wrap justify-center gap-3">
            <button type="button" data-action="draw-tile" data-color="black" class="btn-secondary min-w-32" ${counts.black ? "" : "disabled"}>
              摸黑牌 <span class="text-white/35">${counts.black}</span>
            </button>
            <button type="button" data-action="draw-tile" data-color="white" class="btn-secondary min-w-32" ${counts.white ? "" : "disabled"}>
              摸白牌 <span class="text-white/35">${counts.white}</span>
            </button>
          </div>
        `
        : `<p class="text-sm text-white/40">${escapeHtml(actor?.nickname)} 正在选择摸牌颜色…</p>`;
    } else if (game.phase === "PLACE_DASH") {
      actionContent = `
        <div>
          <h3 class="text-lg font-black">你摸到了一张 Dash</h3>
          <p class="mt-1 text-sm text-white/40">先把它放进自己的牌列，再开始猜牌。</p>
          ${renderDashInsertion(self)}
        </div>
      `;
    } else if (game.phase === "WAITING_FOR_PLAYER") {
      actionContent = `<p class="text-sm text-white/40">${escapeHtml(actor?.nickname)} 正在整理刚摸到的牌…</p>`;
    } else if (game.phase === "GUESS") {
      actionContent = isMyTurn
        ? `<p class="text-sm font-bold text-lime-200">点击任意对手未翻开的牌，然后声明数字或 Dash。</p>`
        : `<p class="text-sm text-white/40">${escapeHtml(actor?.nickname)} 正在观察牌列…</p>`;
    } else if (game.phase === "DECIDE") {
      actionContent = isMyTurn
        ? `
          <div>
            <p class="mb-4 text-sm font-bold text-lime-200">猜对了。继续冒险，还是保住摸到的牌？</p>
            <div class="flex flex-wrap justify-center gap-3">
              <button type="button" data-action="continue-guess" class="btn-secondary">继续猜牌</button>
              <button type="button" data-action="end-turn" class="btn-primary">结束回合</button>
            </div>
          </div>
        `
        : `<p class="text-sm text-white/40">${escapeHtml(actor?.nickname)} 正在决定是否继续…</p>`;
    }

    return `
      <div class="text-center">
        <div class="mb-4 flex items-center justify-center gap-2">
          <span class="eyebrow">${escapeHtml(formatPhase(game.phase))}</span>
          ${isMyTurn ? `<span class="rounded-full bg-lime-300/10 px-2 py-1 text-[0.62rem] font-black text-lime-300">YOUR TURN</span>` : ""}
        </div>
        ${
          turnDraw
            ? `
              <div class="mb-5 flex justify-center">
                <div>
                  ${tileMarkup(turnDraw, { isSelf: isMyTurn })}
                  <p class="mt-2 text-[0.6rem] font-bold uppercase tracking-wider text-white/25">${turnDraw.isPlaced ? "PLACED" : "DRAWN"}</p>
                </div>
              </div>
            `
            : ""
        }
        ${actionContent}
      </div>
    `;
  }

  function renderLogs() {
    const logs = state.gameState?.logs || [];
    return `
      <aside class="panel flex min-h-0 flex-col p-4">
        <div class="mb-3 flex items-center justify-between">
          <p class="eyebrow">GAME LOG</p>
          <span class="text-[0.62rem] text-white/25">${logs.length} 条</span>
        </div>
        <div class="scrollbar-subtle max-h-64 space-y-3 overflow-y-auto pr-2 lg:max-h-none lg:flex-1">
          ${
            logs.length
              ? [...logs]
                  .reverse()
                  .map(
                    (log) => `
                      <div class="border-l border-white/10 pl-3 text-xs leading-5 text-white/40">
                        ${escapeHtml(log.message)}
                      </div>
                    `,
                  )
                  .join("")
              : `<p class="text-xs text-white/25">对局日志会显示在这里。</p>`
          }
        </div>
      </aside>
    `;
  }

  function renderGame() {
    const game = state.gameState;
    if (!game) {
      return `
        <div class="flex flex-1 items-center justify-center">
          <div class="text-center">
            <div class="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-white/15 border-t-coral-500"></div>
            <p class="mt-4 text-sm text-white/40">正在恢复对局状态…</p>
          </div>
        </div>
      `;
    }
    if (game.status === "SETUP_DASH") {
      return renderSetupDash();
    }

    const self = selfGamePlayer();
    const opponents = game.players.filter((player) => !player.isSelf);
    return `
      <div class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div class="flex min-h-0 flex-col gap-4">
          <div class="grid gap-3 ${opponents.length === 1 ? "grid-cols-1" : opponents.length === 2 ? "md:grid-cols-2" : "md:grid-cols-3"}">
            ${opponents.map(renderOpponentZone).join("")}
          </div>

          <section class="panel flex min-h-64 flex-1 items-center justify-center p-5 sm:p-7">
            ${renderTurnControl()}
          </section>

          <section class="rounded-3xl border ${self?.isCurrentTurn ? "border-coral-500/35 bg-coral-500/[0.04]" : "border-white/8 bg-white/[0.025]"} p-4 sm:p-5">
            <div class="mb-2 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 class="font-black">${escapeHtml(self?.nickname || state.nickname)} <span class="text-white/30">/ 你的手牌</span></h3>
                <p class="mt-1 text-xs text-white/30">${self?.isEliminated ? "你已被淘汰，但仍可观战。" : "完整牌面只发送给你。"}</p>
              </div>
              <span class="rounded-full border border-white/8 px-3 py-1.5 text-[0.62rem] font-bold text-white/35">${self?.hand?.length || 0} 张</span>
            </div>
            ${renderPlayerHand(self, { isSelf: true })}
          </section>
        </div>
        ${renderLogs()}
      </div>
    `;
  }

  function renderSettingsModal() {
    return `
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" data-action="close-settings-backdrop">
        <form data-form="settings" class="panel w-full max-w-lg p-6" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="eyebrow">CONNECTION</p>
              <h2 id="settings-title" class="mt-2 text-2xl font-black">游戏后端地址</h2>
            </div>
            <button type="button" data-action="close-settings" class="h-10 w-10 rounded-full bg-white/5 text-xl text-white/50 hover:bg-white/10 hover:text-white">×</button>
          </div>
          <p class="mt-4 text-sm leading-6 text-white/40">本地测试使用 <code class="text-white/65">http://localhost:3000</code>；GitHub Pages 使用 Localtunnel 提供的 HTTPS 地址。</p>
          <label for="backendUrl" class="mt-5 mb-2 block text-xs font-bold text-white/55">Backend URL</label>
          <input id="backendUrl" name="backendUrl" class="input font-mono" value="${escapeHtml(state.backendUrl)}" required />
          <div class="mt-5 flex justify-end gap-3">
            <button type="button" data-action="close-settings" class="btn-quiet">取消</button>
            <button class="btn-primary">保存并重连</button>
          </div>
        </form>
      </div>
    `;
  }

  function renderGuessModal() {
    const target = playerById(state.guessTarget.playerId);
    return `
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
        <div class="panel w-full max-w-md p-5 sm:p-6" role="dialog" aria-modal="true" aria-labelledby="guess-title">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="eyebrow">MAKE A CALL</p>
              <h2 id="guess-title" class="mt-2 text-2xl font-black">这张牌是什么？</h2>
              <p class="mt-2 text-sm text-white/40">目标：${escapeHtml(target?.nickname || "对手")}</p>
            </div>
            <button type="button" data-action="close-guess" class="h-10 w-10 rounded-full bg-white/5 text-xl text-white/50 hover:bg-white/10 hover:text-white">×</button>
          </div>
          <div class="mt-6 grid grid-cols-4 gap-2">
            ${Array.from(
              { length: 12 },
              (_, value) => `
                <button type="button" data-action="submit-guess" data-value="${value}" class="flex aspect-square items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-xl font-black hover:border-lime-300/40 hover:bg-lime-300/10">${value}</button>
              `,
            ).join("")}
          </div>
          <button type="button" data-action="submit-guess" data-value="-" class="mt-3 flex w-full items-center justify-between rounded-2xl border border-coral-500/25 bg-coral-500/8 px-5 py-4 text-left hover:bg-coral-500/15">
            <span>
              <span class="block text-lg font-black">Dash / 百搭牌</span>
              <span class="mt-0.5 block text-xs text-white/35">声明这是一张 “—”</span>
            </span>
            <span class="text-3xl font-black text-coral-500">—</span>
          </button>
        </div>
      </div>
    `;
  }

  function render() {
    let content;
    if (!state.roomState && !state.roomCode) {
      content = renderLobby();
    } else if (state.roomState?.status === "LOBBY") {
      content = renderRoom();
    } else {
      content = renderGame();
    }
    app.innerHTML = renderShell(content);
  }

  async function createRoom() {
    const response = await runAction("create_room", {
      nickname: state.nickname,
      playerToken: state.playerToken,
    });
    if (!response) {
      return;
    }
    state.playerId = response.playerId;
    state.playerToken = response.playerToken;
    storage.set(STORAGE_KEYS.playerToken, response.playerToken);
    rememberRoom(response.roomCode);
    render();
  }

  async function joinRoom(roomCode) {
    const response = await runAction("join_room", {
      roomCode,
      nickname: state.nickname,
      playerToken: state.playerToken,
    });
    if (!response) {
      return;
    }
    state.playerId = response.playerId;
    state.playerToken = response.playerToken;
    storage.set(STORAGE_KEYS.playerToken, response.playerToken);
    rememberRoom(response.roomCode);
    render();
  }

  app.addEventListener("input", (event) => {
    if (event.target.matches("#nickname")) {
      state.nickname = event.target.value;
      storage.set(STORAGE_KEYS.nickname, state.nickname);
    }
    if (event.target.matches('input[name="roomCode"]')) {
      const normalized = event.target.value
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 4);
      event.target.value = normalized;
      state.joinCode = normalized;
    }
  });

  app.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    if (form.matches('[data-form="create-room"]')) {
      await createRoom();
      return;
    }
    if (form.matches('[data-form="join-room"]')) {
      const formData = new FormData(form);
      const roomCode = String(formData.get("roomCode") || "")
        .trim()
        .toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(roomCode)) {
        showToast("请输入 4 位房间码。", "error");
        return;
      }
      await joinRoom(roomCode);
      return;
    }
    if (form.matches('[data-form="settings"]')) {
      const formData = new FormData(form);
      const backendUrl = normalizeBackendUrl(formData.get("backendUrl"));
      if (!/^https?:\/\/.+/i.test(backendUrl)) {
        showToast("请输入有效的 HTTP 或 HTTPS 地址。", "error");
        return;
      }
      state.backendUrl = backendUrl;
      storage.set(STORAGE_KEYS.backendUrl, backendUrl);
      state.showSettings = false;
      render();
      connect();
    }
  });

  app.addEventListener("click", async (event) => {
    const trigger = event.target.closest("[data-action]");
    if (!trigger) {
      return;
    }
    const action = trigger.dataset.action;

    if (action === "open-settings") {
      state.showSettings = true;
      render();
    } else if (action === "close-settings") {
      state.showSettings = false;
      render();
    } else if (
      action === "close-settings-backdrop" &&
      event.target === trigger
    ) {
      state.showSettings = false;
      render();
    } else if (action === "brand-home") {
      if (state.roomCode) {
        showToast("当前身份仍绑定在房间中；刷新页面会自动回来。");
      }
    } else if (action === "copy-room") {
      const url = new URL(window.location.href);
      url.searchParams.set("room", state.roomCode);
      url.searchParams.set("server", state.backendUrl);
      try {
        await navigator.clipboard.writeText(url.toString());
        showToast("邀请链接已复制。", "success");
      } catch {
        showToast(`房间码：${state.roomCode}`);
      }
    } else if (action === "toggle-ready") {
      const self = state.roomState.players.find(
        (player) => player.id === state.playerId,
      );
      await runAction("set_ready", { isReady: !self?.isReady });
    } else if (action === "start-game") {
      await runAction("start_game");
    } else if (action === "move-dash") {
      const tileId = trigger.dataset.tileId;
      const direction = Number(trigger.dataset.direction);
      const fromIndex = state.dashOrder.indexOf(tileId);
      const toIndex = fromIndex + direction;
      if (fromIndex >= 0 && toIndex >= 0 && toIndex < state.dashOrder.length) {
        const nextOrder = [...state.dashOrder];
        [nextOrder[fromIndex], nextOrder[toIndex]] = [
          nextOrder[toIndex],
          nextOrder[fromIndex],
        ];
        state.dashOrder = nextOrder;
        render();
      }
    } else if (action === "confirm-dash") {
      await runAction(
        "confirm_dash_position",
        { handOrder: state.dashOrder },
        { successMessage: "牌序已提交。" },
      );
    } else if (action === "draw-tile") {
      await runAction("draw_tile", { color: trigger.dataset.color });
    } else if (action === "place-dash") {
      await runAction("place_drawn_dash", {
        insertIndex: Number(trigger.dataset.index),
      });
    } else if (action === "open-guess") {
      state.guessTarget = {
        playerId: trigger.dataset.playerId,
        tileId: trigger.dataset.tileId,
      };
      render();
    } else if (action === "close-guess") {
      state.guessTarget = null;
      render();
    } else if (action === "submit-guess") {
      const target = state.guessTarget;
      if (!target) {
        return;
      }
      const value =
        trigger.dataset.value === "-" ? DASH : Number(trigger.dataset.value);
      state.guessTarget = null;
      render();
      const response = await runAction("guess_tile", {
        targetPlayerId: target.playerId,
        tileId: target.tileId,
        value,
      });
      if (response) {
        showToast(response.correct ? "猜中了！" : "猜错了，本回合结束。", response.correct ? "success" : "error");
      }
    } else if (action === "continue-guess") {
      await runAction("continue_guess");
    } else if (action === "end-turn") {
      await runAction("end_turn");
    }
  });

  render();
  connect();
})();
