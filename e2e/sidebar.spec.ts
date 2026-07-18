import { expect, type Page, test } from "@playwright/test";

async function newWorkspace(page: Page, name: string) {
  await page.getByRole("button", { name: "New workspace" }).click();
  const field = page.getByLabel("Workspace name");
  await field.fill(name);
  await field.press("Enter");
  const workspace = page.getByRole("button", { name, exact: true }).first();
  await expect(workspace).toBeVisible();
  return workspace;
}

test.describe("pico web sidebar", () => {
  test("renames a workspace through the context menu", async ({ page }) => {
    await page.goto("/");
    const workspace = await newWorkspace(page, "rename-src");
    await workspace.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename" }).click();

    const field = page.getByLabel("Rename workspace");
    await expect(field).toBeVisible();
    await field.fill("rename-dst");
    await field.press("Enter");

    await expect(
      page.getByRole("button", { name: "rename-dst", exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText("rename-src", { exact: true })).toHaveCount(0);
  });

  test("keeps the old name when a rename is cancelled with Escape", async ({
    page,
  }) => {
    await page.goto("/");
    const workspace = await newWorkspace(page, "escape-keep");
    await workspace.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename" }).click();

    const field = page.getByLabel("Rename workspace");
    await field.fill("escape-discard");
    await field.press("Escape");

    await expect(page.getByText("escape-keep", { exact: true })).toBeVisible();
    await expect(page.getByText("escape-discard")).toHaveCount(0);
  });

  test("changes the workspace directory and persists it", async ({ page }) => {
    await page.goto("/");
    const workspace = await newWorkspace(page, "cwd-persist");
    await workspace.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Change directory" }).click();

    const field = page.getByLabel("Directory", { exact: true });
    await expect(field).toHaveValue("/tmp/pico-e2e");
    await field.fill("/tmp");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("not a directory")).toHaveCount(0);

    await workspace.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Change directory" }).click();
    await expect(page.getByLabel("Directory", { exact: true })).toHaveValue(
      "/tmp",
    );
  });

  test("reports an error when the directory does not exist", async ({
    page,
  }) => {
    await page.goto("/");
    const workspace = await newWorkspace(page, "cwd-error");
    await workspace.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Change directory" }).click();

    const field = page.getByLabel("Directory", { exact: true });
    await field.fill("/no/such/pico/dir");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("not a directory:")).toBeVisible();
  });

  test("collapses and expands a workspace", async ({ page }) => {
    await page.goto("/");
    const workspace = await newWorkspace(page, "collapse-me");
    await expect(workspace).toHaveAttribute("data-state", "open");

    await workspace.click();
    await expect(workspace).toHaveAttribute("data-state", "closed");

    await workspace.click();
    await expect(workspace).toHaveAttribute("data-state", "open");
  });

  test("archives the active conversation back to the welcome state", async ({
    page,
  }) => {
    await page.goto("/");
    const composer = page.getByPlaceholder("Message pico… (/ for commands)");
    await composer.fill("archive target message");
    await composer.press("Enter");
    await expect(page.getByText("echo: archive target message")).toBeVisible();

    const row = page
      .getByRole("button", { name: "archive target message" })
      .first();
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Archive" }).click();

    await expect(
      page.getByRole("heading", { name: "How can I help you today?" }),
    ).toBeVisible();
    await expect(page.getByText("echo: archive target message")).toHaveCount(0);
  });
});
