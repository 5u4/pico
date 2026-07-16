import { expect, test } from "@playwright/test";

const STREAM_URL = "http://localhost:4143";

test.use({ baseURL: STREAM_URL });

test.describe("pico web streaming", () => {
  test("shows the working indicator and streams the reply incrementally", async ({
    page,
  }) => {
    await page.goto("/");
    const composer = page.getByPlaceholder("Message pico… (/ for commands)");
    await composer.fill("go");
    await composer.press("Enter");

    await expect(page.getByText("Working")).toBeVisible();

    await expect(page.getByText("streamed reply to go")).toBeVisible();
    await expect(page.getByText("Working")).toHaveCount(0);
    await expect(page.getByLabel("Stop generating")).toHaveCount(0);
    await expect(page.getByLabel("Send message")).toBeVisible();
  });

  test("cancels a running turn and stops streaming", async ({ page }) => {
    await page.goto("/");
    const composer = page.getByPlaceholder("Message pico… (/ for commands)");
    await composer.fill("cancel me now please stop soon");
    await composer.press("Enter");

    const stop = page.getByLabel("Stop generating");
    await expect(stop).toBeVisible();
    await stop.click();

    await expect(page.getByLabel("Send message")).toBeVisible();
    await expect(page.getByText("Working")).toHaveCount(0);

    await page.waitForTimeout(700);
    await expect(
      page.getByText("streamed reply to cancel me now please stop soon"),
    ).toHaveCount(0);
  });
});
