"use strict";

const {
  createGameServer,
  DASH,
  _internals,
} = require("./server");

function createDeterministicDeck() {
  const deck = _internals.createDeck();
  const take = (color, value) => {
    const index = deck.findIndex(
      (tile) => tile.color === color && tile.value === value,
    );
    if (index === -1) {
      throw new Error(`Missing test tile: ${color} ${value}`);
    }
    return deck.splice(index, 1)[0];
  };
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

const port = Number(process.env.E2E_BACKEND_PORT) || 3100;
const server = createGameServer({
  deckFactory: createDeterministicDeck,
  setupDurationMs: 1_500,
});

server.start(port).then(() => {
  console.log(`Deterministic E2E backend listening on ${port}`);
});

async function shutdown() {
  await server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
