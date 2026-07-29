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
      ? "bg-emerald-400"
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
      <div class="safe-bottom mx-auto flex min-h-[100dvh] w-full max-w-[1480px] flex-col px-3 pt-3 sm:px-6 sm:pt-4 lg:px-8">
        <header class="sticky top-2 z-40 flex items-center justify-between rounded-2xl border border-white/8 bg-ink-950/85 px-3 py-2.5 shadow-xl shadow-black/20 backdrop-blur-xl sm:top-3 sm:px-4">
          <button type="button" data-action="brand-home" class="group flex items-center gap-2.5 text-left">
            <span class="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-amber-700 text-[0.62rem] font-black tracking-tight text-amber-50 shadow-lg shadow-amber-950/30">密码</span>
            <div>
              <div class="flex items-baseline gap-2">
                <span class="text-xs font-black tracking-wide text-amber-100 sm:text-sm">达芬奇密码</span>
                <span class="hidden text-[0.55rem] font-bold tracking-[0.18em] text-amber-500 sm:inline">/ CODE 26</span>
              </div>
              <p class="mt-0.5 hidden font-mono text-[0.56rem] font-semibold tracking-[0.13em] text-amber-500/65 sm:block">${state.roomCode ? `ROOM: ${escapeHtml(state.roomCode)}` : "ROOM: ----"}</p>
            </div>
          </button>
          <div class="flex items-center gap-2">
            ${
              state.roomCode
                ? `<span class="rounded-xl border border-white/10 bg-white/4 px-2.5 py-2 font-mono text-[0.68rem] font-black tracking-[0.16em] text-white/55 sm:px-3 sm:text-xs"># ${escapeHtml(state.roomCode)}</span>`
                : ""
            }
            ${connectionBadge()}
          </div>
        </header>
        <main class="flex flex-1 flex-col py-4 sm:py-6">${content}</main>
        <footer class="flex flex-col items-center justify-between gap-1 border-t border-white/8 py-4 text-center text-[0.68rem] text-white/25 sm:flex-row sm:gap-2 sm:text-left sm:text-xs">
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
      <div class="grid flex-1 items-center gap-7 py-4 sm:py-7 lg:grid-cols-[1.08fr_0.92fr] lg:gap-14">
        <section class="mx-auto w-full max-w-3xl lg:mx-0">
          <div class="mb-5 flex items-center gap-3">
            <p class="eyebrow">A SOCIAL DEDUCTION CLASSIC</p>
            <span class="h-px flex-1 bg-gradient-to-r from-white/15 to-transparent"></span>
          </div>
          <h1 class="max-w-3xl text-[2.85rem] font-black leading-[0.94] tracking-[-0.06em] text-white min-[430px]:text-6xl sm:text-7xl lg:text-[6.1rem]">
            看见颜色，<br />
            <span class="bg-gradient-to-r from-white/24 to-white/8 bg-clip-text text-transparent">猜出密码。</span>
          </h1>
          <p class="mt-5 max-w-xl text-sm leading-6 text-white/52 sm:mt-7 sm:text-lg sm:leading-7">
            牌面越沉默，信息越响亮。按序排列你的数字，把 Dash 藏在任意位置，然后逐张拆穿对手。
          </p>
          <div class="mt-6 grid max-w-xl grid-cols-3 gap-2 sm:mt-9 sm:gap-3">
            ${[
              ["26", "张黑白密码牌"],
              ["2–4", "位推理玩家"],
              ["1", "位最后幸存者"],
            ]
              .map(
                ([value, label]) => `
                  <div class="border-l border-white/12 pl-3 sm:pl-4">
                    <div class="text-xl font-black tracking-tight text-white sm:text-2xl">${value}</div>
                    <div class="mt-1 text-[0.62rem] leading-4 text-white/35 sm:text-xs">${label}</div>
                  </div>
                `,
              )
              .join("")}
          </div>
          <div class="mt-7 hidden items-end gap-3 sm:flex" aria-hidden="true">
            <div class="tile tile-black -rotate-6 opacity-55"><span class="text-[0.58rem] font-black opacity-40">B</span><span class="text-3xl font-black">?</span><span class="text-[0.5rem] opacity-30">CODE</span></div>
            <div class="tile tile-white translate-y-2 rotate-3"><span class="text-[0.58rem] font-black opacity-40">W</span><span class="text-3xl font-black">—</span><span class="text-[0.5rem] opacity-30">DASH</span></div>
            <p class="mb-2 max-w-[13rem] text-xs leading-5 text-white/28">两种颜色，一套顺序。<br />唯一的例外，就是最好的伪装。</p>
          </div>
        </section>

        <section class="panel mx-auto w-full max-w-xl p-4 sm:p-7">
          <div class="mb-6 flex items-start justify-between gap-4">
            <div>
              <p class="eyebrow">ENTER THE TABLE</p>
              <h2 class="mt-2 text-xl font-black tracking-tight sm:text-2xl">开始一局推理</h2>
            </div>
            <span class="whitespace-nowrap rounded-full bg-lime-300/10 px-2.5 py-1.5 text-[0.65rem] font-bold text-lime-300 sm:px-3 sm:text-xs">无需登录</span>
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

          <form data-form="join-room" class="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:gap-3">
            <input
              name="roomCode"
              class="input uppercase tracking-[0.24em]"
              maxlength="4"
              autocomplete="off"
              value="${escapeHtml(roomPrefill)}"
              placeholder="房间码"
            />
            <button class="btn-secondary shrink-0 px-5 sm:px-6" ${state.connected ? "" : "disabled"}>加入</button>
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
        <div class="flex min-h-28 items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.025] text-xs text-white/20 sm:min-h-32 sm:rounded-3xl sm:text-sm">
          空座位 ${index + 1}
        </div>
      `;
    }
    const isSelf = player.id === state.playerId;
    return `
      <div class="rounded-2xl border ${isSelf ? "border-coral-500/35 bg-coral-500/[0.06]" : "border-white/10 bg-white/[0.04]"} p-3.5 sm:rounded-3xl sm:p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="flex min-w-0 items-center gap-3">
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${player.isConnected ? "bg-white/10" : "bg-white/5"} text-xs font-black sm:h-11 sm:w-11 sm:rounded-2xl sm:text-sm">
              ${escapeHtml(player.nickname.slice(0, 1).toUpperCase())}
            </div>
            <div class="min-w-0">
              <p class="truncate font-bold">${escapeHtml(player.nickname)}${isSelf ? "（你）" : ""}</p>
              <p class="mt-1 text-xs ${player.isConnected ? "text-lime-300/65" : "text-red-300/60"}">
                ${player.isConnected ? "在线" : "等待重连"}
              </p>
            </div>
          </div>
          ${player.isHost ? `<span class="rounded-full bg-white/8 px-2 py-1 text-[0.54rem] font-black tracking-wider text-white/45 sm:px-2.5 sm:text-[0.62rem]">HOST</span>` : ""}
        </div>
        <div class="mt-4 flex items-center gap-2 text-[0.68rem] font-bold sm:mt-5 sm:text-xs">
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
      <div class="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center py-2 sm:py-6">
        <div class="mb-5 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between sm:gap-5">
          <div>
            <p class="eyebrow">PRIVATE TABLE</p>
            <div class="mt-2 flex flex-wrap items-center gap-3">
              <h1 class="text-3xl font-black tracking-[-0.055em] sm:text-5xl">等待玩家</h1>
              <span class="rounded-xl border border-white/10 bg-white/5 px-3 py-2 font-mono text-base font-black tracking-[0.2em] sm:rounded-2xl sm:text-lg">${escapeHtml(state.roomCode)}</span>
            </div>
            <p class="mt-3 text-sm text-white/40">2–4 人 · 全员准备后由房主开始</p>
          </div>
          <button type="button" data-action="copy-room" class="btn-secondary w-full sm:w-auto">复制邀请链接</button>
        </div>

        <div class="grid grid-cols-2 gap-2.5 sm:gap-4">
          ${Array.from({ length: 4 }, (_, index) => renderSeat(players[index], index)).join("")}
        </div>

        <div class="panel sticky bottom-2 z-20 mt-4 flex flex-col gap-3 p-3.5 sm:static sm:mt-6 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-5">
          <div class="text-sm text-white/45">
            ${
              allReady
                ? `<span class="font-bold text-lime-300">全员就绪，可以开始。</span>`
                : `还需要 ${Math.max(0, 2 - players.length)} 位玩家或等待其他人准备。`
            }
          </div>
          <div class="flex gap-2 sm:gap-3">
            <button
              type="button"
              data-action="toggle-ready"
              class="${self?.isReady ? "btn-secondary" : "btn-primary"} flex-1 sm:flex-none"
              ${busy ? "disabled" : ""}
            >
              ${self?.isReady ? "取消准备" : "我准备好了"}
            </button>
            ${
              self?.isHost
                ? `<button type="button" data-action="start-game" class="btn-primary flex-1 sm:flex-none" ${allReady && !busy ? "" : "disabled"}>开始游戏</button>`
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
        <span class="relative z-10 text-[1.7rem] font-black tracking-tighter sm:text-4xl">${showValue ? escapeHtml(value) : ""}</span>
        <span class="relative z-10 text-[0.48rem] font-bold opacity-35 sm:text-[0.55rem]">${tile.isRevealed ? "OPEN" : options.isSelf ? "PRIVATE" : "CODE"}</span>
      </button>
    `;
  }

  function renderPlayerHand(player, options = {}) {
    if (player.handHidden || !player.hand) {
      return `
        <div class="flex min-h-24 items-center justify-center rounded-2xl border border-dashed border-white/10 bg-black/15 px-4 text-center text-xs leading-5 text-white/30 sm:min-h-28 sm:px-6 sm:text-sm">
          对方正在摆放手牌<br />颜色与张数已隐藏
        </div>
      `;
    }
    return `
      <div class="scrollbar-subtle flex gap-1.5 overflow-x-auto px-0.5 py-2 sm:gap-2 sm:px-1">
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
      <section class="min-w-[82vw] snap-center rounded-2xl border ${player.isCurrentTurn ? "border-lime-300/35 bg-lime-300/[0.045] shadow-lg shadow-lime-300/5" : "border-white/8 bg-white/[0.025]"} p-3 sm:min-w-[60vw] sm:rounded-3xl sm:p-4 md:min-w-0">
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
        ? "md:grid-cols-3"
        : opponents.length === 2
          ? "md:grid-cols-2"
          : "md:grid-cols-1";
    return `
      <div class="mx-auto w-full max-w-7xl py-1 sm:py-3">
        <div class="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
          <div>
            <p class="eyebrow">SETUP / DASH</p>
            <h1 class="mt-2 text-2xl font-black tracking-tight sm:text-4xl">安排你的伪装牌</h1>
          </div>
          <span class="self-start rounded-full border border-white/10 px-3 py-2 text-[0.68rem] font-bold text-white/45 sm:self-auto sm:text-xs">正式回合尚未开始</span>
        </div>

        <div class="scrollbar-subtle -mx-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-3 pb-1 sm:-mx-6 sm:px-6 md:mx-0 md:grid md:px-0 ${opponentGridClass}">
          ${opponents.map(renderOpponentZone).join("")}
        </div>

        <section class="panel table-surface mt-4 p-4 sm:mt-5 sm:p-7">
          ${
            state.gameState.canAct.confirmDash
              ? `
                <div class="flex flex-col gap-4 sm:gap-6 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p class="eyebrow">YOUR PRIVATE HAND</p>
                    <h2 class="mt-2 text-xl font-black">用箭头把 Dash 移到任意位置</h2>
                    <p class="mt-2 text-sm text-white/40">数字牌的升序不会改变；提交前只有你能看到这些牌。</p>
                  </div>
                  <button type="button" data-action="confirm-dash" class="btn-primary w-full shrink-0 sm:w-auto">确认牌序</button>
                </div>
                <div class="scrollbar-subtle -mx-1 mt-4 flex gap-2 overflow-x-auto px-1 py-2 sm:mt-5 sm:gap-3">
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
                                  <button type="button" data-action="move-dash" data-tile-id="${tile.id}" data-direction="-1" class="h-10 w-10 rounded-xl bg-white/8 text-sm font-black hover:bg-white/15 disabled:opacity-25" ${index === 0 ? "disabled" : ""}>←</button>
                                  <button type="button" data-action="move-dash" data-tile-id="${tile.id}" data-direction="1" class="h-10 w-10 rounded-xl bg-white/8 text-sm font-black hover:bg-white/15 disabled:opacity-25" ${index === orderedTiles.length - 1 ? "disabled" : ""}>→</button>
                                </div>
                              `
                              : `<span class="h-10 pt-2 text-[0.6rem] font-bold text-white/20">LOCKED</span>`
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
          <div>
            <p class="mb-3 text-[0.65rem] font-semibold text-amber-300/75">牌面数字 = 牌库剩余张数</p>
            <div class="flex justify-center gap-8">
            <button type="button" data-action="draw-tile" data-color="black" class="group flex flex-col items-center gap-1.5 transition active:scale-95 disabled:opacity-30" ${counts.black ? "" : "disabled"}>
              <span class="tile tile-black !h-16 !w-12 !rounded-lg">
                <span class="text-[0.48rem] font-black opacity-40">CODA</span>
                <span class="text-lg font-black">${counts.black}</span>
                <span class="h-0.5 w-2 rounded bg-zinc-600"></span>
              </span>
              <span class="text-xs font-bold text-stone-300 group-hover:text-amber-300">摸黑牌</span>
            </button>
            <button type="button" data-action="draw-tile" data-color="white" class="group flex flex-col items-center gap-1.5 transition active:scale-95 disabled:opacity-30" ${counts.white ? "" : "disabled"}>
              <span class="tile tile-white !h-16 !w-12 !rounded-lg">
                <span class="text-[0.48rem] font-black opacity-40">CODA</span>
                <span class="text-lg font-black">${counts.white}</span>
                <span class="h-0.5 w-2 rounded bg-slate-300"></span>
              </span>
              <span class="text-xs font-bold text-stone-300 group-hover:text-amber-300">摸白牌</span>
            </button>
            </div>
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
            <div class="flex justify-center gap-2 sm:gap-3">
              <button type="button" data-action="continue-guess" class="btn-secondary flex-1 sm:flex-none">继续猜牌</button>
              <button type="button" data-action="end-turn" class="btn-primary flex-1 sm:flex-none">结束回合</button>
            </div>
          </div>
        `
        : `<p class="text-sm text-white/40">${escapeHtml(actor?.nickname)} 正在决定是否继续…</p>`;
    }

    return `
      <div class="w-full text-center">
        <div class="mb-3 flex items-center justify-center gap-2 sm:mb-4">
          <span class="eyebrow">${escapeHtml(formatPhase(game.phase))}</span>
          ${isMyTurn ? `<span class="rounded-full border border-amber-700/50 bg-amber-950/60 px-2 py-1 text-[0.62rem] font-black text-amber-300">YOUR TURN</span>` : ""}
        </div>
        ${
          turnDraw
            ? `
              <div class="mb-4 flex justify-center sm:mb-5">
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
    const logEntries = logs.length
      ? [...logs]
          .reverse()
          .map(
            (log) => `
              <div class="border-l border-amber-800/35 pl-3 text-xs leading-5 text-stone-400">
                ${escapeHtml(log.message)}
              </div>
            `,
          )
          .join("")
      : `<p class="text-xs text-stone-600">对局日志会显示在这里。</p>`;
    return `
      <details class="panel group p-3.5 lg:hidden">
        <summary class="flex cursor-pointer list-none items-center justify-between">
          <span class="eyebrow text-amber-400">对局记录 / GAME LOG</span>
          <span class="rounded-lg bg-stone-800 px-2 py-1 text-[0.62rem] text-stone-400">${logs.length} 条 · 点击展开</span>
        </summary>
        <div class="scrollbar-subtle mt-4 max-h-52 space-y-3 overflow-y-auto pr-2">
          ${logEntries}
        </div>
      </details>
      <aside class="panel hidden min-h-0 flex-col p-4 lg:flex">
        <div class="mb-3 flex items-center justify-between">
          <p class="eyebrow text-amber-400">GAME LOG</p>
          <span class="text-[0.62rem] text-white/25">${logs.length} 条</span>
        </div>
        <div class="scrollbar-subtle max-h-64 space-y-3 overflow-y-auto pr-2 lg:max-h-none lg:flex-1">
          ${logEntries}
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
    const opponentGridClass =
      opponents.length >= 3
        ? "md:grid-cols-3"
        : opponents.length === 2
          ? "md:grid-cols-2"
          : "md:grid-cols-1";
    return `
      <div class="grid min-h-0 flex-1 gap-3 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div class="flex min-h-0 flex-col gap-3 sm:gap-4">
          <div class="scrollbar-subtle -mx-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-3 pb-1 sm:-mx-6 sm:px-6 md:mx-0 md:grid md:px-0 ${opponentGridClass}">
            ${opponents.map(renderOpponentZone).join("")}
          </div>

          <section class="panel table-surface sticky bottom-2 z-20 flex min-h-48 items-center justify-center border-amber-900/35 p-4 sm:static sm:min-h-64 sm:flex-1 sm:p-7">
            ${renderTurnControl()}
          </section>

          <section class="rounded-2xl border ${self?.isCurrentTurn ? "border-amber-500/45 bg-amber-950/15" : "border-stone-800 bg-stone-950/70"} p-3 sm:rounded-3xl sm:p-5">
            <div class="mb-2 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 class="text-sm font-black text-amber-300 sm:text-base">${escapeHtml(self?.nickname || state.nickname)} <span class="text-stone-500">/ 你的手牌</span></h3>
                <p class="mt-1 text-[0.68rem] text-stone-600 sm:text-xs">${self?.isEliminated ? "你已被淘汰，但仍可观战。" : "完整牌面只发送给你。"}</p>
              </div>
              <span class="rounded-full border border-stone-800 px-3 py-1.5 text-[0.62rem] font-bold text-stone-500">${self?.hand?.length || 0} 张</span>
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
      <div class="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-4" data-action="close-settings-backdrop">
        <form data-form="settings" class="panel safe-bottom w-full max-w-lg rounded-b-none border-x-0 border-b-0 p-5 sm:rounded-3xl sm:border sm:p-6" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div class="mx-auto mb-4 h-1 w-10 rounded-full bg-stone-700 sm:hidden"></div>
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="eyebrow text-amber-400">CONNECTION</p>
              <h2 id="settings-title" class="mt-2 text-2xl font-black">游戏后端地址</h2>
            </div>
            <button type="button" data-action="close-settings" class="h-10 w-10 rounded-xl bg-stone-800 text-xl text-stone-400 hover:bg-stone-700 hover:text-white">×</button>
          </div>
          <p class="mt-4 text-sm leading-6 text-stone-500">本地测试使用 <code class="text-stone-300">http://localhost:3000</code>；GitHub Pages 请填写可访问后端的 HTTPS 隧道地址。</p>
          <label for="backendUrl" class="mt-5 mb-2 block text-xs font-bold text-white/55">Backend URL</label>
          <input id="backendUrl" name="backendUrl" class="input font-mono" value="${escapeHtml(state.backendUrl)}" required />
          <div class="mt-5 grid grid-cols-2 gap-3">
            <button type="button" data-action="close-settings" class="btn-secondary">取消</button>
            <button class="btn-primary">保存并重连</button>
          </div>
        </form>
      </div>
    `;
  }

  function renderGuessModal() {
    const target = playerById(state.guessTarget.playerId);
    return `
      <div class="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-0 backdrop-blur-sm sm:items-center sm:p-4">
        <div class="panel safe-bottom w-full max-w-md rounded-b-none border-x-0 border-b-0 p-5 sm:rounded-3xl sm:border sm:p-6" role="dialog" aria-modal="true" aria-labelledby="guess-title">
          <div class="mx-auto mb-4 h-1 w-10 rounded-full bg-stone-700 sm:hidden"></div>
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="eyebrow text-amber-400">MAKE A CALL</p>
              <h2 id="guess-title" class="mt-2 text-2xl font-black">这张牌是什么？</h2>
              <p class="mt-2 text-sm text-stone-500">目标：${escapeHtml(target?.nickname || "对手")}</p>
            </div>
            <button type="button" data-action="close-guess" class="h-10 w-10 rounded-xl bg-stone-800 text-xl text-stone-400 hover:bg-stone-700 hover:text-white">×</button>
          </div>
          <div class="mt-5 grid grid-cols-4 gap-2 sm:mt-6">
            ${Array.from(
              { length: 12 },
              (_, value) => `
                <button type="button" data-action="submit-guess" data-value="${value}" class="flex aspect-square items-center justify-center rounded-xl border border-stone-700 bg-stone-800 text-xl font-black hover:border-amber-500/60 hover:bg-amber-500/10">${value}</button>
              `,
            ).join("")}
          </div>
          <button type="button" data-action="submit-guess" data-value="-" class="mt-3 flex w-full items-center justify-between rounded-xl border border-amber-600/35 bg-amber-500/10 px-5 py-3.5 text-left hover:bg-amber-500/15">
            <span>
              <span class="block text-lg font-black">Dash / 百搭牌</span>
              <span class="mt-0.5 block text-xs text-stone-500">声明这是一张 “—”</span>
            </span>
            <span class="text-3xl font-black text-amber-500">—</span>
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
