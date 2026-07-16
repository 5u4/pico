import type { WebSocketRoute } from "@playwright/test";
import { expect, type Page, test } from "@playwright/test";

async function send(page: Page, text: string) {
  const composer = page.getByPlaceholder("Message pico… (/ for commands)");
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.getByText(`echo: ${text}`)).toBeVisible();
}

test.describe("pico web connection banner", () => {
  test("reconnects and restores the session after the socket drops", async ({
    page,
  }) => {
    const routes: WebSocketRoute[] = [];
    await page.routeWebSocket(
      (url) => new URL(url).pathname === "/ws",
      (ws) => {
        routes.push(ws);
        ws.connectToServer();
      },
    );

    await page.goto("/");
    await send(page, "survive drop");

    const live = routes[routes.length - 1];
    if (!live) throw new Error("expected a live websocket route");
    await live.close();

    await expect(page.getByText("Disconnected — reconnecting…")).toBeVisible();

    await expect(page.getByText("Reconnected")).toBeVisible();
    expect(routes.length).toBeGreaterThan(1);

    await send(page, "after reconnect");
    await expect(page.getByText("echo: survive drop")).toBeVisible();
    await expect(page.getByText("echo: after reconnect")).toBeVisible();

    await expect(page.getByText("Reconnected")).toHaveCount(0);
  });
});
