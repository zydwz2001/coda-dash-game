"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { io: createSocketClient } = require("socket.io-client");

const {
  createGameServer,
  ROOM_STATUS,
  TURN_PHASE,
  DASH,
  _internals,
} = require("./server");

function createDeterministicDeck() {
  const deck = _internals.createDeck();
  const take = (color, value) => {
    const index = deck.findIndex(
      (tile) => tile.color === color && tile.value === value,
    );
    assert.notEqual(index, -1, `missing ${color} ${value}`);
    return deck.splice(index, 1)[0];
  };

  // The server deals by pop() in this sequence:
  // P1, P2, P1, P2, P1, P2, P1, P2.
  const popOrder = [
    take("black", DASH),
    take("white", 0),
    take("black", 0),
    take("black", 2),
    take("white", 2),
    take("white", 3),
    take("black", 4),
    take("black", 5),
  ];
  return [...deck, ...popOrder.reverse()];
}

function connectClient(url) {
  return new Promise((resolve, reject) => {
    const socket = createSocketClient(url, {
      forceNew: true,
      reconnection: false,
      transports: ["websocket"],
      extraHeaders: {
        "Bypass-Tunnel-Reminder": "true",
      },
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Socket connection timed out."));
    }, 2_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function observeStates(socket) {
  const observed = {
    room: null,
    game: null,
    errors: [],
  };
  socket.on("room_state", (state) => {
    observed.room = state;
  });
  socket.on("game_state", (state) => {
    observed.game = state;
  });
  socket.on("action_error", (error) => {
    observed.errors.push(error);
  });
  return observed;
}

function emitAck(socket, eventName, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${eventName} acknowledgement timed out.`)),
      2_000,
    );
    socket.emit(eventName, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function ownPlayer(state) {
  return state.players.find((player) => player.id === state.selfPlayerId);
}

test("timed-out Dash tiles are randomly inserted without changing numeric order", () => {
  const hand = [
    { id: "black-1", color: "black", value: 1 },
    { id: "white-3", color: "white", value: 3 },
    { id: "dash", color: "black", value: DASH },
    { id: "black-5", color: "black", value: 5 },
  ];
  const arranged = _internals.randomizeDashPositions(hand, () => 1);
  assert.deepEqual(
    arranged.map((tile) => tile.id),
    ["black-1", "dash", "white-3", "black-5"],
  );
});

test("two-player Socket.IO flow preserves identity and hides face-down values", async (t) => {
  const gameServer = createGameServer({
    deckFactory: createDeterministicDeck,
    setupDurationMs: 500,
  });
  const address = await gameServer.start(0);
  const url = `http://127.0.0.1:${address.port}`;
  const clients = [];

  t.after(async () => {
    for (const client of clients) {
      client.disconnect();
    }
    await gameServer.stop();
  });

  const firstSocket = await connectClient(url);
  clients.push(firstSocket);
  let firstObserved = observeStates(firstSocket);

  const firstToken = "player_one_token_000000000000";
  const secondToken = "player_two_token_00000000000";
  const created = await emitAck(firstSocket, "create_room", {
    nickname: "Ada",
    avatarId: "avatar-01",
    playerToken: firstToken,
  });
  assert.equal(created.ok, true);
  assert.match(created.roomCode, /^\d{4}$/);

  const secondSocket = await connectClient(url);
  clients.push(secondSocket);
  const secondObserved = observeStates(secondSocket);
  const joined = await emitAck(secondSocket, "join_room", {
    roomCode: created.roomCode,
    nickname: "Turing",
    avatarId: "avatar-02",
    playerToken: secondToken,
  });
  assert.equal(joined.ok, true);
  assert.deepEqual(
    firstObserved.room.players.map((player) => player.avatarId),
    ["avatar-01", "avatar-02"],
  );

  assert.equal(
    (await emitAck(firstSocket, "set_ready", { isReady: true })).ok,
    true,
  );
  assert.equal(
    (await emitAck(secondSocket, "set_ready", { isReady: true })).ok,
    true,
  );
  assert.equal((await emitAck(firstSocket, "start_game")).ok, true);
  await waitFor(
    () =>
      firstObserved.game?.status === ROOM_STATUS.SETUP_DASH &&
      secondObserved.game?.status === ROOM_STATUS.SETUP_DASH,
    "Both clients did not receive the SETUP_DASH state.",
  );

  assert.equal(firstObserved.game.status, ROOM_STATUS.SETUP_DASH);
  assert.equal(ownPlayer(firstObserved.game).hand.some((tile) => tile.value === DASH), true);

  const firstPlayerFromSecondView = secondObserved.game.players.find(
    (player) => player.id === created.playerId,
  );
  assert.equal(firstPlayerFromSecondView.handHidden, true);
  assert.equal(firstPlayerFromSecondView.hand, null);
  const secondPlayerFromFirstSetupView = firstObserved.game.players.find(
    (player) => player.id === joined.playerId,
  );
  assert.equal(secondPlayerFromFirstSetupView.handHidden, true);
  assert.equal(secondPlayerFromFirstSetupView.hand, null);
  assert.equal(secondObserved.game.canAct.confirmDash, true);
  assert.equal(JSON.stringify(secondObserved.game).includes(firstToken), false);
  assert.equal(JSON.stringify(secondObserved.game).includes(secondToken), false);

  const initialOwnHand = ownPlayer(firstObserved.game).hand;
  const initialDash = initialOwnHand.find((tile) => tile.value === DASH);
  const numericTiles = initialOwnHand.filter((tile) => tile.value !== DASH);
  const confirmedOrder = [
    numericTiles[0].id,
    initialDash.id,
    ...numericTiles.slice(1).map((tile) => tile.id),
  ];
  assert.equal(
    (
      await emitAck(firstSocket, "confirm_dash_position", {
        handOrder: confirmedOrder,
      })
    ).ok,
    true,
  );
  await waitFor(
    () =>
      firstObserved.game?.status === ROOM_STATUS.PLAYING &&
      firstObserved.game?.phase === TURN_PHASE.DRAW,
    "The fixed secret setup window did not end.",
  );

  const handBeforeRefresh = ownPlayer(firstObserved.game).hand.map(
    (tile) => tile.id,
  );
  firstSocket.disconnect();
  await waitFor(
    () =>
      secondObserved.room?.players.find(
        (player) => player.id === created.playerId,
      )?.isConnected === false,
    "The disconnect was not reflected in room_state.",
  );

  const replacementSocket = await connectClient(url);
  clients.push(replacementSocket);
  firstObserved = observeStates(replacementSocket);
  const rejoined = await emitAck(replacementSocket, "rejoin_room", {
    roomCode: created.roomCode,
    playerToken: firstToken,
    nickname: "Ada",
  });
  assert.equal(rejoined.ok, true);
  assert.equal(rejoined.playerId, created.playerId);
  assert.deepEqual(
    ownPlayer(firstObserved.game).hand.map((tile) => tile.id),
    handBeforeRefresh,
  );

  const room = gameServer.rooms.get(created.roomCode);
  let drawnDash = null;
  let drawnDashColor = null;
  for (const color of ["black", "white"]) {
    const dashIndex = room.drawPiles[color].findIndex(
      (tile) => tile.value === DASH,
    );
    if (dashIndex !== -1) {
      drawnDash = room.drawPiles[color].splice(dashIndex, 1)[0];
      room.drawPiles[color].push(drawnDash);
      drawnDashColor = color;
      break;
    }
  }
  assert(drawnDash);

  assert.equal(
    (
      await emitAck(replacementSocket, "draw_tile", {
        color: drawnDashColor,
      })
    ).ok,
    true,
  );
  await waitFor(
    () => secondObserved.game?.phase === "WAITING_FOR_PLAYER",
    "The opponent did not receive the private Dash waiting phase.",
  );
  assert.equal(firstObserved.game.phase, TURN_PHASE.PLACE_DASH);
  assert.equal(firstObserved.game.turnDraw.value, DASH);
  assert.equal(secondObserved.game.phase, "WAITING_FOR_PLAYER");
  assert.equal("value" in secondObserved.game.turnDraw, false);

  assert.equal(
    (
      await emitAck(replacementSocket, "place_drawn_dash", {
        insertIndex: 0,
      })
    ).ok,
    true,
  );
  await waitFor(
    () =>
      secondObserved.game?.phase === TURN_PHASE.GUESS &&
      secondObserved.game?.turnDraw === null,
    "The opponent did not receive the placed tile state.",
  );
  assert.equal(firstObserved.game.phase, TURN_PHASE.GUESS);
  assert.equal(secondObserved.game.turnDraw, null);
  const placedFirstPlayer = secondObserved.game.players.find(
    (player) => player.id === created.playerId,
  );
  assert.equal(
    placedFirstPlayer.hand
      .filter((tile) => !tile.isRevealed)
      .every((tile) => !Object.hasOwn(tile, "value")),
    true,
  );

  const secondPlayerFromFirstView = firstObserved.game.players.find(
    (player) => player.id === joined.playerId,
  );
  const targetTileId = secondPlayerFromFirstView.hand.find(
    (tile) => !tile.isRevealed,
  ).id;
  const actualTargetTile = room.players
    .find((player) => player.id === joined.playerId)
    .hand.find((tile) => tile.id === targetTileId);
  const wrongValue =
    actualTargetTile.value === DASH || actualTargetTile.value === 0 ? 1 : 0;
  const wrongGuess = await emitAck(replacementSocket, "guess_tile", {
    targetPlayerId: joined.playerId,
    tileId: targetTileId,
    value: wrongValue,
  });
  assert.equal(wrongGuess.ok, true);
  assert.equal(wrongGuess.correct, false);
  await waitFor(
    () => secondObserved.game?.currentTurnPlayerId === joined.playerId,
    "The next turn did not reach the second player.",
  );
  assert.equal(secondObserved.game.currentTurnPlayerId, joined.playerId);
  const revealedDrawnDash = secondObserved.game.players
    .find((player) => player.id === created.playerId)
    .hand.find((tile) => tile.id === drawnDash.id);
  assert.equal(revealedDrawnDash.isRevealed, true);
  assert.equal(revealedDrawnDash.value, DASH);

  const availableColor = room.drawPiles.black.length ? "black" : "white";
  assert.equal(
    (
      await emitAck(secondSocket, "draw_tile", {
        color: availableColor,
      })
    ).ok,
    true,
  );
  const secondDrawnTileId = secondObserved.game.turnDraw.id;
  const hiddenFirstTile = room.players
    .find((player) => player.id === created.playerId)
    .hand.find((tile) => !tile.isRevealed);
  const correctGuess = await emitAck(secondSocket, "guess_tile", {
    targetPlayerId: created.playerId,
    tileId: hiddenFirstTile.id,
    value: hiddenFirstTile.value,
  });
  assert.equal(correctGuess.ok, true);
  assert.equal(correctGuess.correct, true);
  assert.equal(secondObserved.game.phase, TURN_PHASE.DECIDE);
  assert.equal((await emitAck(secondSocket, "end_turn")).ok, true);
  assert.equal(
    ownPlayer(secondObserved.game).hand.find(
      (tile) => tile.id === secondDrawnTileId,
    ).isRevealed,
    false,
  );

  const intruderSocket = await connectClient(url);
  clients.push(intruderSocket);
  const invalidRoomCode = await emitAck(intruderSocket, "join_room", {
    roomCode: "ABCD",
    nickname: "Intruder",
    playerToken: "intruder_token_0000000000000",
  });
  assert.equal(invalidRoomCode.ok, false);
  assert.equal(invalidRoomCode.error.code, "INVALID_ROOM_CODE");

  const rejected = await emitAck(intruderSocket, "rejoin_room", {
    roomCode: created.roomCode,
    playerToken: "incorrect_token_000000000000",
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "REJOIN_FAILED");
});

test("leaving a lobby removes the seat and transfers host control", async (t) => {
  const gameServer = createGameServer();
  const address = await gameServer.start(0);
  const url = `http://127.0.0.1:${address.port}`;
  const firstSocket = await connectClient(url);
  const secondSocket = await connectClient(url);

  t.after(async () => {
    firstSocket.disconnect();
    secondSocket.disconnect();
    await gameServer.stop();
  });

  const created = await emitAck(firstSocket, "create_room", {
    nickname: "Host",
    avatarId: "avatar-01",
    playerToken: "leaving_host_token_0000000000",
  });
  const secondObserved = observeStates(secondSocket);
  const duplicateAvatar = await emitAck(secondSocket, "join_room", {
    roomCode: created.roomCode,
    nickname: "Guest",
    avatarId: "avatar-01",
    playerToken: "remaining_guest_token_0000000",
  });
  assert.equal(duplicateAvatar.ok, false);
  assert.equal(duplicateAvatar.error.code, "AVATAR_TAKEN");

  const joined = await emitAck(secondSocket, "join_room", {
    roomCode: created.roomCode,
    nickname: "Guest",
    avatarId: "avatar-02",
    playerToken: "remaining_guest_token_0000000",
  });
  assert.equal(joined.ok, true);

  const left = await emitAck(firstSocket, "leave_room");
  assert.equal(left.ok, true);
  await waitFor(
    () =>
      secondObserved.room?.players.length === 1 &&
      secondObserved.room.players[0].id === joined.playerId &&
      secondObserved.room.players[0].isHost,
    "The remaining player did not become host.",
  );

  const replacementRoom = await emitAck(firstSocket, "create_room", {
    nickname: "Host Again",
    avatarId: "avatar-03",
    playerToken: "leaving_host_token_0000000000",
  });
  assert.equal(replacementRoom.ok, true);
  assert.match(replacementRoom.roomCode, /^\d{4}$/);
});

test("host can refresh seats and kick another lobby player", async (t) => {
  const gameServer = createGameServer();
  const address = await gameServer.start(0);
  const url = `http://127.0.0.1:${address.port}`;
  const hostSocket = await connectClient(url);
  const guestSocket = await connectClient(url);

  t.after(async () => {
    hostSocket.disconnect();
    guestSocket.disconnect();
    await gameServer.stop();
  });

  const hostObserved = observeStates(hostSocket);
  const created = await emitAck(hostSocket, "create_room", {
    nickname: "Host",
    avatarId: "avatar-01",
    playerToken: "kick_host_token_000000000000",
  });
  const joined = await emitAck(guestSocket, "join_room", {
    roomCode: created.roomCode,
    nickname: "Guest",
    avatarId: "avatar-02",
    playerToken: "kick_guest_token_00000000000",
  });
  assert.equal(joined.ok, true);

  const refreshed = await emitAck(hostSocket, "refresh_room");
  assert.equal(refreshed.ok, true);
  assert.equal(hostObserved.room.players.length, 2);

  const kickedEvent = new Promise((resolve) => {
    guestSocket.once("kicked_from_room", resolve);
  });
  const kicked = await emitAck(hostSocket, "kick_player", {
    playerId: joined.playerId,
  });
  assert.equal(kicked.ok, true);
  assert.equal((await kickedEvent).message, "你已被房主移出房间。");
  assert.equal(hostObserved.room.players.length, 1);

  const guestRoom = await emitAck(guestSocket, "create_room", {
    nickname: "Guest",
    avatarId: "avatar-02",
    playerToken: "kick_guest_token_00000000000",
  });
  assert.equal(guestRoom.ok, true);
});

test("finished players can rematch or return home without losing profiles", async (t) => {
  const gameServer = createGameServer();
  const address = await gameServer.start(0);
  const url = `http://127.0.0.1:${address.port}`;
  const firstSocket = await connectClient(url);
  const secondSocket = await connectClient(url);

  t.after(async () => {
    firstSocket.disconnect();
    secondSocket.disconnect();
    await gameServer.stop();
  });

  const firstObserved = observeStates(firstSocket);
  const created = await emitAck(firstSocket, "create_room", {
    nickname: "Ada",
    avatarId: "avatar-01",
    playerToken: "rematch_ada_token_00000000000",
  });
  const joined = await emitAck(secondSocket, "join_room", {
    roomCode: created.roomCode,
    nickname: "Turing",
    avatarId: "avatar-02",
    playerToken: "rematch_turing_token_0000000",
  });
  assert.equal(joined.ok, true);

  const room = gameServer.rooms.get(created.roomCode);
  room.status = ROOM_STATUS.FINISHED;
  room.winnerPlayerId = created.playerId;
  room.players.forEach((player) => {
    player.isReady = true;
    player.hand = [{ id: `${player.id}-tile`, color: "black", value: 1 }];
  });

  const rematch = await emitAck(firstSocket, "play_again");
  assert.equal(rematch.ok, true);
  assert.equal(room.status, ROOM_STATUS.LOBBY);
  assert.equal(room.players.every((player) => !player.isReady), true);
  assert.equal(room.players.every((player) => player.hand.length === 0), true);
  assert.deepEqual(
    room.players.map(({ nickname, avatarId }) => ({ nickname, avatarId })),
    [
      { nickname: "Ada", avatarId: "avatar-01" },
      { nickname: "Turing", avatarId: "avatar-02" },
    ],
  );

  room.status = ROOM_STATUS.FINISHED;
  room.winnerPlayerId = created.playerId;
  const returned = await emitAck(secondSocket, "return_to_home");
  assert.equal(returned.ok, true);
  await waitFor(
    () =>
      firstObserved.room?.players.find(
        (player) => player.id === joined.playerId,
      )?.isConnected === false,
    "Returning home did not update the remaining player.",
  );

  const newRoom = await emitAck(secondSocket, "create_room", {
    nickname: "Turing",
    avatarId: "avatar-02",
    playerToken: "rematch_turing_token_0000000",
  });
  assert.equal(newRoom.ok, true);
});
