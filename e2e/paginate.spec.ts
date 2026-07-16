import { expect, test } from "@playwright/test";

const PAGINATE_PORT = process.env.PICO_E2E_PAGINATE_PORT ?? "4144";
const PAGINATE_URL =
  process.env.PICO_E2E_PAGINATE_URL ?? `http://localhost:${PAGINATE_PORT}`;

test.use({ baseURL: PAGINATE_URL });

const VIEWPORT = ".overflow-y-scroll";

test.describe("pico web load-older pagination", () => {
  test("windows the tail and hides early history on first load", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Seeded history" }).click();
    await expect(
      page.getByText("user line 118", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("user line 2", { exact: true })).toHaveCount(0);
  });

  test("prepending older messages keeps the anchor in view without a jump", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Seeded history" }).click();
    await expect(
      page.getByText("user line 118", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("user line 60", { exact: true })).toHaveCount(
      0,
    );

    const anchor = page.getByText("user line 80", { exact: true });

    await page.locator(VIEWPORT).evaluate((el) => {
      el.scrollTop = 0;
    });

    await expect(page.getByText("user line 60", { exact: true })).toHaveCount(
      1,
    );

    await expect(anchor).toBeInViewport();
    await expect(
      page.getByText("user line 60", { exact: true }),
    ).not.toBeInViewport();
  });
});
