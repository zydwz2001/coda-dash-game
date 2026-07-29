"use strict";

const { mkdirSync } = require("node:fs");
const { test, expect } = require("@playwright/test");

test("two browser identities can arrange Dash, play, and refresh-rejoin", async ({
  browser,
}) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();
  const browserErrors = [];

  for (const page of [firstPage, secondPage]) {
    page.on("pageerror", (error) => browserErrors.push(error.message));
  }

  const backendQuery = encodeURIComponent("http://127.0.0.1:3100");
  await firstPage.goto(`/?server=${backendQuery}`);
  await firstPage.locator("#nickname").fill("Ada");
  await expect(
    firstPage.getByRole("button", { name: "创建新房间" }),
  ).toBeEnabled();
  await firstPage.getByRole("button", { name: "创建新房间" }).click();
  await expect(firstPage).toHaveURL(/room=[A-Z0-9]{4}/);

  const firstUrl = new URL(firstPage.url());
  const roomCode = firstUrl.searchParams.get("room");
  expect(roomCode).toMatch(/^[A-Z0-9]{4}$/);

  await secondPage.goto(
    `/?server=${backendQuery}&room=${encodeURIComponent(roomCode)}`,
  );
  await secondPage.locator("#nickname").fill("Turing");
  await expect(secondPage.getByRole("button", { name: "加入" })).toBeEnabled();
  await secondPage.getByRole("button", { name: "加入" }).click();

  await expect(firstPage.getByText("Turing")).toBeVisible();
  await firstPage.getByRole("button", { name: "我准备好了" }).click();
  await secondPage.getByRole("button", { name: "我准备好了" }).click();
  await expect(
    firstPage.getByRole("button", { name: "开始游戏" }),
  ).toBeEnabled();
  await firstPage.getByRole("button", { name: "开始游戏" }).click();

  await expect(
    firstPage.getByRole("heading", { name: "安排你的伪装牌" }),
  ).toBeVisible();
  await expect(secondPage.getByText(/颜色与张数已隐藏/)).toBeVisible();
  await expect(
    secondPage.locator('[data-action="open-guess"]'),
  ).toHaveCount(0);

  const moveDashLeft = firstPage.locator(
    '[data-action="move-dash"][data-direction="-1"]',
  );
  await expect(moveDashLeft).toBeEnabled();
  await moveDashLeft.click();
  await firstPage.getByRole("button", { name: "确认牌序" }).click();

  await expect(
    firstPage.getByRole("button", { name: /摸黑牌/ }),
  ).toBeVisible();
  await firstPage.getByRole("button", { name: /摸黑牌/ }).click();
  await expect(
    firstPage.getByText(/点击任意对手未翻开的牌/),
  ).toBeVisible();

  await firstPage.locator('[data-action="open-guess"]').first().click();
  await expect(
    firstPage.getByRole("heading", { name: "这张牌是什么？" }),
  ).toBeVisible();
  await firstPage
    .locator('[data-action="submit-guess"][data-value="-"]')
    .click();

  await expect(firstPage.getByText("猜错了，本回合结束。")).toBeVisible();
  await expect(secondPage.getByText("YOUR TURN")).toBeVisible();
  await expect(
    secondPage.getByText(/drawn tile was revealed as/),
  ).toBeVisible();

  const tokenBeforeRefresh = await firstPage.evaluate(() =>
    window.localStorage.getItem("coda.playerToken"),
  );
  await firstPage.reload();
  await expect(firstPage.getByText("已恢复原房间和座位。")).toBeVisible();
  await expect(firstPage).toHaveURL(new RegExp(`room=${roomCode}`));
  await expect(firstPage.getByText(/你的手牌/)).toBeVisible();
  const tokenAfterRefresh = await firstPage.evaluate(() =>
    window.localStorage.getItem("coda.playerToken"),
  );
  expect(tokenAfterRefresh).toBe(tokenBeforeRefresh);

  mkdirSync("artifacts", { recursive: true });
  await firstPage.screenshot({
    path: "artifacts/coda-game-after-rejoin.png",
    fullPage: true,
  });

  expect(browserErrors).toEqual([]);
  await firstContext.close();
  await secondContext.close();
});

