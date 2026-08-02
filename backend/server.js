"use strict";

const http = require("node:http");
const { randomInt, randomUUID } = require("node:crypto");

const ROOM_STATUS = Object.freeze({
  LOBBY: "LOBBY",
  SETUP_DASH: "SETUP_DASH",
  PLAYING: "PLAYING",
  FINISHED: "FINISHED",
});

const TURN_PHASE = Object.freeze({
  DRAW: "DRAW",
  PLACE_DASH: "PLACE_DASH",
  GUESS: "GUESS",
  DECIDE: "DECIDE",
});

const TILE_COLORS = Object.freeze(["black", "white"]);
const DASH = "-";
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const MAX_LOGS = 100;
const SETUP_DURATION_MS = 10_000;
const AVATAR_IDS = Object.freeze(
  Array.from(
    { length: 8 },
    (_, index) => `avatar-${String(index + 1).padStart(2, "0")}`,
  ),
);

class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GameError";
    this.code = code;
  }
}

function assertGame(condition, code, message) {
  if (!condition) {
    throw new GameError(code, message);
  }
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function normalizeNickname(value) {
  assertGame(typeof value === "string", "INVALID_NICKNAME", "Nickname is required.");
  const nickname = value
    .trim()
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .slice(0, 24);
  assertGame(nickname.length > 0, "INVALID_NICKNAME", "Nickname is required.");
  return nickname;
}

function normalizeRoomCode(value) {
  assertGame(typeof value === "string", "INVALID_ROOM_CODE", "Room code is required.");
  const roomCode = value.trim();
  assertGame(
    /^\d{4}$/.test(roomCode),
    "INVALID_ROOM_CODE",
    "Room code must contain exactly four digits.",
  );
  return roomCode;
}

function normalizePlayerToken(value, { allowGenerate = false } = {}) {
  if ((value === undefined || value === null || value === "") && allowGenerate) {
    return randomUUID();
  }
  assertGame(
    typeof value === "string" &&
      value.length >= 16 &&
      value.length <= 128 &&
      /^[A-Za-z0-9_-]+$/.test(value),
    "INVALID_PLAYER_TOKEN",
    "A valid player token is required.",
  );
  return value;
}

function normalizeAvatarId(value) {
  assertGame(
    typeof value === "string" && AVATAR_IDS.includes(value),
    "INVALID_AVATAR",
    "请选择一个有效头像。",
  );
  return value;
}

function generateRoomCode(rooms) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = String(randomInt(10_000)).padStart(4, "0");
    if (!rooms.has(code)) {
      return code;
    }
  }
  throw new GameError("ROOM_CODE_EXHAUSTED", "Unable to allocate a room code.");
}

