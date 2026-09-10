import { expect, test, type Page } from "@playwright/test";

const canvas = (page: Page) => page.getByTestId("draw-canvas");

async function expectVisibleSquareCanvas(page: Page) {
  const drawingCanvas = canvas(page);
  await expect(drawingCanvas).toBeVisible();
  const box = await drawingCanvas.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(120);
  expect(box!.height).toBeGreaterThan(120);
  expect(Math.abs(box!.width - box!.height)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("draw-canvas-viewport")).toBeVisible();
  await expect(page.getByLabel("Prompt")).toBeVisible();
}

test("a fresh Draw workspace keeps its custom canvas visible at Messages sizes", async ({ page }) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 390, height: 640 },
    { width: 768, height: 1024 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/draw/layout-fresh");
    await expectVisibleSquareCanvas(page);
  }
});

test("a revision strip cannot collapse the custom canvas", async ({ page }) => {
  await page.route("**/api/draw/sessions/layout-revision/status**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ events: [], currentJob: null }),
  }));
  await page.route("**/api/draw/sessions/layout-revision/revisions", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      revisions: [{
        jobId: "revision-1",
        parentJobId: null,
        rootJobId: "revision-1",
        revisionNumber: 1,
        mode: "fast",
        model: "gpt-image-2.5-flare",
        state: "ready_for_save",
        outputMediaId: null,
        previewMediaId: null,
        createdAtMs: 0,
      }],
    }),
  }));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/draw/layout-revision");
  await expect(page.locator(".revision-strip")).toBeVisible();
  await expectVisibleSquareCanvas(page);
});

test("drawing changes the custom canvas without scrolling the mini-app", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/draw/layout-stroke");
  await expectVisibleSquareCanvas(page);

  const box = await canvas(page).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 48, box!.y + 48);
  await page.mouse.down();
  await page.mouse.move(box!.x + 180, box!.y + 180, { steps: 4 });
  await page.mouse.up();

  await expect.poll(() => canvas(page).evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext("2d");
    if (!context) return false;
    const pixels = context.getImageData(0, 0, 1024, 1024).data;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] !== 0) return true;
    }
    return false;
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});
