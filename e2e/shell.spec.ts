import { expect, test } from "@playwright/test";

test.describe("pico web shell", () => {
  test("boots into the welcome state with a populated sidebar", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "How can I help you today?" }),
    ).toBeVisible();
    await expect(page.getByText("Workspaces")).toBeVisible();
    await expect(page.getByText("Default", { exact: true })).toBeVisible();
    await expect(
      page.getByPlaceholder("Message pico… (/ for commands)"),
    ).toBeVisible();
    await expect(page.getByText("Default/New chat")).toBeVisible();
  });

  test("sends a prompt and renders the reply, reasoning, and tool card", async ({
    page,
  }) => {
    await page.goto("/");
    const composer = page.getByPlaceholder("Message pico… (/ for commands)");
    await composer.fill("hello pico");
    await composer.press("Enter");

    await expect(
      page.locator("div.justify-end", { hasText: "hello pico" }),
    ).toBeVisible();
    await expect(page.getByText("echo: hello pico")).toBeVisible();
    await expect(page.getByText("read", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("README.md")).toBeVisible();
    await expect(page.getByText("4.2k")).toBeVisible();
    await expect(page.getByText("(2%)")).toBeVisible();

    await page.getByText("Reasoning", { exact: true }).click();
    await expect(page.getByText("considering the request")).toBeVisible();
  });

  test("opens the context-usage breakdown popover", async ({ page }) => {
    await page.goto("/");
    const composer = page.getByPlaceholder("Message pico… (/ for commands)");
    await composer.fill("usage please");
    await composer.press("Enter");

    await page.getByText("4.2k").click();
    await expect(page.getByText("Context usage")).toBeVisible();
    await expect(page.getByText("System prompt")).toBeVisible();
    await expect(page.getByText("Session cost")).toBeVisible();
    await expect(page.getByText("$0.012")).toBeVisible();
  });

  test("creates a workspace and a conversation from the sidebar", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New workspace" }).click();
    const nameField = page.getByLabel("Workspace name");
    await nameField.fill("scratch");
    await nameField.press("Enter");

    const workspace = page.getByRole("button", { name: "scratch" }).first();
    await expect(workspace).toBeVisible();

    await workspace.hover();
    await page.getByRole("button", { name: "New conversation" }).last().click();
    await expect(page.getByText("scratch/New chat")).toBeVisible();
  });

  test("switches to the dark theme", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await page.getByRole("menuitem", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("hides and shows the sidebar", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Workspaces")).toBeVisible();

    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(
      page.getByRole("button", { name: "Show sidebar" }),
    ).toBeVisible();
  });
});