function shuffle(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

function createDeck() {
  const deck = [];
  for (const color of TILE_COLORS) {
    for (let value = 0; value <= 11; value += 1) {
      deck.push({
        id: randomUUID(),
        color,
        value,
        isRevealed: false,
      });
    }
    deck.push({
      id: randomUUID(),
      color,
      value: DASH,
      isRevealed: false,
    });
  }
  return deck;
}

function compareNumericTiles(left, right) {
  const valueDelta = left.value - right.value;
  if (valueDelta !== 0) {
    return valueDelta;
  }
  if (left.color === right.color) {
    return 0;
  }
  return left.color === "black" ? -1 : 1;
}

function sortInitialHand(hand) {
  const numericTiles = hand
    .filter((tile) => tile.value !== DASH)
    .sort(compareNumericTiles);
  const dashTiles = hand.filter((tile) => tile.value === DASH);
  return [...numericTiles, ...dashTiles];
}

function randomizeDashPositions(
  hand,
  chooseIndex = (upperBound) => randomInt(upperBound),
) {
  const arrangedHand = hand
    .filter((tile) => tile.value !== DASH)
    .sort(compareNumericTiles);
  const dashTiles = hand.filter((tile) => tile.value === DASH);
  for (const dashTile of dashTiles) {
    const insertionIndex = chooseIndex(arrangedHand.length + 1);
    arrangedHand.splice(insertionIndex, 0, dashTile);
  }
  return arrangedHand;
}

// Numeric tiles are inserted without moving a previously positioned Dash across
// another existing numeric tile. Removing all Dash tiles always leaves a sorted list.
function insertNumericTile(hand, tile) {
  const insertionIndex = hand.findIndex(
    (existingTile) =>
      existingTile.value !== DASH &&
      compareNumericTiles(tile, existingTile) < 0,
  );
  if (insertionIndex === -1) {
    hand.push(tile);
  } else {
    hand.splice(insertionIndex, 0, tile);
  }
}

function createPlayer({ nickname, avatarId, playerToken, socketId, isHost }) {
  return {
    id: randomUUID(), // Public ID. Never use playerToken as a public player ID.
    playerToken,
    socketId,
    nickname,
    avatarId,
    isHost,
    isReady: false,
    isConnected: true,
    isEliminated: false,
    needsDashSetup: false,
    hasSetupDash: true,
    hand: [],
    latestDrawnTileId: null,
  };
}

function createRoom({ roomCode, player }) {
  return {
    roomCode,
    status: ROOM_STATUS.LOBBY,
    players: [player],
    drawPiles: {
      black: [],
      white: [],
    },
    currentTurnIndex: null,
    lastTurnPlayerId: null,
    turnPhase: null,
    turn: {
      drawnTile: null,
      drawnTileInsertIndex: null,
      lastGuessCorrect: false,
    },
    winnerPlayerId: null,
    setupEndsAt: null,
    logs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function addLog(room, message) {
  room.logs.push({
    id: randomUUID(),
    message,
    timestamp: Date.now(),
  });
  if (room.logs.length > MAX_LOGS) {
    room.logs.splice(0, room.logs.length - MAX_LOGS);
  }
  room.updatedAt = Date.now();
}

function currentPlayer(room) {
  if (room.currentTurnIndex === null) {
    return null;
  }
  return room.players[room.currentTurnIndex] || null;
}

function activePlayers(room) {
  return room.players.filter((player) => !player.isEliminated);
}

function allDrawPilesEmpty(room) {
  return TILE_COLORS.every((color) => room.drawPiles[color].length === 0);
}

function resetTurn(room) {
  room.turn = {
    drawnTile: null,
    drawnTileInsertIndex: null,
    lastGuessCorrect: false,
  };
}

function startGameForRoom(
  room,
  deckFactory = () => shuffle(createDeck()),
  setupDurationMs = SETUP_DURATION_MS,
) {
  assertGame(
    room.status === ROOM_STATUS.LOBBY,
    "INVALID_ROOM_STATE",
    "The game has already started.",
  );
  assertGame(
    room.players.length >= MIN_PLAYERS && room.players.length <= MAX_PLAYERS,
    "INVALID_PLAYER_COUNT",
    "The game requires two to four players.",
  );
  assertGame(
    room.players.every((player) => player.isReady),
    "PLAYERS_NOT_READY",
    "Every player must be ready.",
  );
  assertGame(
    room.players.every((player) => player.isConnected),
    "PLAYER_DISCONNECTED",
    "Every player must be connected before the game starts.",
  );

  const deck = deckFactory();
  assertGame(
    Array.isArray(deck) &&
      deck.length === 26 &&
      new Set(deck.map((tile) => tile.id)).size === 26,
    "INVALID_DECK",
    "The deck must contain 26 uniquely identified tiles.",
  );
  const cardsPerPlayer = room.players.length === 4 ? 3 : 4;

  for (const player of room.players) {
    player.hand = [];
    player.latestDrawnTileId = null;
    player.isEliminated = false;
    player.needsDashSetup = false;
    player.hasSetupDash = false;
  }

  // Round-robin dealing avoids giving one seat a contiguous block from the deck.
  for (let round = 0; round < cardsPerPlayer; round += 1) {
    for (const player of room.players) {
      player.hand.push(deck.pop());
    }
  }

  for (const player of room.players) {
    player.hand = sortInitialHand(player.hand);
    player.needsDashSetup = player.hand.some((tile) => tile.value === DASH);
    player.hasSetupDash = false;
  }

  room.drawPiles.black = shuffle(
    deck.filter((tile) => tile.color === "black"),
  );
  room.drawPiles.white = shuffle(
    deck.filter((tile) => tile.color === "white"),
  );
  room.currentTurnIndex = 0;
  room.lastTurnPlayerId = null;
  room.winnerPlayerId = null;
  resetTurn(room);

  room.status = ROOM_STATUS.SETUP_DASH;
  room.turnPhase = null;
  room.setupEndsAt = Date.now() + Math.max(0, setupDurationMs);
  addLog(room, "初始手牌已发放，全员正在秘密准备。");
}

function confirmDashForPlayer(room, player, handOrder) {
  assertGame(
    room.status === ROOM_STATUS.SETUP_DASH,
    "INVALID_ROOM_STATE",
    "The room is not in the initial Dash setup phase.",
  );
  assertGame(
    !player.hasSetupDash,
    "DASH_ALREADY_CONFIRMED",
    "Dash placement has already been confirmed.",
  );
  assertGame(
    Array.isArray(handOrder) && handOrder.length === player.hand.length,
    "INVALID_HAND_ORDER",
    "handOrder must contain every tile exactly once.",
  );

  const currentIds = new Set(player.hand.map((tile) => tile.id));
  const submittedIds = new Set(handOrder);
  assertGame(
    submittedIds.size === player.hand.length &&
      handOrder.every((tileId) => typeof tileId === "string" && currentIds.has(tileId)),
    "INVALID_HAND_ORDER",
    "handOrder must be an exact permutation of the current hand.",
  );

  const tileById = new Map(player.hand.map((tile) => [tile.id, tile]));
  const reorderedHand = handOrder.map((tileId) => tileById.get(tileId));
  const submittedNumericIds = reorderedHand
    .filter((tile) => tile.value !== DASH)
    .map((tile) => tile.id);
  const sortedNumericIds = [...player.hand]
    .filter((tile) => tile.value !== DASH)
    .sort(compareNumericTiles)
    .map((tile) => tile.id);

  assertGame(
    submittedNumericIds.every((tileId, index) => tileId === sortedNumericIds[index]),
    "INVALID_NUMERIC_ORDER",
    "Numeric tiles must remain ascending, with black before white for equal values.",
  );

  player.hand = reorderedHand;
  player.hasSetupDash = true;
}

function finishInitialSetup(room) {
  assertGame(
    room.status === ROOM_STATUS.SETUP_DASH,
    "INVALID_ROOM_STATE",
    "The room is not in the initial setup phase.",
  );
  for (const player of room.players) {
    if (!player.hasSetupDash && player.needsDashSetup) {
      player.hand = randomizeDashPositions(player.hand);
    }
    player.hasSetupDash = true;
  }
  room.status = ROOM_STATUS.PLAYING;
  room.turnPhase = TURN_PHASE.DRAW;
  room.setupEndsAt = null;
  addLog(
    room,
    `秘密准备结束，${currentPlayer(room).nickname} 开始第一回合。`,
  );
}

function resetRoomForRematch(room) {
  assertGame(
    room.status === ROOM_STATUS.FINISHED,
    "INVALID_ROOM_STATE",
    "只能在对局结束后再来一局。",
  );
  room.players = room.players.filter((player) => player.isConnected);
  assertGame(
    room.players.length > 0,
    "NO_CONNECTED_PLAYERS",
    "房间内没有在线玩家。",
  );
  if (!room.players.some((player) => player.isHost)) {
    room.players[0].isHost = true;
  }
  for (const player of room.players) {
    player.isReady = false;
    player.isEliminated = false;
    player.needsDashSetup = false;
    player.hasSetupDash = true;
    player.hand = [];
    player.latestDrawnTileId = null;
  }
  room.status = ROOM_STATUS.LOBBY;
  room.drawPiles = { black: [], white: [] };
  room.currentTurnIndex = null;
  room.lastTurnPlayerId = null;
  room.turnPhase = null;
  room.setupEndsAt = null;
  room.winnerPlayerId = null;
  room.logs = [];
  resetTurn(room);
  room.updatedAt = Date.now();
}

function ensureCurrentActor(room, player) {
  assertGame(
    room.status === ROOM_STATUS.PLAYING,
    "INVALID_ROOM_STATE",
    "The game is not currently playing.",
  );
  assertGame(
    currentPlayer(room)?.id === player.id,
    "NOT_YOUR_TURN",
    "It is not your turn.",
  );
  assertGame(
    !player.isEliminated,
    "PLAYER_ELIMINATED",
    "An eliminated player cannot act.",
  );
}

function drawForPlayer(room, player, color) {
  ensureCurrentActor(room, player);
  assertGame(
    room.turnPhase === TURN_PHASE.DRAW,
    "INVALID_TURN_PHASE",
    "A tile cannot be drawn in the current phase.",
  );
  assertGame(
    TILE_COLORS.includes(color),
    "INVALID_TILE_COLOR",
    "Draw color must be black or white.",
  );

  const pile = room.drawPiles[color];
  assertGame(pile.length > 0, "DRAW_PILE_EMPTY", `The ${color} pile is empty.`);

  const drawnTile = pile.pop();
  drawnTile.isRevealed = false;
  room.turn.drawnTile = drawnTile;
  room.turn.drawnTileInsertIndex = null;
  room.turn.lastGuessCorrect = false;
  room.turnPhase =
    drawnTile.value === DASH ? TURN_PHASE.PLACE_DASH : TURN_PHASE.GUESS;

  // The value is intentionally omitted from this public log.
  addLog(room, `${player.nickname} 摸了一张${color === "black" ? "黑牌" : "白牌"}。`);
}

function placeDrawnDashForPlayer(room, player, insertIndex) {
  ensureCurrentActor(room, player);
  assertGame(
    room.turnPhase === TURN_PHASE.PLACE_DASH,
    "INVALID_TURN_PHASE",
    "There is no drawn Dash tile waiting to be placed.",
  );
  assertGame(
    room.turn.drawnTile?.value === DASH,
    "NO_DRAWN_DASH",
    "The current drawn tile is not a Dash.",
  );
  assertGame(
    Number.isInteger(insertIndex) &&
      insertIndex >= 0 &&
      insertIndex <= player.hand.length,
    "INVALID_INSERT_INDEX",
    "insertIndex is outside the hand.",
  );

  room.turn.drawnTileInsertIndex = insertIndex;
  room.turnPhase = TURN_PHASE.GUESS;
  room.updatedAt = Date.now();
}

function normalizeGuessValue(value) {
  if (value === DASH) {
    return DASH;
  }
  assertGame(
    Number.isInteger(value) && value >= 0 && value <= 11,
    "INVALID_GUESS_VALUE",
    "Guess value must be an integer from 0 to 11 or '-'.",
  );
  return value;
}

function resolveTargetTile(target, { tileId, tileIndex }) {
  if (typeof tileId === "string") {
    return target.hand.find((tile) => tile.id === tileId) || null;
  }
  if (Number.isInteger(tileIndex) && tileIndex >= 0) {
    return target.hand[tileIndex] || null;
  }
  return null;
}

function refreshElimination(player) {
  player.isEliminated =
    player.hand.length > 0 && player.hand.every((tile) => tile.isRevealed);
}

function finishIfWon(room) {
  const survivors = activePlayers(room);
  if (survivors.length > 1) {
    return false;
  }
  room.status = ROOM_STATUS.FINISHED;
  room.turnPhase = null;
  room.setupEndsAt = null;
  room.winnerPlayerId = survivors[0]?.id || null;
  resetTurn(room);
  addLog(
    room,
    survivors[0]
      ? `${survivors[0].nickname} 获得胜利！`
      : "本局没有获胜玩家。",
  );
  return true;
}

function finalizeDrawnTile(room, player, { reveal }) {
  const finalizedTile = room.turn.drawnTile;
  if (finalizedTile) {
    finalizedTile.isRevealed = reveal;
    if (finalizedTile.value === DASH) {
      assertGame(
        Number.isInteger(room.turn.drawnTileInsertIndex),
        "DASH_NOT_PLACED",
        "A drawn Dash must be placed before it can be finalized.",
      );
      player.hand.splice(room.turn.drawnTileInsertIndex, 0, finalizedTile);
    } else {
      insertNumericTile(player.hand, finalizedTile);
    }
    player.latestDrawnTileId = finalizedTile.id;
  }

  resetTurn(room);
  return finalizedTile;
}

function advanceTurn(room) {
  if (finishIfWon(room)) {
    return;
  }

  const completedPlayer = currentPlayer(room);
  const playerCount = room.players.length;
  for (let offset = 1; offset <= playerCount; offset += 1) {
    const candidateIndex = (room.currentTurnIndex + offset) % playerCount;
    if (!room.players[candidateIndex].isEliminated) {
      room.lastTurnPlayerId = completedPlayer.id;
      room.currentTurnIndex = candidateIndex;
      resetTurn(room);
      room.turnPhase = allDrawPilesEmpty(room)
        ? TURN_PHASE.GUESS
        : TURN_PHASE.DRAW;
      addLog(
        room,
        `${completedPlayer.nickname} 的回合结束，轮到 ${room.players[candidateIndex].nickname}。`,
      );
      return;
    }
  }
}

function forfeitGameForPlayer(room, player) {
  assertGame(
    room.status === ROOM_STATUS.SETUP_DASH ||
      room.status === ROOM_STATUS.PLAYING,
    "INVALID_ROOM_STATE",
    "只能在游戏进行中退出。",
  );

  const statusAtForfeit = room.status;
  const wasCurrentPlayer = currentPlayer(room)?.id === player.id;
  const wasAlreadyEliminated = player.isEliminated;

  if (
    !wasAlreadyEliminated &&
    statusAtForfeit === ROOM_STATUS.PLAYING &&
    wasCurrentPlayer &&
    room.turn.drawnTile
  ) {
    const pendingTile = room.turn.drawnTile;
    pendingTile.isRevealed = true;
    if (pendingTile.value === DASH) {
      const insertIndex = Number.isInteger(room.turn.drawnTileInsertIndex)
        ? room.turn.drawnTileInsertIndex
        : player.hand.length;
      player.hand.splice(insertIndex, 0, pendingTile);
    } else {
      insertNumericTile(player.hand, pendingTile);
    }
    player.latestDrawnTileId = pendingTile.id;
  }

  if (wasCurrentPlayer) {
    resetTurn(room);
  }
  for (const tile of player.hand) {
    tile.isRevealed = true;
  }
  player.isEliminated = true;
  player.isConnected = false;
  player.needsDashSetup = false;
  player.hasSetupDash = true;
  addLog(
    room,
    wasAlreadyEliminated
      ? `${player.nickname} 退出了观战。`
      : `${player.nickname} 退出游戏，视为弃权。`,
  );

  const gameFinished = finishIfWon(room);
  if (gameFinished || wasAlreadyEliminated || !wasCurrentPlayer) {
    return { gameFinished };
  }

  if (statusAtForfeit === ROOM_STATUS.SETUP_DASH) {
    for (let offset = 1; offset <= room.players.length; offset += 1) {
      const candidateIndex =
        (room.currentTurnIndex + offset) % room.players.length;
      if (!room.players[candidateIndex].isEliminated) {
        room.currentTurnIndex = candidateIndex;
        break;
      }
    }
  } else {
    advanceTurn(room);
  }
  return { gameFinished: false };
}

function guessForPlayer(room, player, payload) {
  ensureCurrentActor(room, player);
  assertGame(
    room.turnPhase === TURN_PHASE.GUESS ||
      room.turnPhase === TURN_PHASE.DECIDE,
    "INVALID_TURN_PHASE",
    "A guess cannot be made in the current phase.",
  );

  const targetPlayerId = payload.targetPlayerId;
  const target = room.players.find((candidate) => candidate.id === targetPlayerId);
  assertGame(target, "TARGET_NOT_FOUND", "Target player does not exist.");
  assertGame(target.id !== player.id, "CANNOT_GUESS_SELF", "You cannot guess your own tile.");
  assertGame(
    !target.isEliminated,
    "TARGET_ELIMINATED",
    "An eliminated player cannot be targeted.",
  );

  const targetTile = resolveTargetTile(target, payload);
  assertGame(targetTile, "TILE_NOT_FOUND", "Target tile does not exist.");
  assertGame(!targetTile.isRevealed, "TILE_ALREADY_REVEALED", "That tile is already revealed.");

  const guessValue = normalizeGuessValue(payload.value);
  const targetTileIndex = target.hand.findIndex((tile) => tile.id === targetTile.id);
  const isCorrect = targetTile.value === guessValue;
  const guessLabel = guessValue === DASH ? "百搭牌（—）" : String(guessValue);

  addLog(
    room,
    `${player.nickname} 猜测 ${target.nickname} 的第 ${targetTileIndex + 1} 张牌是 ${guessLabel}：${
      isCorrect ? "猜对" : "猜错"
    }。`,
  );

  if (isCorrect) {
    targetTile.isRevealed = true;
    refreshElimination(target);
    room.turn.lastGuessCorrect = true;
    const gameFinished = finishIfWon(room);
    if (!gameFinished) {
      room.turnPhase = TURN_PHASE.DECIDE;
    }
    return { correct: true, gameFinished };
  }

  const revealedDrawnTile = finalizeDrawnTile(room, player, { reveal: true });
  if (revealedDrawnTile) {
    addLog(
      room,
      `${player.nickname} 本回合摸到的牌已公开：${
        revealedDrawnTile.value === DASH ? "百搭牌（—）" : revealedDrawnTile.value
      }。`,
    );
  }
  refreshElimination(player);
  const gameFinished = finishIfWon(room);
  if (!gameFinished) {
    advanceTurn(room);
  }
  return { correct: false, gameFinished };
}

function continueGuessingForPlayer(room, player) {
  ensureCurrentActor(room, player);
  assertGame(
    room.turnPhase === TURN_PHASE.DECIDE && room.turn.lastGuessCorrect,
    "INVALID_TURN_PHASE",
    "Continue guessing is only available after a correct guess.",
  );
  room.turnPhase = TURN_PHASE.GUESS;
}

function endTurnForPlayer(room, player) {
  ensureCurrentActor(room, player);
  assertGame(
    room.turnPhase === TURN_PHASE.DECIDE && room.turn.lastGuessCorrect,
    "INVALID_TURN_PHASE",
    "The turn can only end voluntarily after a correct guess.",
  );
  finalizeDrawnTile(room, player, { reveal: false });
  advanceTurn(room);
}

function serializeTileForOwner(tile, room, ownerPlayer) {
  return {
    id: tile.id,
    color: tile.color,
    value: tile.value,
    isRevealed: tile.isRevealed,
    isDrawnThisTurn: room.turn.drawnTile?.id === tile.id,
    isLatestDrawn: ownerPlayer.latestDrawnTileId === tile.id,
  };
}

function serializeTileForOpponent(tile, ownerPlayer) {
  const publicTile = {
    id: tile.id,
    color: tile.color,
    isRevealed: tile.isRevealed,
    isLatestDrawn: ownerPlayer.latestDrawnTileId === tile.id,
  };
  if (tile.isRevealed) {
    publicTile.value = tile.value;
  }
  return publicTile;
}

function shouldMaskEntireHand(room, targetPlayer, viewerPlayer) {
  return (
    room.status === ROOM_STATUS.SETUP_DASH &&
    targetPlayer.id !== viewerPlayer.id
  );
}

function serializePlayerForViewer(room, targetPlayer, viewerPlayer) {
  const isSelf = targetPlayer.id === viewerPlayer.id;
  const handHidden = shouldMaskEntireHand(room, targetPlayer, viewerPlayer);
  const serialized = {
    id: targetPlayer.id,
    nickname: targetPlayer.nickname,
    avatarId: targetPlayer.avatarId,
    isHost: targetPlayer.isHost,
    isConnected: targetPlayer.isConnected,
    isEliminated: targetPlayer.isEliminated,
    isCurrentTurn:
      room.status !== ROOM_STATUS.SETUP_DASH &&
      currentPlayer(room)?.id === targetPlayer.id,
    isSelf,
    handHidden,
  };

  // null is deliberate: unlike an array of card backs, it leaks no hand count.
  if (handHidden) {
    serialized.hand = null;
  } else if (isSelf) {
    const ownerHand = [...targetPlayer.hand];
    const isPendingDashOwner =
      currentPlayer(room)?.id === targetPlayer.id &&
      room.turn.drawnTile?.value === DASH &&
      Number.isInteger(room.turn.drawnTileInsertIndex);
    if (isPendingDashOwner) {
      ownerHand.splice(
        room.turn.drawnTileInsertIndex,
        0,
        room.turn.drawnTile,
      );
    }
    serialized.hand = ownerHand.map((tile) =>
      serializeTileForOwner(tile, room, targetPlayer),
    );
  } else {
    serialized.hand = targetPlayer.hand.map((tile) =>
      serializeTileForOpponent(tile, targetPlayer),
    );
  }

  return serialized;
}

function serializeTurnDrawForViewer(room, viewerPlayer) {
  const actor = currentPlayer(room);
  if (!actor) {
    return null;
  }

  const tile = room.turn.drawnTile;
  if (!tile) {
    return null;
  }

  if (actor.id === viewerPlayer.id) {
    const isPlaced = Number.isInteger(room.turn.drawnTileInsertIndex);
    if (isPlaced) {
      return null;
    }
    return {
      ...serializeTileForOwner(tile, room, actor),
      isPlaced: false,
    };
  }

  // A pending draw is completely private until the actor's turn ends. This hides
  // its value, color, Dash identity, insertion position, and temporary hand count.
  return null;
}

function serializeRoomState(room) {
  const publicPhase =
    room.turnPhase === TURN_PHASE.PLACE_DASH
      ? TURN_PHASE.GUESS
      : room.turnPhase;
  return {
    roomCode: room.roomCode,
    status: room.status,
    phase:
      room.status === ROOM_STATUS.SETUP_DASH
        ? ROOM_STATUS.SETUP_DASH
        : publicPhase,
    players: room.players.map((player, seatIndex) => ({
      id: player.id,
      seatIndex,
      nickname: player.nickname,
      avatarId: player.avatarId,
      isHost: player.isHost,
      isReady: player.isReady,
      isConnected: player.isConnected,
    })),
  };
}

function serializeGameState(room, viewerPlayer) {
  const actor = currentPlayer(room);
  const viewerPhase =
    room.turnPhase === TURN_PHASE.PLACE_DASH && actor?.id !== viewerPlayer.id
      ? TURN_PHASE.GUESS
      : room.turnPhase;
  return {
    roomCode: room.roomCode,
    status: room.status,
    phase:
      room.status === ROOM_STATUS.SETUP_DASH
        ? ROOM_STATUS.SETUP_DASH
        : viewerPhase,
    selfPlayerId: viewerPlayer.id,
    currentTurnPlayerId:
      room.status === ROOM_STATUS.SETUP_DASH ? null : actor?.id || null,
    lastTurnPlayerId: room.lastTurnPlayerId,
    winnerPlayerId: room.winnerPlayerId,
    setupEndsAt: room.setupEndsAt,
    drawPileCounts: {
      black: room.drawPiles.black.length,
      white: room.drawPiles.white.length,
    },
    players: room.players.map((player) =>
      serializePlayerForViewer(room, player, viewerPlayer),
    ),
    turnDraw: serializeTurnDrawForViewer(room, viewerPlayer),
    canAct: {
      confirmDash:
        room.status === ROOM_STATUS.SETUP_DASH &&
        !viewerPlayer.hasSetupDash,
      draw:
        room.status === ROOM_STATUS.PLAYING &&
        actor?.id === viewerPlayer.id &&
        room.turnPhase === TURN_PHASE.DRAW,
      placeDash:
        room.status === ROOM_STATUS.PLAYING &&
        actor?.id === viewerPlayer.id &&
        room.turnPhase === TURN_PHASE.PLACE_DASH,
      guess:
        room.status === ROOM_STATUS.PLAYING &&
        actor?.id === viewerPlayer.id &&
        (room.turnPhase === TURN_PHASE.GUESS ||
          room.turnPhase === TURN_PHASE.DECIDE),
      continueGuessing:
        room.status === ROOM_STATUS.PLAYING &&
        actor?.id === viewerPlayer.id &&
        room.turnPhase === TURN_PHASE.DECIDE,
      endTurn:
        room.status === ROOM_STATUS.PLAYING &&
        actor?.id === viewerPlayer.id &&
        room.turnPhase === TURN_PHASE.DECIDE,
    },
    logs: room.logs,
  };
}

function createGameServer(options = {}) {
  // Kept inside the factory so core rules can be unit-tested without installed
  // transport dependencies.
  const express = options.express || require("express");
  const SocketIOServer =
    options.SocketIOServer || require("socket.io").Server;
  const rooms = options.rooms || new Map();
  const setupDurationMs = Number.isFinite(options.setupDurationMs)
    ? Math.max(0, options.setupDurationMs)
    : SETUP_DURATION_MS;
  const setupTimers = new Map();
  const app = express();
  const httpServer = http.createServer(app);
  const configuredOrigins =
    options.corsOrigins ||
    (process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(",").map((origin) => origin.trim())
      : "*");

  app.use(express.json({ limit: "32kb" }));
  app.use((request, response, next) => {
    const requestOrigin = request.headers.origin;
    const originAllowed =
      configuredOrigins === "*" ||
      (Array.isArray(configuredOrigins) &&
        configuredOrigins.includes(requestOrigin));
    if (originAllowed) {
      response.setHeader(
        "Access-Control-Allow-Origin",
        configuredOrigins === "*" ? "*" : requestOrigin,
      );
      response.setHeader("Vary", "Origin");
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Bypass-Tunnel-Reminder",
      );
      response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    }
    if (request.method === "OPTIONS") {
      response.sendStatus(originAllowed ? 204 : 403);
      return;
    }
    next();
  });

  app.get("/", (_request, response) => {
    response.json({
      name: "Coda game server",
      ok: true,
    });
  });
  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      rooms: rooms.size,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: configuredOrigins,
      methods: ["GET", "POST"],
      allowedHeaders: ["Bypass-Tunnel-Reminder", "Content-Type"],
    },
    ...options.ioOptions,
  });

  function emitAllStates(room) {
    const roomState = serializeRoomState(room);
    for (const player of room.players) {
      if (!player.socketId) {
        continue;
      }
      const playerSocket = io.sockets.sockets.get(player.socketId);
      if (!playerSocket) {
        continue;
      }
      playerSocket.emit("room_state", roomState);
      if (room.status !== ROOM_STATUS.LOBBY) {
        playerSocket.emit("game_state", serializeGameState(room, player));
      }
    }
  }

  function scheduleInitialSetupEnd(room) {
    const existingTimer = setupTimers.get(room.roomCode);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const delay = Math.max(0, room.setupEndsAt - Date.now());
    const timer = setTimeout(() => {
      setupTimers.delete(room.roomCode);
      if (
        rooms.get(room.roomCode) !== room ||
        room.status !== ROOM_STATUS.SETUP_DASH
      ) {
        return;
      }
      finishInitialSetup(room);
      emitAllStates(room);
    }, delay);
    setupTimers.set(room.roomCode, timer);
  }

  function assertUnattached(socket) {
    assertGame(
      !socket.data.roomCode,
      "ALREADY_IN_ROOM",
      "This socket is already attached to a room.",
    );
  }

  async function attachSocket(socket, room, player) {
    if (player.socketId && player.socketId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(player.socketId);
      if (previousSocket) {
        previousSocket.data.roomCode = null;
        previousSocket.data.playerId = null;
        previousSocket.emit("session_replaced");
        await previousSocket.leave(room.roomCode);
      }
    }

    player.socketId = socket.id;
    player.isConnected = true;
    socket.data.roomCode = room.roomCode;
    socket.data.playerId = player.id;
    await socket.join(room.roomCode);
    room.updatedAt = Date.now();
  }

  function actorContext(socket) {
    const room = rooms.get(socket.data.roomCode);
    assertGame(room, "ROOM_NOT_FOUND", "The attached room no longer exists.");
    const player = room.players.find(
      (candidate) =>
        candidate.id === socket.data.playerId && candidate.socketId === socket.id,
    );
    assertGame(player, "SESSION_NOT_FOUND", "The player session is not attached.");
    return { room, player };
  }

  function registerEvent(socket, eventName, handler) {
    socket.on(eventName, async (incomingPayload, incomingAck) => {
      let payload = incomingPayload;
      let acknowledge = incomingAck;
      if (typeof incomingPayload === "function") {
        acknowledge = incomingPayload;
        payload = {};
      }

      try {
        const result = await handler(asObject(payload));
        if (typeof acknowledge === "function") {
          acknowledge({ ok: true, ...(result || {}) });
        }
      } catch (error) {
        const isExpected = error instanceof GameError;
        const errorPayload = {
          event: eventName,
          code: isExpected ? error.code : "INTERNAL_ERROR",
          message: isExpected ? error.message : "Unexpected server error.",
        };
        if (!isExpected) {
          console.error(`[${eventName}]`, error);
        }
        socket.emit("action_error", errorPayload);
        if (typeof acknowledge === "function") {
          acknowledge({ ok: false, error: errorPayload });
        }
      }
    });
  }

  io.on("connection", (socket) => {
    socket.data.roomCode = null;
    socket.data.playerId = null;

    registerEvent(socket, "create_room", async (payload) => {
      assertUnattached(socket);
      const nickname = normalizeNickname(payload.nickname);
      const avatarId = normalizeAvatarId(payload.avatarId);
      const playerToken = normalizePlayerToken(payload.playerToken, {
        allowGenerate: true,
      });
      const roomCode = generateRoomCode(rooms);
      const player = createPlayer({
        nickname,
        avatarId,
        playerToken,
        socketId: socket.id,
        isHost: true,
      });
      const room = createRoom({ roomCode, player });
      rooms.set(roomCode, room);
      await attachSocket(socket, room, player);
      emitAllStates(room);
      return {
        roomCode,
        playerId: player.id,
        playerToken,
      };
    });

    registerEvent(socket, "join_room", async (payload) => {
      assertUnattached(socket);
      const roomCode = normalizeRoomCode(payload.roomCode);
      const room = rooms.get(roomCode);
      assertGame(room, "ROOM_NOT_FOUND", "Room does not exist.");
      const playerToken = normalizePlayerToken(payload.playerToken, {
        allowGenerate: true,
      });
      const existingPlayer = room.players.find(
        (candidate) => candidate.playerToken === playerToken,
      );

      if (existingPlayer) {
        if (room.status === ROOM_STATUS.LOBBY && payload.nickname !== undefined) {
          existingPlayer.nickname = normalizeNickname(payload.nickname);
        }
        await attachSocket(socket, room, existingPlayer);
        emitAllStates(room);
        return {
          roomCode,
          playerId: existingPlayer.id,
          playerToken,
          rejoined: true,
        };
      }

      assertGame(
        room.status === ROOM_STATUS.LOBBY,
        "GAME_ALREADY_STARTED",
        "New players cannot join after the game starts.",
      );
      assertGame(
        room.players.length < MAX_PLAYERS,
        "ROOM_FULL",
        "The room is full.",
      );

      const avatarId = normalizeAvatarId(payload.avatarId);
      assertGame(
        !room.players.some((candidate) => candidate.avatarId === avatarId),
        "AVATAR_TAKEN",
        "这个头像已被房间内的其他玩家使用，请选择另一个头像。",
      );
      const player = createPlayer({
        nickname: normalizeNickname(payload.nickname),
        avatarId,
        playerToken,
        socketId: socket.id,
        isHost: false,
      });
      room.players.push(player);
      await attachSocket(socket, room, player);
      emitAllStates(room);
      return {
        roomCode,
        playerId: player.id,
        playerToken,
        rejoined: false,
      };
    });

    registerEvent(socket, "rejoin_room", async (payload) => {
      assertUnattached(socket);
      const roomCode = normalizeRoomCode(payload.roomCode);
      const playerToken = normalizePlayerToken(payload.playerToken);
      const room = rooms.get(roomCode);
      assertGame(room, "ROOM_NOT_FOUND", "Room does not exist.");
      const player = room.players.find(
        (candidate) => candidate.playerToken === playerToken,
      );
      assertGame(
        player,
        "REJOIN_FAILED",
        "This player token does not belong to the room.",
      );
      if (room.status === ROOM_STATUS.LOBBY && payload.nickname !== undefined) {
        player.nickname = normalizeNickname(payload.nickname);
      }
      await attachSocket(socket, room, player);
      emitAllStates(room);
      return {
        roomCode,
        playerId: player.id,
        playerToken,
      };
    });

    registerEvent(socket, "set_ready", (payload) => {
      const { room, player } = actorContext(socket);
      assertGame(
        room.status === ROOM_STATUS.LOBBY,
        "INVALID_ROOM_STATE",
        "Ready state can only change in the lobby.",
      );
      assertGame(
        typeof payload.isReady === "boolean",
        "INVALID_READY_STATE",
        "isReady must be a boolean.",
      );
      player.isReady = payload.isReady;
      emitAllStates(room);
    });

    registerEvent(socket, "refresh_room", () => {
      const { room } = actorContext(socket);
      assertGame(
        room.status === ROOM_STATUS.LOBBY,
        "INVALID_ROOM_STATE",
        "只能在等待房间刷新座位。",
      );
      emitAllStates(room);
      return { refreshedAt: Date.now() };
    });

    registerEvent(socket, "kick_player", async (payload) => {
      const { room, player } = actorContext(socket);
      assertGame(
        room.status === ROOM_STATUS.LOBBY,
        "INVALID_ROOM_STATE",
        "只能在等待房间移出玩家。",
      );
      assertGame(player.isHost, "HOST_ONLY", "只有房主可以移出玩家。");
      const target = room.players.find(
        (candidate) => candidate.id === payload.playerId,
      );
      assertGame(target, "PLAYER_NOT_FOUND", "该玩家已不在房间内。");
      assertGame(target.id !== player.id, "CANNOT_KICK_SELF", "房主不能移出自己。");

      const targetSocket = target.socketId
        ? io.sockets.sockets.get(target.socketId)
        : null;
      if (targetSocket) {
        targetSocket.data.roomCode = null;
        targetSocket.data.playerId = null;
        targetSocket.emit("kicked_from_room", {
          message: "你已被房主移出房间。",
        });
        await targetSocket.leave(room.roomCode);
      }
      room.players = room.players.filter(
        (candidate) => candidate.id !== target.id,
      );
      room.updatedAt = Date.now();
      emitAllStates(room);
      return { playerId: target.id };
    });

    registerEvent(socket, "leave_room", async () => {
      const { room, player } = actorContext(socket);
      assertGame(
        room.status === ROOM_STATUS.LOBBY,
        "GAME_ALREADY_STARTED",
        "The room can only be left before the game starts.",
      );

      room.players = room.players.filter((candidate) => candidate.id !== player.id);
      socket.data.roomCode = null;
      socket.data.playerId = null;
      await socket.leave(room.roomCode);

      if (room.players.length === 0) {
        rooms.delete(room.roomCode);
      } else {
        if (player.isHost) {
          room.players.forEach((candidate, index) => {
            candidate.isHost = index === 0;
          });
        }
        room.updatedAt = Date.now();
        emitAllStates(room);
      }
      return { roomCode: room.roomCode };
    });

    registerEvent(socket, "leave_game", async () => {
      const { room, player } = actorContext(socket);
      const result = forfeitGameForPlayer(room, player);
      player.socketId = null;
      socket.data.roomCode = null;
      socket.data.playerId = null;
      await socket.leave(room.roomCode);
      emitAllStates(room);
      return {
        roomCode: room.roomCode,
        ...result,
      };
    });

    registerEvent(socket, "return_to_home", async () => {
      const { room, player } = actorContext(socket);
      assertGame(
        room.status === ROOM_STATUS.FINISHED,
        "INVALID_ROOM_STATE",
        "只能在对局结束后回到大厅。",
      );
      player.socketId = null;
      player.isConnected = false;
      socket.data.roomCode = null;
      socket.data.playerId = null;
      await socket.leave(room.roomCode);

      if (room.players.every((candidate) => !candidate.isConnected)) {
        rooms.delete(room.roomCode);
      } else {
        room.updatedAt = Date.now();
        emitAllStates(room);
      }
      return { roomCode: room.roomCode };
    });

    registerEvent(socket, "play_again", () => {
      const { room } = actorContext(socket);
      resetRoomForRematch(room);
      emitAllStates(room);
      return { roomCode: room.roomCode };
    });

    registerEvent(socket, "start_game", () => {
      const { room, player } = actorContext(socket);
      assertGame(player.isHost, "HOST_ONLY", "Only the host can start the game.");
      startGameForRoom(room, options.deckFactory, setupDurationMs);
      emitAllStates(room);
      scheduleInitialSetupEnd(room);
    });

    registerEvent(socket, "confirm_dash_position", (payload) => {
      const { room, player } = actorContext(socket);
      confirmDashForPlayer(room, player, payload.handOrder);
      emitAllStates(room);
    });

    registerEvent(socket, "draw_tile", (payload) => {
      const { room, player } = actorContext(socket);
      drawForPlayer(room, player, payload.color);
      emitAllStates(room);
    });

    registerEvent(socket, "place_drawn_dash", (payload) => {
      const { room, player } = actorContext(socket);
      placeDrawnDashForPlayer(room, player, payload.insertIndex);
      emitAllStates(room);
    });

    registerEvent(socket, "guess_tile", (payload) => {
      const { room, player } = actorContext(socket);
      const result = guessForPlayer(room, player, payload);
      emitAllStates(room);
      return result;
    });

    registerEvent(socket, "continue_guess", () => {
      const { room, player } = actorContext(socket);
      continueGuessingForPlayer(room, player);
      emitAllStates(room);
    });

    registerEvent(socket, "end_turn", () => {
      const { room, player } = actorContext(socket);
      endTurnForPlayer(room, player);
      emitAllStates(room);
    });

    socket.on("disconnect", () => {
      const room = rooms.get(socket.data.roomCode);
      if (!room) {
        return;
      }
      const player = room.players.find(
        (candidate) =>
          candidate.id === socket.data.playerId &&
          candidate.socketId === socket.id,
      );
      if (!player) {
        return;
      }
      player.socketId = null;
      player.isConnected = false;
      room.updatedAt = Date.now();
      emitAllStates(room);
    });
  });

  return {
    app,
    httpServer,
    io,
    rooms,
    start(port = Number(process.env.PORT) || 3000) {
      return new Promise((resolve) => {
        httpServer.listen(port, "0.0.0.0", () =>
          resolve(httpServer.address()),
        );
      });
    },
    stop() {
      for (const timer of setupTimers.values()) {
        clearTimeout(timer);
      }
      setupTimers.clear();
      return new Promise((resolve, reject) => {
        io.close(() => {
          if (!httpServer.listening) {
            resolve();
            return;
          }
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      });
    },
  };
}

if (require.main === module) {
  const gameServer = createGameServer();
  gameServer.start().then((address) => {
    const port = typeof address === "object" && address ? address.port : address;
    console.log(`Coda server listening on http://localhost:${port}`);
  });
}

module.exports = {
  createGameServer,
  ROOM_STATUS,
  TURN_PHASE,
  DASH,
  GameError,
  // Exported for focused rule tests; transport code should use createGameServer().
  _internals: {
    createDeck,
    createPlayer,
    createRoom,
    sortInitialHand,
    randomizeDashPositions,
    insertNumericTile,
    startGameForRoom,
    confirmDashForPlayer,
    finishInitialSetup,
    forfeitGameForPlayer,
    drawForPlayer,
    placeDrawnDashForPlayer,
    guessForPlayer,
    continueGuessingForPlayer,
    endTurnForPlayer,
    serializeGameState,
  },
};
