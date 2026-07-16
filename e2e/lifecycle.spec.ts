import { expect, type Page, test } from "@playwright/test";

async function send(page: Page, text: string) {
  const composer = page.getByPlaceholder("Message pico… (/ for commands)");
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.getByText(`echo: ${text}`)).toBeVisible();
}

test.describe("pico web conversation lifecycle", () => {
  test("replays history when switching between conversations", async ({
    page,
  }) => {
    await page.goto("/");
    await send(page, "replay alpha");

    await page.getByRole("button", { name: "New conversation" }).last().click();
    await send(page, "replay beta");
    await expect(page.getByText("echo: replay alpha")).toHaveCount(0);

    await page.getByRole("button", { name: "replay alpha" }).first().click();
    await expect(page.getByText("echo: replay alpha")).toBeVisible();
    await expect(page.getByText("echo: replay beta")).toHaveCount(0);

    await page.getByRole("button", { name: "replay beta" }).first().click();
    await expect(page.getByText("echo: replay beta")).toBeVisible();
    await expect(page.getByText("echo: replay alpha")).toHaveCount(0);
  });

  test("restores the active conversation after a page reload", async ({
    page,
  }) => {
    await page.goto("/");
    await send(page, "reload survivor");

    await page.reload();

    await expect(page.getByText("echo: reload survivor")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "How can I help you today?" }),
    ).toHaveCount(0);
  });

  test("shows and dismisses the error banner", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New workspace" }).click();
    const nameField = page.getByLabel("Workspace name");
    await nameField.fill("banner-ws");
    await nameField.press("Enter");

    const workspace = page
      .getByRole("button", { name: "banner-ws", exact: true })
      .first();
    await workspace.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Change directory" }).click();
    const cwdField = page.getByLabel("Change workspace directory");
    await cwdField.fill("/no/such/pico/dir");
    await cwdField.press("Enter");

    const banner = page.getByText("not a directory:");
    await expect(banner).toBeVisible();

    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(banner).toHaveCount(0);
  });
});
