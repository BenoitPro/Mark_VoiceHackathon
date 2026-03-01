import { expect, test } from "@playwright/test";

test("auth screen has no horizontal overflow", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /sign in with google|continue with google/i }).first().waitFor();

  const dimensions = await page.evaluate(() => {
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    };
  });

  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
});

test("primary sign-in action is touch friendly", async ({ page }) => {
  await page.goto("/");
  const signIn = page.getByRole("button", { name: /sign in with google|continue with google/i }).first();
  await expect(signIn).toBeVisible();

  const bounds = await signIn.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(bounds?.width ?? 0).toBeGreaterThan(120);
});
