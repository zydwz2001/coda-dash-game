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
  await firstPage
    .locator('[data-action="select-avatar"][data-avatar-id="avatar-01"]')
    .click();
  await expect(
    firstPage.getByRole("button", { name: "创建新房间" }),
  ).toBeEnabled();
  await firstPage.getByRole("button", { name: "创建新房间" }).click();
  await expect(firstPage).toHaveURL(/room=\d{4}/);

  const firstUrl = new URL(firstPage.url());
  const roomCode = firstUrl.searchParams.get("room");
  expect(roomCode).toMatch(/^\d{4}$/);

  await secondPage.goto(
    `/?server=${backendQuery}&room=${encodeURIComponent(roomCode)}`,
  );
  await secondPage.locator("#nickname").fill("Turing");
  await secondPage
    .locator('[data-action="select-avatar"][data-avatar-id="avatar-02"]')
    .click();
  await expect(secondPage.getByRole("button", { name: "加入" })).toBeEnabled();
  await secondPage.getByRole("button", { name: "加入" }).click();

  await expect(firstPage.getByText("Turing")).toBeVisible();
  await expect(
    firstPage.getByText(/还需要 \d+ 位玩家或等待其他人/),
  ).toHaveCount(0);
  await expect(
    secondPage.getByText(/还需要 \d+ 位玩家或等待其他人/),
  ).toHaveCount(0);
  await firstPage.getByRole("button", { name: "刷新座位" }).click();
  await expect(firstPage.getByText("房间座位已刷新。")).toBeVisible();
  await firstPage.getByRole("button", { name: "移出" }).click();
  await expect(
    firstPage.getByRole("heading", { name: "确认移出 Turing？" }),
  ).toBeVisible();
  await firstPage.getByRole("button", { name: "取消" }).click();
  await firstPage.getByRole("button", { name: "我准备好了" }).click();
  await secondPage.getByRole("button", { name: "我准备好了" }).click();
  await expect(
    firstPage.getByRole("button", { name: "开始游戏" }),
  ).toBeEnabled();
  await firstPage.getByRole("button", { name: "开始游戏" }).click();

  await expect(
    firstPage.getByRole("heading", { name: "全员秘密准备" }),
  ).toBeVisible();
  await expect(
    firstPage.getByText(/倒计时结束仍未提交，服务端将随机摆放/),
  ).toBeVisible();
  await expect(firstPage.locator(".tile-hidden")).toHaveCount(0);
  await expect(secondPage.locator(".tile-hidden")).toHaveCount(0);
  await expect(secondPage.getByText(/确认你的初始手牌/)).toBeVisible();
  await expect(
    secondPage.locator('[data-action="open-guess"]'),
  ).toHaveCount(0);
  await expect(firstPage.locator(".tile-relation").first()).toHaveText("<");

  const chooseSecondPosition = firstPage.locator(
    '[data-action="set-setup-dash-position"][data-index="1"]',
  );
  await expect(chooseSecondPosition).toBeEnabled();
  await chooseSecondPosition.click();
  await firstPage.getByRole("button", { name: "完成摆放" }).click();

  await expect(
    firstPage.getByRole("button", { name: /摸黑牌/ }),
  ).toBeVisible();
  await expect(firstPage.getByText("请摸一张牌")).toBeVisible();
  await expect(firstPage.getByText("剩余张数")).toHaveCount(2);
  mkdirSync("artifacts", { recursive: true });
  await firstPage.screenshot({
    path: "artifacts/coda-draw-piles.png",
    fullPage: true,
  });
  await firstPage.getByRole("button", { name: /摸黑牌/ }).click();
  await expect(
    firstPage.getByText("请选择对手的任意一张牌进行猜牌"),
  ).toBeVisible();
  await expect(firstPage.locator(".tile-hidden").first()).toContainText("?");
  expect(await firstPage.locator(".tile-relation").count()).toBeGreaterThan(0);

  await firstPage.locator('[data-action="open-guess"]').first().click();
  await expect(
    firstPage.getByRole("heading", { name: "这张牌是什么？" }),
  ).toBeVisible();
  await firstPage
    .locator('[data-action="submit-guess"][data-value="-"]')
    .click();

  await expect(firstPage.getByRole("heading", { name: "猜错了！" })).toBeVisible();
  await expect(firstPage.locator(".tile-revealed").first()).toContainText(
    "（已公开）",
  );
  await expect(secondPage.getByText("轮到你的回合", { exact: true })).toBeVisible();
  await expect(secondPage.getByText("上一回合：Ada 已结束")).toBeVisible();
  await expect(
    secondPage.getByText(/Ada的回合结束 · 轮到你/),
  ).toBeVisible();
  await expect(
    secondPage.getByRole("complementary").getByText(/本回合摸到的牌已公开/),
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

  await firstPage.setViewportSize({ width: 390, height: 844 });
  await expect(firstPage.getByText(/你的手牌/)).toBeVisible();
  await expect(firstPage.getByRole("button", { name: "已连接" })).toBeVisible();
  const viewportMetrics = await firstPage.evaluate(() => ({
    viewportWidth: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(viewportMetrics.pageWidth).toBeLessThanOrEqual(
    viewportMetrics.viewportWidth,
  );
  await firstPage.screenshot({
    path: "artifacts/coda-game-mobile.png",
    fullPage: true,
  });

  await secondPage.getByRole("button", { name: /摸黑牌/ }).click();
  for (const value of ["0", "-", "2", "4"]) {
    await secondPage.locator('[data-action="open-guess"]').first().click();
    await secondPage
      .locator(`[data-action="submit-guess"][data-value="${value}"]`)
      .click();
    await expect(
      secondPage.getByRole("heading", { name: "猜对了！" }),
    ).toBeVisible();
    await expect(
      secondPage.getByRole("heading", { name: "猜对了！" }),
    ).toBeHidden({ timeout: 3_000 });
    if (value !== "4") {
      await expect(
        secondPage.getByRole("button", { name: "跳过回合" }),
      ).toBeVisible();
      await expect(
        secondPage.getByRole("button", { name: "继续猜牌" }),
      ).toHaveCount(0);
    }
  }

  await expect(
    secondPage.getByRole("heading", { name: "Turing 获得胜利！" }),
  ).toBeVisible();
  await expect(secondPage.getByRole("button", { name: "再来一局" })).toBeVisible();
  await expect(secondPage.getByRole("button", { name: "回到大厅" })).toBeVisible();
  await secondPage.getByRole("button", { name: "再来一局" }).click();
  await expect(firstPage.getByText("等待玩家")).toBeVisible();
  await expect(secondPage.getByText("等待玩家")).toBeVisible();
  await expect(
    firstPage.getByRole("button", { name: "我准备好了" }),
  ).toBeVisible();
  await expect(
    secondPage.getByRole("button", { name: "我准备好了" }),
  ).toBeVisible();

  expect(browserErrors).toEqual([]);
  await firstContext.close();
  await secondContext.close();
});

test("lobby stays usable at a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const backendQuery = encodeURIComponent("http://127.0.0.1:3100");
  await page.goto(`/?server=${backendQuery}`);

  await expect(page.getByRole("button", { name: "已连接" })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建新房间" })).toBeVisible();
  await expect(page.locator("#nickname")).toBeVisible();
  await expect(page.locator('[data-action="select-avatar"]')).toHaveCount(8);
  await expect(page.getByPlaceholder("请输入房间号")).toBeVisible();
  await expect(page.getByText("无需登录")).toHaveCount(0);
  await expect(page.getByText(/黑白 0–11/)).toHaveCount(0);
  await expect(page.getByText(/当前后端/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "已连接" })).toHaveAttribute(
    "title",
    "打开连接设置",
  );

  const viewportMetrics = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(viewportMetrics.pageWidth).toBeLessThanOrEqual(
    viewportMetrics.viewportWidth,
  );

  mkdirSync("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/coda-lobby-mobile.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "创建新房间" }).click();
  await expect(page).toHaveURL(/room=\d{4}/);
  await expect(page.getByText("PRIVATE TABLE")).toHaveCount(0);
  await expect(page.getByText(/还需要 1 位玩家/)).toBeVisible();
  await page.getByRole("button", { name: "退出房间" }).click();
  await expect(page.getByRole("button", { name: "创建新房间" })).toBeVisible();
  await expect(page).not.toHaveURL(/room=\d{4}/);
});
