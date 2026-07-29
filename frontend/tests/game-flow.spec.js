"use strict";

const { mkdirSync } = require("node:fs");
const { test, expect } = require("@playwright/test");

test("two browser identities can arrange Dash, play, and refresh-rejoin", async ({
  browser,
}) => {
  const firstContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
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
  await expect(firstPage.getByText("房主", { exact: true })).toHaveCSS(
    "white-space",
    "nowrap",
  );
  mkdirSync("artifacts", { recursive: true });
  await firstPage.screenshot({
    path: "artifacts/coda-room-mobile.png",
    fullPage: true,
  });
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
  await expect(firstPage.locator(".guess-option")).toHaveCount(13);
  await expect(
    firstPage.locator('[data-action="submit-guess"][data-value="-"]'),
  ).toHaveCSS(
    "background-color",
    await firstPage
      .locator('[data-action="submit-guess"][data-value="0"]')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  );
  await firstPage.screenshot({
    path: "artifacts/coda-guess-mobile.png",
    fullPage: true,
  });
  await firstPage
    .locator('[data-action="submit-guess"][data-value="-"]')
    .click();

  await expect(firstPage.getByRole("heading", { name: "猜错了" })).toBeVisible();
  await expect(firstPage.locator('[data-feedback-kind="wrong"] p')).toHaveCount(
    0,
  );
  await expect(firstPage.locator(".tile-revealed").first()).toContainText(
    "【公开】",
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

  await expect(firstPage.getByText(/你的手牌/)).toBeVisible();
  await expect(firstPage.getByText("已连接", { exact: true })).toHaveCount(0);
  const opponentBox = await firstPage.locator(".opponent-zone").boundingBox();
  expect(opponentBox.width).toBeGreaterThanOrEqual(360);
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
    await Promise.all([
      expect(
        secondPage.getByRole("heading", { name: "猜对了" }),
      ).toBeVisible(),
      expect(
        firstPage.getByRole("heading", { name: "被猜中了！" }),
      ).toBeVisible(),
      expect(firstPage.locator(".tile-hit-flash")).toHaveCount(1),
    ]);
    if (value === "0") {
      const handRowBox = await firstPage
        .locator(".player-hand-row")
        .last()
        .boundingBox();
      const flashingTileBox = await firstPage
        .locator(".tile-hit-flash")
        .boundingBox();
      expect(flashingTileBox.x - handRowBox.x).toBeGreaterThanOrEqual(4);
      await firstPage.screenshot({
        path: "artifacts/coda-hit-mobile.png",
        fullPage: true,
      });
    }
    await expect(
      secondPage.getByRole("heading", { name: "猜对了" }),
    ).toBeHidden({ timeout: 2_000 });
    await expect(
      firstPage.getByRole("heading", { name: "被猜中了！" }),
    ).toBeHidden({ timeout: 2_000 });
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

test("three-player phone layout shows both opponents without horizontal clipping", async ({
  browser,
}) => {
  const contexts = await Promise.all(
    Array.from({ length: 3 }, () =>
      browser.newContext({ viewport: { width: 390, height: 844 } }),
    ),
  );
  const [host, second, third] = await Promise.all(
    contexts.map((context) => context.newPage()),
  );
  const backendQuery = encodeURIComponent("http://127.0.0.1:3100");

  try {
    await host.goto(`/?server=${backendQuery}`);
    await host.locator("#nickname").fill("房主甲");
    await host.locator('[data-avatar-id="avatar-03"]').click();
    await expect(
      host.getByRole("button", { name: "创建新房间" }),
    ).toBeEnabled();
    await host.getByRole("button", { name: "创建新房间" }).click();
    await host.waitForURL(/room=\d{4}/);
    const roomCode = new URL(host.url()).searchParams.get("room");

    for (const [page, nickname, avatarId] of [
      [second, "玩家乙", "avatar-04"],
      [third, "玩家丙", "avatar-05"],
    ]) {
      await page.goto(
        `/?server=${backendQuery}&room=${encodeURIComponent(roomCode)}`,
      );
      await page.locator("#nickname").fill(nickname);
      await page.locator(`[data-avatar-id="${avatarId}"]`).click();
      await expect(page.getByRole("button", { name: "加入" })).toBeEnabled();
      await page.getByRole("button", { name: "加入" }).click();
    }

    await expect(host.getByText("玩家乙", { exact: true })).toBeVisible();
    await expect(host.getByText("玩家丙", { exact: true })).toBeVisible();
    for (const page of [host, second, third]) {
      await page.getByRole("button", { name: "我准备好了" }).click();
    }
    await expect(
      host.getByRole("button", { name: "开始游戏" }),
    ).toBeEnabled();
    await host.getByRole("button", { name: "开始游戏" }).click();
    await expect(host.getByText("请摸一张牌", { exact: true })).toBeVisible({
      timeout: 5_000,
    });

    await expect(host.locator(".opponent-zone")).toHaveCount(2);
    const layout = await host.evaluate(() => {
      const rect = (selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
        };
      };
      return {
        viewportWidth: window.innerWidth,
        pageWidth: document.documentElement.scrollWidth,
        opponents: [...document.querySelectorAll(".opponent-zone")].map(
          (element) => {
            const box = element.getBoundingClientRect();
            return {
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              width: box.width,
            };
          },
        ),
        turn: rect(".turn-control-panel"),
        self: rect(".self-hand-panel"),
      };
    });
    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.opponents).toHaveLength(2);
    for (const opponent of layout.opponents) {
      expect(opponent.left).toBeGreaterThanOrEqual(11);
      expect(opponent.right).toBeLessThanOrEqual(layout.viewportWidth - 11);
      expect(opponent.width).toBeGreaterThanOrEqual(360);
    }
    expect(layout.opponents[1].top).toBeGreaterThanOrEqual(
      layout.opponents[0].bottom + 11,
    );
    for (const panel of [layout.turn, layout.self]) {
      expect(panel.left).toBeGreaterThanOrEqual(11);
      expect(panel.right).toBeLessThanOrEqual(layout.viewportWidth - 11);
    }

    mkdirSync("artifacts", { recursive: true });
    await host.screenshot({
      path: "artifacts/coda-three-player-mobile.png",
      fullPage: true,
    });

    await host.getByRole("button", { name: /摸黑牌/ }).click();
    await host.waitForFunction(
      () =>
        document.querySelector('[data-action="place-dash"]') ||
        document.querySelector('[data-action="open-guess"]'),
    );
    const dashPlacement = host.locator('[data-action="place-dash"]');
    if (await dashPlacement.count()) {
      await dashPlacement.first().click();
    }
    await host.locator('[data-action="open-guess"]').first().click();
    await expect(host.locator(".guess-option")).toHaveCount(13);
    const modalLayout = await host
      .locator('[aria-labelledby="guess-title"]')
      .evaluate((element) => {
        const box = element.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        };
      });
    expect(modalLayout.left).toBeGreaterThanOrEqual(0);
    expect(modalLayout.right).toBeLessThanOrEqual(modalLayout.viewportWidth);
    expect(modalLayout.top).toBeGreaterThanOrEqual(0);
    expect(modalLayout.bottom).toBeLessThanOrEqual(modalLayout.viewportHeight);
    await host.screenshot({
      path: "artifacts/coda-three-player-guess-mobile.png",
      fullPage: true,
    });
    await host.locator('[data-action="close-guess"]').click();
    await expect(
      host.getByRole("button", { name: "退出游戏", exact: true }),
    ).toBeVisible();
    await host.getByRole("button", { name: "退出游戏", exact: true }).click();
    await expect(
      host.getByRole("heading", {
        name: "游戏正在进行，是否确认退出？",
      }),
    ).toBeVisible();
    await host.screenshot({
      path: "artifacts/coda-leave-game-mobile.png",
      fullPage: true,
    });
    await host.getByRole("button", { name: "取消", exact: true }).click();
    await expect(host.getByText(/你的手牌/)).toBeVisible();

    await host.getByRole("button", { name: "退出游戏", exact: true }).click();
    await host.getByRole("button", { name: "确认退出", exact: true }).click();
    await expect(
      host.getByRole("button", { name: "创建新房间" }),
    ).toBeVisible();
    await expect(host.locator("#nickname")).toHaveValue("房主甲");
    await expect(host.locator('[data-avatar-id="avatar-03"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(host).not.toHaveURL(/room=\d{4}/);
    expect(
      await host.evaluate(() =>
        window.localStorage.getItem("coda.roomCode"),
      ),
    ).toBeNull();
    await expect(
      second.getByText("轮到你的回合", { exact: true }),
    ).toBeVisible();
    await expect(second.getByText("已淘汰", { exact: true })).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("lobby stays usable at a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const backendQuery = encodeURIComponent("http://127.0.0.1:3100");
  await page.goto(`/?server=${backendQuery}`);

  await expect(page.getByText("已连接", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "创建新房间" })).toBeVisible();
  await expect(page.locator("#nickname")).toBeVisible();
  await expect(page.locator('[data-action="select-avatar"]')).toHaveCount(8);
  await expect(page.getByPlaceholder("请输入房间号")).toBeVisible();
  await expect(page.getByText("无需登录")).toHaveCount(0);
  await expect(page.getByText(/黑白 0–11/)).toHaveCount(0);
  await expect(page.getByText(/当前后端/)).toHaveCount(0);
  await expect(page.getByText("看见颜色，")).toBeVisible();
  await expect(page.getByText("猜出密码。")).toBeVisible();
  await expect(page.getByText("经典推理桌游")).toBeHidden();
  await expect(page.getByText(/牌面越沉默/)).toBeHidden();
  await expect(page.getByText(/两种颜色，一套顺序/)).toBeVisible();

  const viewportMetrics = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    pageWidth: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight,
    joinButtonBottom: Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent.trim() === "加入")
      ?.getBoundingClientRect().bottom,
  }));
  expect(viewportMetrics.pageWidth).toBeLessThanOrEqual(
    viewportMetrics.viewportWidth,
  );
  expect(viewportMetrics.pageHeight).toBeLessThanOrEqual(
    viewportMetrics.viewportHeight,
  );
  expect(viewportMetrics.joinButtonBottom).toBeLessThanOrEqual(
    viewportMetrics.viewportHeight,
  );

  mkdirSync("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/coda-lobby-mobile.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  const desktopSpacing = await page.evaluate(() => {
    const sections = document.querySelectorAll("main section");
    const top = Math.min(
      ...Array.from(sections, (section) => section.getBoundingClientRect().top),
    );
    const bottom = Math.max(
      ...Array.from(
        sections,
        (section) => section.getBoundingClientRect().bottom,
      ),
    );
    return {
      top,
      bottom: window.innerHeight - bottom,
    };
  });
  expect(Math.abs(desktopSpacing.top - desktopSpacing.bottom)).toBeLessThanOrEqual(
    1,
  );
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByRole("button", { name: "创建新房间" }).click();
  await expect(page).toHaveURL(/room=\d{4}/);
  await expect(page.getByText("PRIVATE TABLE")).toHaveCount(0);
  await expect(page.getByText(/还需要 1 位玩家/)).toBeVisible();
  await page.getByRole("button", { name: "退出房间" }).click();
  await expect(page.getByRole("button", { name: "创建新房间" })).toBeVisible();
  await expect(page).not.toHaveURL(/room=\d{4}/);
});
