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

test("the centered view toggle and icon model picker stay reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let generationCalls = 0;
  await page.route("**/api/draw/sessions/layout-controls/generations", (route) => {
    generationCalls += 1;
    return route.abort();
  });
  await page.goto("/draw/layout-controls");
  const sketch = page.getByRole("tab", { name: "Sketch" });
  const preview = page.getByRole("tab", { name: "Preview" });
  await expect(sketch).toBeVisible();
  await expect(preview).toBeVisible();
  await expect(sketch).toHaveAttribute("aria-selected", "true");
  await expect(sketch).toHaveCSS("color", "rgb(248, 251, 255)");
  await expect(preview).toBeDisabled();
  await expect(page.getByRole("radiogroup", { name: "Generation mode" })).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(4);
  await expect(page.getByText("Flare Fast", { exact: true })).toBeVisible();
  await expect(page.getByText("Your next idea starts here", { exact: true })).toHaveCount(0);

  for (const item of ["fast", "detailed", "turbo", "hq"]) {
    const icon = page.locator(`[data-mode="${item}"] svg`);
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute("fill", "none");
    await expect(icon).toHaveAttribute("stroke", "currentColor");
  }
  await expect(page.locator('[data-mode="fast"]')).toHaveAttribute("tabindex", "0");
  await expect(page.locator('[data-mode="detailed"]')).toHaveAttribute("tabindex", "-1");

  await page.getByRole("radio", { name: "Turbo · 4 steps" }).click();
  await expect(page.getByText("Turbo · 4 steps", { exact: true })).toBeVisible();
  await expect(page.locator('[data-mode="turbo"]')).toHaveAttribute("aria-checked", "true");
  await page.locator('[data-mode="turbo"]').press("ArrowRight");
  await expect(page.locator('[data-mode="hq"]')).toBeFocused();
  await expect(page.getByText("Sunburst HQ", { exact: true })).toBeVisible();
  expect(generationCalls).toBe(0);
});

test("a decoded image switches views only when the user asks or a newly submitted job reveals its first preview", async ({ page }) => {
  const session = "layout-preview";
  const status = {
    events: [],
    currentJob: { jobId: "existing-image", state: "ready_for_save", previewMediaId: null, outputMediaId: "ready-image", errorCode: null },
  };
  await page.route(`**/api/draw/sessions/${session}/status**`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(status) }));
  await page.route(`**/api/draw/sessions/${session}/revisions`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ revisions: [] }) }));
  await page.route(`**/api/draw/sessions/${session}/media/ready-image`, (route) => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#b45309"/></svg>',
  }));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/draw/${session}`);
  const sketch = page.getByRole("tab", { name: "Sketch" });
  const preview = page.getByRole("tab", { name: "Preview" });
  await expect(preview).toBeEnabled();
  await expect(sketch).toHaveAttribute("aria-selected", "true");
  await preview.click();
  await expect(preview).toHaveAttribute("aria-selected", "true");
  await expect(page.getByAltText("COAST generated preview")).toHaveCSS("opacity", "1");
  await expect(page.getByRole("button", { name: "Eraser" })).toBeDisabled();

  await sketch.click();
  await expect(sketch).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Eraser" })).toBeEnabled();
  await expect(page.getByAltText("COAST generated preview")).toHaveCSS("opacity", "0");
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

test("the cursor glow stays in its UI overlay and fades after brush drawing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/draw/layout-glow");
  const box = await canvas(page).boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + 48, box!.y + 48);
  await page.mouse.down();
  await page.mouse.move(box!.x + 180, box!.y + 180, { steps: 4 });
  await expect.poll(() => page.locator(".pencil-glow").evaluate((element) => {
    const pixels = (element as HTMLCanvasElement).getContext("2d")?.getImageData(0, 0, (element as HTMLCanvasElement).width, (element as HTMLCanvasElement).height).data;
    return pixels ? Array.from(pixels).some((value, index) => index % 4 === 3 && value > 0) : false;
  })).toBe(true);
  await page.mouse.up();
  await page.waitForTimeout(260);
  await expect.poll(() => page.locator(".pencil-glow").evaluate((element) => {
    const pixels = (element as HTMLCanvasElement).getContext("2d")?.getImageData(0, 0, (element as HTMLCanvasElement).width, (element as HTMLCanvasElement).height).data;
    return pixels ? Array.from(pixels).some((value, index) => index % 4 === 3 && value > 0) : false;
  })).toBe(false);
});
