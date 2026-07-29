(() => {
  "use strict";

  const STORAGE_KEYS = {
    playerToken: "coda.playerToken",
    nickname: "coda.nickname",
    avatarId: "coda.avatarId",
    roomCode: "coda.roomCode",
    backendUrl: "coda.backendUrl",
  };
  const DASH = "-";
  const PUBLIC_BACKEND_URL =
    "https://walked-struct-confident-excerpt.trycloudflare.com";
  const AVATARS = Array.from(
    { length: 8 },
    (_, index) => `avatar-${String(index + 1).padStart(2, "0")}`,
  );

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

  const defaultBackendUrl = window.location.hostname.endsWith("github.io")
    ? PUBLIC_BACKEND_URL
    : "http://localhost:3000";
  const initialBackendUrl =
    query.get("server") ||
    storage.get(STORAGE_KEYS.backendUrl, defaultBackendUrl);
  const initialNickname =
    storage.get(STORAGE_KEYS.nickname) ||
    randomNames[Math.floor(Math.random() * randomNames.length)];
  const initialPlayerToken =
    storage.get(STORAGE_KEYS.playerToken) || createPlayerToken();
  const storedAvatarId = storage.get(STORAGE_KEYS.avatarId);
  const initialAvatarId = AVATARS.includes(storedAvatarId)
    ? storedAvatarId
    : AVATARS[Math.floor(Math.random() * AVATARS.length)];

  storage.set(STORAGE_KEYS.playerToken, initialPlayerToken);
  storage.set(STORAGE_KEYS.nickname, initialNickname);
  storage.set(STORAGE_KEYS.avatarId, initialAvatarId);

  const state = {
    socket: null,
    connected: false,
    connecting: false,
    backendUrl: normalizeBackendUrl(initialBackendUrl),
    playerToken: initialPlayerToken,
    playerId: null,
    nickname: initialNickname,
    avatarId: initialAvatarId,
    roomCode: storage.get(STORAGE_KEYS.roomCode),
    roomState: null,
    gameState: null,
    dashOrder: null,
    guessTarget: null,
    kickTarget: null,
    guessFeedback: null,
    flashingTileIds: [],
    showLeaveGameConfirm: false,
    showSettings: false,
    busyActions: new Set(),
    joinCode: (query.get("room") || "")
      .replace(/\D/g, "")
      .slice(0, 4),
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

  function avatarUrl(avatarId) {
    const safeAvatarId = AVATARS.includes(avatarId) ? avatarId : AVATARS[0];
    return `./assets/avatars/${safeAvatarId}.jpg`;
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
    } else {
      url.searchParams.delete("room");
    }
    if (state.backendUrl === PUBLIC_BACKEND_URL) {
      url.searchParams.delete("server");
    } else {
      url.searchParams.set("server", state.backendUrl);
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
    state.kickTarget = null;
    state.guessFeedback = null;
    state.flashingTileIds = [];
    state.showLeaveGameConfirm = false;
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
            message: "服务器响应超时，请检查连接设置。",
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
      showToast("游戏连接资源加载失败。", "error");
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
      const previousGameState = state.gameState;
      const previousTurnPlayerId = previousGameState?.currentTurnPlayerId;
      const nextTurnPlayerId = gameState.currentTurnPlayerId;
      const previousSelf = previousGameState?.players.find(
        (player) => player.id === previousGameState.selfPlayerId,
      );
      const nextSelf = gameState.players.find(
        (player) => player.id === gameState.selfPlayerId,
      );
      const newlyGuessedOwnTileIds =
        previousGameState?.status === "PLAYING" &&
        previousTurnPlayerId &&
        previousTurnPlayerId !== gameState.selfPlayerId
          ? (nextSelf?.hand || [])
              .filter((tile) => {
                const previousTile = previousSelf?.hand?.find(
                  (candidate) => candidate.id === tile.id,
                );
                return tile.isRevealed && previousTile && !previousTile.isRevealed;
              })
              .map((tile) => tile.id)
          : [];
      state.gameState = gameState;
      state.playerId = gameState.selfPlayerId;
      syncDashOrder();
      if (
        previousGameState?.status === "PLAYING" &&
        gameState.status === "PLAYING" &&
        previousTurnPlayerId &&
        nextTurnPlayerId &&
        previousTurnPlayerId !== nextTurnPlayerId
      ) {
        const previousPlayer = previousGameState.players.find(
          (player) => player.id === previousTurnPlayerId,
        );
        const nextPlayer = gameState.players.find(
          (player) => player.id === nextTurnPlayerId,
        );
        showToast(
          `${previousPlayer?.nickname || "上一位玩家"}的回合结束 · 轮到${nextPlayer?.id === gameState.selfPlayerId ? "你" : nextPlayer?.nickname || "下一位玩家"}`,
          "success",
        );
      }
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
      if (newlyGuessedOwnTileIds.length) {
        showCenterFeedback("hit", newlyGuessedOwnTileIds);
      }
    });

    state.socket.on("action_error", (error) => {
      showToast(error.message || "服务器拒绝了该操作。", "error");
    });

    state.socket.on("session_replaced", () => {
      showToast("这个身份已在另一个页面恢复，本页已停止控制。", "error");
    });

    state.socket.on("kicked_from_room", (payload) => {
      forgetRoom();
      render();
      showToast(payload?.message || "你已被房主移出房间。", "error");
    });
  }

  function renderShell(content) {
    return `
      <div class="safe-bottom mx-auto flex min-h-[100dvh] w-full min-w-0 max-w-[1480px] flex-col overflow-x-hidden px-3 sm:px-6 lg:px-8 lg:pb-0">
        <main class="flex min-w-0 flex-1 flex-col py-4 sm:py-6">${content}</main>
      </div>
      ${state.showSettings ? renderSettingsModal() : ""}
      ${state.guessTarget ? renderGuessModal() : ""}
      ${state.kickTarget ? renderKickModal() : ""}
      ${state.showLeaveGameConfirm ? renderLeaveGameModal() : ""}
      ${state.guessFeedback ? renderGuessFeedback() : ""}
    `;
  }

  function renderAvatarPicker() {
    return `
      <fieldset class="mt-4 sm:mt-5">
        <legend class="mb-1.5 text-xs font-bold text-white/55 sm:mb-2">选择头像</legend>
        <div class="grid grid-cols-4 gap-1.5 sm:grid-cols-8 sm:gap-2">
          ${AVATARS.map(
            (avatarId, index) => `
              <button
                type="button"
                data-action="select-avatar"
                data-avatar-id="${avatarId}"
                aria-label="选择头像 ${index + 1}"
                aria-pressed="${state.avatarId === avatarId}"
                class="relative aspect-square overflow-hidden rounded-xl border-2 transition active:scale-95 sm:rounded-2xl ${
                  state.avatarId === avatarId
                    ? "border-amber-400 ring-4 ring-amber-500/15"
                    : "border-stone-700 opacity-65 hover:border-stone-500 hover:opacity-100"
                }"
              >
                <img src="${avatarUrl(avatarId)}" alt="" class="h-full w-full object-cover" />
                ${
                  state.avatarId === avatarId
                    ? `<span class="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-amber-500 text-[0.62rem] font-black text-stone-950">✓</span>`
                    : ""
                }
              </button>
            `,
          ).join("")}
        </div>
        <p class="mt-1.5 text-[0.65rem] text-stone-600 sm:mt-2 sm:text-[0.68rem]">同一房间内每个头像只能由一位玩家使用。</p>
      </fieldset>
    `;
  }

  function renderLobby() {
    const roomPrefill = state.joinCode || query.get("room") || "";
    return `
      <div class="grid flex-1 content-center gap-5 py-3 sm:items-center sm:gap-7 sm:py-7 lg:grid-cols-[1.08fr_0.92fr] lg:gap-14">
        <section class="relative mx-auto min-h-[9.75rem] w-full max-w-3xl lg:mx-0 lg:min-h-0">
          <div class="mb-5 hidden items-center gap-3 lg:flex">
            <p class="eyebrow">经典推理桌游</p>
            <span class="h-px flex-1 bg-gradient-to-r from-white/15 to-transparent"></span>
          </div>
          <h1 class="max-w-3xl text-[2.65rem] font-black leading-[0.94] tracking-[-0.06em] text-white min-[430px]:text-5xl sm:text-7xl lg:text-[6.1rem]">
            看见颜色，<br />
            <span class="bg-gradient-to-r from-white/24 to-white/8 bg-clip-text text-transparent">猜出密码。</span>
          </h1>
          <p class="mt-7 hidden max-w-xl text-lg leading-7 text-white/52 lg:block">
            牌面越沉默，信息越响亮。按序排列你的数字，把百搭牌藏在任意位置，然后逐张拆穿对手。
          </p>
          <div class="mt-9 hidden max-w-xl grid-cols-3 gap-3 lg:grid">
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
          <div class="absolute right-1 top-4 flex w-[7.5rem] flex-col items-center gap-2 lg:static lg:mt-7 lg:w-auto lg:flex-row lg:items-end lg:justify-start lg:gap-3" aria-hidden="true">
            <div class="flex items-end gap-1.5 lg:gap-3">
              <div class="tile tile-black -rotate-6 opacity-55"><span class="text-[0.58rem] font-black opacity-40">黑</span><span class="text-3xl font-black">?</span><span class="text-[0.5rem] opacity-30"></span></div>
              <div class="tile tile-white translate-y-2 rotate-3"><span class="text-[0.58rem] font-black opacity-40">白</span><span class="text-3xl font-black">—</span><span class="text-[0.5rem] opacity-30">百搭牌</span></div>
            </div>
            <p class="max-w-[7.5rem] text-[0.58rem] leading-3 text-white/28 lg:mb-2 lg:max-w-[13rem] lg:text-xs lg:leading-5">两种颜色，一套顺序。<br />唯一的例外，就是最好的伪装。</p>
          </div>
        </section>

        <section class="panel mx-auto w-full max-w-xl p-3.5 sm:p-7">
          <div class="mb-4 sm:mb-6">
            <p class="eyebrow">进入牌桌</p>
            <h2 class="mt-2 text-xl font-black tracking-tight sm:text-2xl">开始一局推理</h2>
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
          ${renderAvatarPicker()}

          <form data-form="create-room" class="mt-4 sm:mt-5">
            <button class="btn-primary w-full" ${state.connected ? "" : "disabled"}>
              <span>创建新房间</span>
              <span aria-hidden="true">→</span>
            </button>
          </form>

          <div class="my-3.5 flex items-center gap-3 sm:my-5">
            <span class="h-px flex-1 bg-white/8"></span>
            <span class="text-[0.65rem] font-bold tracking-[0.2em] text-white/25">或加入房间</span>
            <span class="h-px flex-1 bg-white/8"></span>
          </div>

          <form data-form="join-room" class="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:gap-3">
            <input
              name="roomCode"
              class="input tracking-[0.24em]"
              maxlength="4"
              inputmode="numeric"
              pattern="[0-9]{4}"
              autocomplete="off"
              value="${escapeHtml(roomPrefill)}"
              placeholder="请输入房间号"
            />
            <button class="btn-secondary shrink-0 px-5 sm:px-6" ${state.connected ? "" : "disabled"}>加入</button>
          </form>

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
    const self = state.roomState?.players.find(
      (candidate) => candidate.id === state.playerId,
    );
    const canKick = Boolean(self?.isHost && !isSelf);
    return `
      <div class="rounded-2xl border ${isSelf ? "border-coral-500/35 bg-coral-500/[0.06]" : "border-white/10 bg-white/[0.04]"} p-3.5 sm:rounded-3xl sm:p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="flex min-w-0 flex-1 items-center gap-3">
            <img
              src="${avatarUrl(player.avatarId)}"
              alt="${escapeHtml(player.nickname)} 的头像"
              class="h-9 w-9 shrink-0 rounded-xl border border-white/10 object-cover sm:h-11 sm:w-11 sm:rounded-2xl ${player.isConnected ? "" : "grayscale opacity-45"}"
            />
            <div class="min-w-0">
              <p class="truncate font-bold">${escapeHtml(player.nickname)}${isSelf ? "（你）" : ""}</p>
              <p class="mt-1 text-xs ${player.isConnected ? "text-lime-300/65" : "text-red-300/60"}">
                ${player.isConnected ? "在线" : "等待重连"}
              </p>
            </div>
          </div>
          ${player.isHost ? `<span class="shrink-0 whitespace-nowrap rounded-full bg-white/8 px-2 py-1 text-[0.54rem] font-black text-white/45 sm:px-2.5 sm:text-[0.62rem]">房主</span>` : ""}
        </div>
        <div class="mt-4 flex items-center justify-between gap-2 text-[0.68rem] font-bold sm:mt-5 sm:text-xs">
          <span class="flex items-center gap-2">
            <span class="h-2 w-2 rounded-full ${player.isReady ? "bg-lime-300" : "bg-white/20"}"></span>
            <span class="${player.isReady ? "text-lime-200/80" : "text-white/35"}">${player.isReady ? "已准备" : "未准备"}</span>
          </span>
          ${canKick ? `<button type="button" data-action="open-kick" data-player-id="${player.id}" class="rounded-lg border border-red-900/50 px-2 py-1 text-[0.65rem] text-red-300/70 transition hover:border-red-500/60 hover:text-red-200">移出</button>` : ""}
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
    const waitingMessage =
      players.length < 2
        ? "还需要 1 位玩家或等待其他人加入。"
        : allReady
          ? "全员就绪，可以开始。"
          : "";
    return `
      <div class="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center py-2 sm:py-6">
        <div class="mb-5 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between sm:gap-5">
          <div>
            <div class="flex flex-wrap items-center gap-3">
              <h1 class="text-3xl font-black tracking-[-0.055em] sm:text-5xl">等待玩家</h1>
              <span class="rounded-xl border border-white/10 bg-white/5 px-3 py-2 font-mono text-base font-black tracking-[0.2em] sm:rounded-2xl sm:text-lg">${escapeHtml(state.roomCode)}</span>
            </div>
            <p class="mt-3 text-sm text-white/40">2–4 人 · 全员准备后由房主开始</p>
          </div>
          <div class="grid grid-cols-3 gap-2 sm:flex">
            <button type="button" data-action="leave-room" class="btn-secondary">退出房间</button>
            <button type="button" data-action="refresh-room" class="btn-secondary">刷新座位</button>
            <button type="button" data-action="copy-room" class="btn-secondary">复制链接</button>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-2.5 sm:gap-4">
          ${Array.from({ length: 4 }, (_, index) => renderSeat(players[index], index)).join("")}
        </div>

        <div class="panel sticky bottom-2 z-20 mt-4 flex flex-col gap-3 p-3.5 sm:static sm:mt-6 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-5">
          <div class="min-h-5 text-sm ${allReady ? "font-bold text-lime-300" : "text-white/45"}">${waitingMessage}</div>
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
        class="tile ${colorClass} ${showValue ? "" : "tile-hidden"} ${actionable ? "tile-actionable" : ""} ${tile.isRevealed ? "tile-revealed" : ""} ${state.flashingTileIds.includes(tile.id) ? "tile-hit-flash" : ""} ${tile.isDrawnThisTurn ? "ring-2 ring-coral-500" : ""}"
        ${actionable ? `data-action="open-guess" data-player-id="${escapeHtml(options.playerId)}" data-tile-id="${escapeHtml(tile.id)}"` : "disabled"}
        aria-label="${actionable ? "猜测这张暗牌" : showValue ? `牌面 ${value}` : "未揭开的牌"}"
      >
        <span class="relative z-10 text-[0.58rem] font-black tracking-widest opacity-45">${tile.color === "white" ? "白" : "黑"}</span>
        <span class="relative z-10 text-[1.7rem] font-black tracking-tighter ${showValue ? "" : "opacity-35"} sm:text-4xl">${showValue ? escapeHtml(value) : "?"}</span>
        <span class="relative z-10 whitespace-nowrap text-[0.48rem] font-black leading-none text-amber-500 sm:text-[0.55rem]">${tile.isRevealed ? "【公开】" : ""}</span>
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
    const tiles = player.hand
      .map(
        (tile) =>
          tileMarkup(tile, {
            isSelf: options.isSelf,
            playerId: player.id,
            actionable:
              !options.isSelf &&
              state.gameState?.canAct?.guess &&
              !player.isEliminated,
          }),
      )
      .flatMap((tile, index) =>
        index < player.hand.length - 1
          ? [tile, `<span class="tile-relation" aria-hidden="true">&lt;</span>`]
          : [tile],
      )
      .join("");
    return `
      <div class="player-hand-row scrollbar-subtle flex w-full max-w-full items-center overflow-x-auto px-2 py-3">
        ${tiles}
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
      <section class="opponent-zone w-full min-w-0 overflow-hidden rounded-2xl border ${player.isCurrentTurn ? "border-lime-300/35 bg-lime-300/[0.045] shadow-lg shadow-lime-300/5" : "border-white/8 bg-white/[0.025]"} p-3 sm:rounded-3xl sm:p-4">
        <div class="mb-2 flex items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-2.5">
            <img src="${avatarUrl(player.avatarId)}" alt="" class="h-9 w-9 shrink-0 rounded-xl border border-white/10 object-cover ${player.isEliminated ? "grayscale opacity-40" : ""}" />
            <div class="min-w-0">
              <h3 class="truncate font-bold ${player.isEliminated ? "text-white/35 line-through" : "text-white"}">${escapeHtml(player.nickname)}</h3>
              <p class="mt-0.5 text-[0.65rem] font-bold uppercase tracking-[0.16em] ${player.isCurrentTurn ? "text-lime-300" : "text-white/25"}">${playerStatusLabel(player)}</p>
            </div>
          </div>
          <span class="h-2.5 w-2.5 rounded-full ${player.isConnected ? "bg-lime-300/70" : "bg-red-400/70"}"></span>
        </div>
        ${renderPlayerHand(player)}
      </section>
    `;
  }

  function renderLeaveGameButton() {
    return `
      <button
        type="button"
        data-action="open-leave-game"
        class="inline-flex min-h-10 items-center justify-center rounded-xl border border-red-900/60 bg-red-950/35 px-3.5 text-xs font-black text-red-200/80 transition active:scale-[0.98]"
      >退出游戏</button>
    `;
  }

  function renderSetupDash() {
    const self = selfGamePlayer();
    const orderedTiles = (state.dashOrder || [])
      .map((tileId) => self?.hand?.find((tile) => tile.id === tileId))
      .filter(Boolean);
    const dashTiles = orderedTiles.filter((tile) => tile.value === DASH);
    const handMarkup = orderedTiles
      .map(
        (tile, index) => `
          ${tileMarkup(tile, { isSelf: true })}
          ${index < orderedTiles.length - 1 ? `<span class="tile-relation" aria-hidden="true">&lt;</span>` : ""}
        `,
      )
      .join("");
    const dashPositionControls = dashTiles
      .map((tile, dashIndex) => {
        const currentIndex = orderedTiles.findIndex(
          (candidate) => candidate.id === tile.id,
        );
        return `
          <div class="rounded-2xl border border-amber-900/35 bg-stone-950/55 p-3">
            <p class="mb-2 text-xs font-bold text-stone-400">${dashTiles.length > 1 ? `百搭牌 ${dashIndex + 1}` : "百搭牌"}放在第几位？</p>
            <div class="grid grid-cols-4 gap-2 sm:flex sm:flex-wrap">
              ${Array.from(
                { length: orderedTiles.length },
                (_, index) => `
                  <button
                    type="button"
                    data-action="set-setup-dash-position"
                    data-tile-id="${tile.id}"
                    data-index="${index}"
                    class="${currentIndex === index ? "border-amber-500 bg-amber-500 text-stone-950" : "border-stone-700 bg-stone-800 text-stone-300"} min-h-10 rounded-xl border px-3 text-xs font-black transition active:scale-95"
                  >
                    第 ${index + 1} 位
                  </button>
                `,
              ).join("")}
            </div>
          </div>
        `;
      })
      .join("");
    return `
      <div class="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center py-3">
        <div class="mb-3 flex justify-end">
          ${renderLeaveGameButton()}
        </div>
        <div class="mb-5 text-center sm:mb-7">
          <h1 class="text-3xl font-black tracking-tight sm:text-5xl">全员秘密准备</h1>
          <span
            data-setup-countdown
            data-setup-ends-at="${state.gameState.setupEndsAt || 0}"
            class="mt-3 inline-flex rounded-full border border-amber-700/50 bg-amber-950/35 px-4 py-2 text-base font-black text-amber-300"
          >倒计时 10 秒</span>
          <p class="mt-3 text-sm text-stone-500">百搭牌可以放在任意位置；倒计时结束仍未提交，服务端将随机摆放。</p>
        </div>

        <section class="panel table-surface p-4 sm:p-7">
          ${
            state.gameState.canAct.confirmDash
              ? `
                <h2 class="text-center text-xl font-black">${dashTiles.length ? "选择百搭牌的位置" : "确认你的初始手牌"}</h2>
                <div class="scrollbar-subtle -mx-1 mt-4 flex items-center justify-start overflow-x-auto px-1 py-2 sm:justify-center">
                  ${handMarkup}
                </div>
                ${dashTiles.length ? `<div class="mt-4 space-y-3">${dashPositionControls}</div>` : ""}
                <button type="button" data-action="confirm-dash" class="btn-primary mt-5 w-full">完成摆放</button>
              `
              : `
                <div class="flex min-h-32 flex-col items-center justify-center text-center">
                  <div class="mb-4 flex gap-2">
                    <span class="h-2.5 w-2.5 animate-bounce rounded-full bg-coral-500 [animation-delay:-0.2s]"></span>
                    <span class="h-2.5 w-2.5 animate-bounce rounded-full bg-coral-500 [animation-delay:-0.1s]"></span>
                    <span class="h-2.5 w-2.5 animate-bounce rounded-full bg-coral-500"></span>
                  </div>
                  <h2 class="text-xl font-black">已完成摆放</h2>
                  <p class="mt-2 text-sm text-white/38">等待倒计时结束后统一开局。</p>
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
        <p class="mb-3 text-xs font-bold text-white/45">点击加号选择百搭牌的插入位置</p>
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
    const lastActor = playerById(game.lastTurnPlayerId);
    const isMyTurn = actor?.id === self?.id;
    const turnDraw = game.turnDraw;
    const counts = game.drawPileCounts;

    if (game.status === "FINISHED") {
      const winner = playerById(game.winnerPlayerId);
      return `
        <div class="mx-auto w-full max-w-lg text-center">
          <img src="${avatarUrl(winner?.avatarId)}" alt="" class="mx-auto h-24 w-24 rounded-3xl border-2 border-amber-400 object-cover shadow-2xl shadow-amber-950/40" />
          <h2 class="mt-5 text-3xl font-black text-amber-100 sm:text-4xl">${escapeHtml(winner?.nickname || "获胜玩家")} 获得胜利！</h2>
          <div class="mt-7 grid grid-cols-2 gap-3">
            <button type="button" data-action="play-again" class="btn-primary">再来一局</button>
            <button type="button" data-action="return-home" class="btn-secondary">回到大厅</button>
          </div>
        </div>
      `;
    }

    let instruction = "";
    let actionContent = "";
    if (game.phase === "DRAW") {
      instruction = isMyTurn
        ? "请摸一张牌"
        : `${escapeHtml(actor?.nickname || "当前玩家")} 正在摸牌`;
      actionContent = isMyTurn
        ? `
          <div class="pt-2">
            <div class="flex justify-center gap-10">
              <button
                type="button"
                data-action="draw-tile"
                data-color="black"
                aria-label="摸黑牌，剩余 ${counts.black} 张"
                class="group flex flex-col items-center gap-2 transition active:scale-95 disabled:opacity-30"
                ${counts.black ? "" : "disabled"}
              >
                <span class="draw-pile tile tile-black !h-20 !w-14 !rounded-lg !px-1 !py-2">
                  <span class="text-[0.45rem] font-black tracking-wider opacity-45">剩余张数：</span>
                  <span class="text-2xl font-black">${counts.black}</span>
                  <span class="text-[0.45rem] font-black opacity-35">黑牌</span>
                </span>
                <span class="text-xs font-black text-stone-300 group-hover:text-amber-300">黑牌</span>
              </button>
              <button
                type="button"
                data-action="draw-tile"
                data-color="white"
                aria-label="摸白牌，剩余 ${counts.white} 张"
                class="group flex flex-col items-center gap-2 transition active:scale-95 disabled:opacity-30"
                ${counts.white ? "" : "disabled"}
              >
                <span class="draw-pile tile tile-white !h-20 !w-14 !rounded-lg !px-1 !py-2">
                  <span class="text-[0.45rem] font-black tracking-wider opacity-45">剩余张数：</span>
                  <span class="text-2xl font-black">${counts.white}</span>
                  <span class="text-[0.45rem] font-black opacity-35">白牌</span>
                </span>
                <span class="text-xs font-black text-stone-300 group-hover:text-amber-300">白牌</span>
              </button>
            </div>
          </div>
        `
        : "";
    } else if (game.phase === "PLACE_DASH") {
      instruction = "请把摸到的百搭牌放进你的牌列";
      actionContent = `
        <div>
          ${renderDashInsertion(self)}
        </div>
      `;
    } else if (game.phase === "WAITING_FOR_PLAYER") {
      instruction = `${escapeHtml(actor?.nickname || "当前玩家")} 正在放置摸到的百搭牌`;
    } else if (game.phase === "GUESS") {
      instruction = isMyTurn
        ? "请选择对手的任意一张牌进行猜牌"
        : `${escapeHtml(actor?.nickname || "当前玩家")} 正在选择要猜的牌`;
    } else if (game.phase === "DECIDE") {
      instruction = isMyTurn
        ? "猜对了！请继续选择一张牌进行猜测，或者跳过回合"
        : `${escapeHtml(actor?.nickname || "当前玩家")} 正在继续猜牌`;
      actionContent = isMyTurn
        ? `
          <div class="flex justify-center">
            <button type="button" data-action="end-turn" class="btn-primary min-w-36">跳过回合</button>
          </div>
        `
        : "";
    }

    return `
      <div class="w-full text-center">
        <div class="mx-auto mb-4 max-w-md rounded-2xl border ${isMyTurn ? "border-amber-500/55 bg-amber-500/12 shadow-lg shadow-amber-950/20" : "border-stone-700/70 bg-stone-900/75"} px-4 py-4 sm:mb-5">
          <h2 class="text-xl font-black ${isMyTurn ? "text-amber-100" : "text-stone-200"}">${isMyTurn ? "轮到你的回合" : `轮到 ${escapeHtml(actor?.nickname || "当前玩家")} 的回合`}</h2>
          <p class="mt-2 text-sm font-bold ${isMyTurn ? "text-amber-300" : "text-stone-500"}">${instruction}</p>
          ${lastActor ? `<p class="mt-2 text-[0.68rem] font-semibold text-stone-600">上一回合：${escapeHtml(lastActor.nickname)} 已结束</p>` : ""}
        </div>
        ${
          turnDraw
            ? `
              <div class="mb-4 flex justify-center sm:mb-5">
                <div>
                  ${tileMarkup(turnDraw, { isSelf: isMyTurn })}
                  <p class="mt-2 text-[0.6rem] font-bold text-white/25">${turnDraw.isPlaced ? "已放入牌列" : "本回合摸到"}</p>
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
          <span class="eyebrow text-amber-400">对局记录</span>
          <span class="rounded-lg bg-stone-800 px-2 py-1 text-[0.62rem] text-stone-400">${logs.length} 条 · 点击展开</span>
        </summary>
        <div class="scrollbar-subtle mt-4 max-h-52 space-y-3 overflow-y-auto pr-2">
          ${logEntries}
        </div>
      </details>
      <aside class="panel hidden min-h-0 flex-col p-4 lg:flex">
        <div class="mb-3 flex items-center justify-between">
          <p class="eyebrow text-amber-400">对局记录</p>
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
      ${
        game.status === "PLAYING"
          ? `<div class="mb-3 flex w-full justify-end">${renderLeaveGameButton()}</div>`
          : ""
      }
      <div class="grid w-full min-w-0 flex-1 gap-3 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div class="flex w-full min-w-0 flex-col gap-3 sm:gap-4">
          <div class="grid w-full min-w-0 grid-cols-1 gap-3 ${opponentGridClass}">
            ${opponents.map(renderOpponentZone).join("")}
          </div>

          <section class="turn-control-panel panel table-surface flex w-full min-w-0 min-h-44 items-center justify-center border-amber-900/35 p-4 sm:min-h-64 sm:flex-1 sm:p-7">
            ${renderTurnControl()}
          </section>

          <section class="self-hand-panel w-full min-w-0 overflow-hidden rounded-2xl border ${self?.isCurrentTurn ? "border-amber-500/45 bg-amber-950/15" : "border-stone-800 bg-stone-950/70"} p-3 sm:rounded-3xl sm:p-5">
            <div class="mb-2 flex flex-wrap items-center justify-between gap-3">
              <div class="flex min-w-0 items-center gap-2.5">
                <img src="${avatarUrl(self?.avatarId || state.avatarId)}" alt="" class="h-9 w-9 shrink-0 rounded-xl border border-white/10 object-cover" />
                <div class="min-w-0">
                  <h3 class="truncate text-sm font-black text-amber-300 sm:text-base">${escapeHtml(self?.nickname || state.nickname)} <span class="text-stone-500">/ 你的手牌</span></h3>
                  ${self?.isEliminated ? `<p class="mt-1 text-[0.68rem] text-stone-600 sm:text-xs">你已被淘汰，但仍可观战。</p>` : ""}
                </div>
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
              <p class="eyebrow text-amber-400">连接设置</p>
              <h2 id="settings-title" class="mt-2 text-2xl font-black">游戏后端地址</h2>
            </div>
            <button type="button" data-action="close-settings" class="h-10 w-10 rounded-xl bg-stone-800 text-xl text-stone-400 hover:bg-stone-700 hover:text-white">×</button>
          </div>
          <p class="mt-4 text-sm leading-6 text-stone-500">仅在需要切换服务器时修改此地址。</p>
          <label for="backendUrl" class="mt-5 mb-2 block text-xs font-bold text-white/55">后端地址</label>
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
    const guessValues = [
      ...Array.from({ length: 12 }, (_, value) => value),
      DASH,
    ];
    return `
      <div class="fixed inset-0 z-50 flex items-end justify-center overflow-hidden bg-black/80 p-0 backdrop-blur-sm sm:items-center sm:p-4">
        <div class="panel safe-bottom max-h-[calc(100dvh-0.5rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-b-none border-x-0 border-b-0 p-4 sm:max-h-[calc(100dvh-2rem)] sm:rounded-3xl sm:border sm:p-6" role="dialog" aria-modal="true" aria-labelledby="guess-title">
          <div class="mx-auto mb-3 h-1 w-10 rounded-full bg-stone-700 sm:hidden"></div>
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="eyebrow text-amber-400">猜牌</p>
              <h2 id="guess-title" class="mt-1.5 text-xl font-black sm:mt-2 sm:text-2xl">这张牌是什么？</h2>
              <p class="mt-1.5 text-xs text-stone-500 sm:mt-2 sm:text-sm">目标：${escapeHtml(target?.nickname || "对手")}</p>
            </div>
            <button type="button" data-action="close-guess" class="h-9 w-9 shrink-0 rounded-xl bg-stone-800 text-lg text-stone-400 hover:bg-stone-700 hover:text-white sm:h-10 sm:w-10 sm:text-xl">×</button>
          </div>
          <div class="mt-4 grid grid-cols-5 gap-1.5 sm:mt-6 sm:gap-2">
            ${guessValues
              .map(
                (value) => `
                  <button
                    type="button"
                    data-action="submit-guess"
                    data-value="${value}"
                    aria-label="${value === DASH ? "猜百搭牌" : `猜数字 ${value}`}"
                    class="guess-option ${value === 10 ? "col-start-2" : ""} flex aspect-square items-center justify-center rounded-lg border border-stone-700 bg-stone-800 text-lg font-black text-stone-100 transition hover:border-stone-500 hover:bg-stone-700 sm:rounded-xl sm:text-xl"
                  >${value === DASH ? "—" : value}</button>
                `,
              )
              .join("")}
          </div>
        </div>
      </div>
    `;
  }

  function renderKickModal() {
    const target = state.roomState?.players.find(
      (player) => player.id === state.kickTarget,
    );
    if (!target) {
      return "";
    }
    return `
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" data-action="close-kick-backdrop">
        <div class="panel w-full max-w-sm p-5 text-center" role="dialog" aria-modal="true" aria-labelledby="kick-title">
          <img src="${avatarUrl(target.avatarId)}" alt="" class="mx-auto h-16 w-16 rounded-2xl border border-white/10 object-cover" />
          <h2 id="kick-title" class="mt-4 text-xl font-black">确认移出 ${escapeHtml(target.nickname)}？</h2>
          <p class="mt-2 text-sm leading-6 text-stone-500">该玩家会立即回到大厅，需要重新加入才能进入房间。</p>
          <div class="mt-5 grid grid-cols-2 gap-3">
            <button type="button" data-action="close-kick" class="btn-secondary">取消</button>
            <button type="button" data-action="confirm-kick" data-player-id="${target.id}" class="btn min-h-11 rounded-xl border border-red-700/60 bg-red-950/70 font-black text-red-200 hover:bg-red-900/70">确认移出</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderLeaveGameModal() {
    return `
      <div class="fixed inset-0 z-[65] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" data-action="close-leave-game-backdrop">
        <div class="panel w-full max-w-sm p-5 text-center" role="dialog" aria-modal="true" aria-labelledby="leave-game-title">
          <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-950 text-2xl font-black text-red-300">!</div>
          <h2 id="leave-game-title" class="mt-4 text-xl font-black">游戏正在进行，是否确认退出？</h2>
          <p class="mt-2 text-sm leading-6 text-stone-500">确认退出后将视为弃权，你的手牌会全部公开。</p>
          <div class="mt-5 grid grid-cols-2 gap-3">
            <button type="button" data-action="close-leave-game" class="btn-secondary">取消</button>
            <button type="button" data-action="confirm-leave-game" class="btn min-h-11 rounded-xl border border-red-700/60 bg-red-950/70 font-black text-red-200 hover:bg-red-900/70">确认退出</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderGuessFeedback() {
    const feedback = state.guessFeedback;
    const isCorrect = feedback.kind === "correct";
    const isHit = feedback.kind === "hit";
    const toneClass = isCorrect
      ? "border-emerald-500/60 bg-emerald-950/95 text-emerald-50"
      : isHit
        ? "border-amber-500/60 bg-amber-950/95 text-amber-50"
        : "border-red-500/60 bg-red-950/95 text-red-50";
    const iconClass = isCorrect
      ? "bg-emerald-400 text-emerald-950"
      : isHit
        ? "bg-amber-400 text-amber-950"
        : "bg-red-400 text-red-950";
    const icon = isCorrect ? "✓" : isHit ? "!" : "×";
    const label = isCorrect ? "猜对了" : isHit ? "被猜中了！" : "猜错了";
    const backdropClass = isHit
      ? "bg-transparent"
      : "bg-black/30 backdrop-blur-[2px]";
    return `
      <div class="${backdropClass} pointer-events-none fixed inset-0 z-[70] flex items-center justify-center p-5" data-feedback-kind="${feedback.kind}">
        <div class="${toneClass} w-full max-w-xs rounded-3xl border px-6 py-7 text-center shadow-2xl">
          <div class="${iconClass} mx-auto flex h-14 w-14 items-center justify-center rounded-full text-3xl font-black">${icon}</div>
          <h2 class="mt-4 text-3xl font-black">${label}</h2>
        </div>
      </div>
    `;
  }

  function showCenterFeedback(kind, flashingTileIds = []) {
    const id = Date.now();
    state.guessFeedback = { id, kind };
    state.flashingTileIds = flashingTileIds;
    render();
    window.setTimeout(() => {
      if (state.guessFeedback?.id === id) {
        state.guessFeedback = null;
        state.flashingTileIds = [];
        render();
      }
    }, 900);
  }

  function showGuessFeedback(correct) {
    showCenterFeedback(correct ? "correct" : "wrong");
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
    updateSetupCountdown();
  }

  function updateSetupCountdown() {
    for (const element of document.querySelectorAll("[data-setup-countdown]")) {
      const endsAt = Number(element.dataset.setupEndsAt);
      const seconds = Math.max(0, Math.ceil((endsAt - Date.now()) / 1_000));
      element.textContent = `倒计时 ${seconds} 秒`;
    }
  }

  async function createRoom() {
    const response = await runAction("create_room", {
      nickname: state.nickname,
      avatarId: state.avatarId,
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
      avatarId: state.avatarId,
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
        .replace(/\D/g, "")
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
        .trim();
      if (!/^\d{4}$/.test(roomCode)) {
        showToast("请输入 4 位数字房间码。", "error");
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
    } else if (action === "select-avatar") {
      const avatarId = trigger.dataset.avatarId;
      if (AVATARS.includes(avatarId)) {
        state.avatarId = avatarId;
        storage.set(STORAGE_KEYS.avatarId, avatarId);
        render();
      }
    } else if (action === "close-settings") {
      state.showSettings = false;
      render();
    } else if (
      action === "close-settings-backdrop" &&
      event.target === trigger
    ) {
      state.showSettings = false;
      render();
    } else if (action === "leave-room") {
      const response = await runAction("leave_room");
      if (response) {
        forgetRoom();
        render();
        showToast("已退出房间。", "success");
      }
    } else if (action === "open-leave-game") {
      state.showLeaveGameConfirm = true;
      render();
    } else if (action === "close-leave-game") {
      state.showLeaveGameConfirm = false;
      render();
    } else if (
      action === "close-leave-game-backdrop" &&
      event.target === trigger
    ) {
      state.showLeaveGameConfirm = false;
      render();
    } else if (action === "confirm-leave-game") {
      const response = await runAction("leave_game");
      if (response) {
        forgetRoom();
        render();
        showToast("已退出游戏。", "success");
      }
    } else if (action === "refresh-room") {
      await runAction(
        "refresh_room",
        {},
        { successMessage: "房间座位已刷新。" },
      );
    } else if (action === "open-kick") {
      state.kickTarget = trigger.dataset.playerId;
      render();
    } else if (action === "close-kick") {
      state.kickTarget = null;
      render();
    } else if (
      action === "close-kick-backdrop" &&
      event.target === trigger
    ) {
      state.kickTarget = null;
      render();
    } else if (action === "confirm-kick") {
      const response = await runAction("kick_player", {
        playerId: trigger.dataset.playerId,
      });
      state.kickTarget = null;
      render();
      if (response) {
        showToast("玩家已移出房间。", "success");
      }
    } else if (action === "copy-room") {
      const url = new URL(window.location.href);
      url.searchParams.set("room", state.roomCode);
      if (state.backendUrl === PUBLIC_BACKEND_URL) {
        url.searchParams.delete("server");
      } else {
        url.searchParams.set("server", state.backendUrl);
      }
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
    } else if (action === "set-setup-dash-position") {
      const tileId = trigger.dataset.tileId;
      const targetIndex = Number(trigger.dataset.index);
      const nextOrder = [...state.dashOrder];
      const fromIndex = nextOrder.indexOf(tileId);
      if (
        fromIndex >= 0 &&
        Number.isInteger(targetIndex) &&
        targetIndex >= 0 &&
        targetIndex < nextOrder.length
      ) {
        nextOrder.splice(fromIndex, 1);
        nextOrder.splice(targetIndex, 0, tileId);
        state.dashOrder = nextOrder;
        render();
      }
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
      await runAction("confirm_dash_position", { handOrder: state.dashOrder });
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
        showGuessFeedback(response.correct);
      }
    } else if (action === "continue-guess") {
      await runAction("continue_guess");
    } else if (action === "end-turn") {
      await runAction("end_turn");
    } else if (action === "play-again") {
      await runAction(
        "play_again",
        {},
        { successMessage: "已回到房间，请重新准备。" },
      );
    } else if (action === "return-home") {
      const response = await runAction("return_to_home");
      if (response) {
        forgetRoom();
        render();
      }
    }
  });

  window.setInterval(updateSetupCountdown, 250);
  render();
  connect();
})();
