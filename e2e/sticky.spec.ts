import { expect, type Page, test } from "@playwright/test";

const STICKY_PORT = process.env.PICO_E2E_STICKY_PORT ?? "4145";
const STICKY_URL =
  process.env.PICO_E2E_STICKY_URL ?? `http://localhost:${STICKY_PORT}`;

test.use({ baseURL: STICKY_URL });

const VIEWPORT = ".overflow-y-scroll";
const COMPOSER = "Message pico… (/ for commands)";

async function scrollViewportTo(page: Page, where: "top" | "bottom") {
  await page.locator(VIEWPORT).evaluate((el, edge) => {
    const prev = el.style.scrollBehavior;
    el.style.scrollBehavior = "auto";
    el.scrollTop = edge === "bottom" ? el.scrollHeight : 0;
    el.style.scrollBehavior = prev;
  }, where);
}

test.describe("pico web stick-to-bottom autoscroll", () => {
  test("follows streaming growth while the viewport is at the bottom", async ({
    page,
  }) => {
    await page.goto("/");
    const composer = page.getByPlaceholder(COMPOSER);
    await composer.fill("go");
    await composer.press("Enter");

    await expect(
      page.getByText("sticky line 5", { exact: true }),
    ).toBeVisible();
    await scrollViewportTo(page, "bottom");

    const streaming = () => page.getByLabel("Stop generating").count();
    const distance = () =>
      page
        .locator(VIEWPORT)
        .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    let stuck = false;
    for (let i = 0; i < 12 && (await streaming()) > 0; i++) {
      if ((await distance()) < 4) stuck = true;
      await page.waitForTimeout(60);
    }
    expect(stuck).toBe(true);
  });

  test("does not pull the viewport down while scrolled up", async ({
    page,
  }) => {
    await page.goto("/");
    const composer = page.getByPlaceholder(COMPOSER);
    await composer.fill("go");
    await composer.press("Enter");

    await expect(
      page.getByText("sticky line 5", { exact: true }),
    ).toBeVisible();
    await scrollViewportTo(page, "top");

    const streaming = () => page.getByLabel("Stop generating").count();
    const distance = () =>
      page
        .locator(VIEWPORT)
        .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    for (let i = 0; i < 8 && (await streaming()) > 0; i++) {
      expect(await distance()).toBeGreaterThan(100);
      await page.waitForTimeout(60);
    }
  });
});
