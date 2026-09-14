import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI image loading",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps delayed images and adjacent rows stable through a transcript remount", async () => {
    await suite.withPage(
      { reducedMotion: "reduce", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const imageUrl = `${suite.server.baseUrl}sizing-image.png`;
        const imageData = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 480;
          canvas.height = 240;
          canvas.getContext("2d")!.fillRect(0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/png").split(",")[1]!;
        });
        let releaseImage!: () => void;
        const imageReady = new Promise<void>((resolve) => {
          releaseImage = resolve;
        });
        await page.route(imageUrl, async (route) => {
          await imageReady;
          await route.fulfill({ contentType: "image/png", body: Buffer.from(imageData, "base64") });
        });
        await installMockGateway(page, {
          historyMessages: Array.from({ length: 60 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content:
              index === 1
                ? [
                    { type: "text", text: "Delayed image." },
                    { type: "image", url: imageUrl, alt: "Intrinsic size proof" },
                  ]
                : `Image fixture message ${index}.`,
            timestamp: index + 1,
            __openclaw: { id: `image-message-${index}`, seq: index + 1 },
          })),
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await page.getByText("Image fixture message 59.", { exact: false }).waitFor();
        await thread.hover();
        await page.mouse.wheel(0, -100_000);
        const image = thread.getByRole("img", { name: "Intrinsic size proof" });
        await image.waitFor({ state: "attached" });
        const geometry = () =>
          image.evaluate((element) => {
            const row = element.closest<HTMLElement>(".chat-virtual-row")!;
            const next = row
              .closest(".chat-thread")!
              .querySelector('.chat-bubble[data-entry-id="image-message-2"]')!
              .closest<HTMLElement>(".chat-virtual-row")!;
            const frame = element.closest(".chat-image-frame")!.getBoundingClientRect();
            return {
              height: row.offsetHeight,
              top: row.getBoundingClientRect().top,
              nextTop: next.getBoundingClientRect().top,
              imageWidth: frame.width,
              imageHeight: frame.height,
            };
          });
        await waitForChatScrollIdle(page);
        const before = await geometry();
        expect(before.imageWidth).toBeGreaterThan(0);
        expect(before.imageHeight).toBeGreaterThan(0);
        expect(await image.evaluate((element) => (element as HTMLImageElement).naturalHeight)).toBe(
          0,
        );
        releaseImage();
        await image.evaluate((element) => (element as HTMLImageElement).decode());
        expect(await image.evaluate((element) => (element as HTMLImageElement).naturalHeight)).toBe(
          240,
        );
        await waitForChatScrollIdle(page);
        expect(await geometry()).toEqual(before);
        const gap = () =>
          image.evaluate((element) => {
            const row = element.closest<HTMLElement>(".chat-virtual-row")!;
            const next = row
              .closest(".chat-thread")!
              .querySelector('.chat-bubble[data-entry-id="image-message-2"]')!
              .closest<HTMLElement>(".chat-virtual-row")!;
            return next.getBoundingClientRect().top - row.getBoundingClientRect().bottom;
          });
        expect(Math.abs(await gap())).toBeLessThanOrEqual(1);
        await page.locator(".chat-scroll-to-bottom").click();
        await expect.poll(() => image.count()).toBe(0);
        await expect
          .poll(() =>
            thread.evaluate((element) =>
              Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
            ),
          )
          .toBeLessThanOrEqual(2);
        await thread.hover();
        await page.mouse.wheel(0, -100_000);
        await image.waitFor({ state: "visible" });
        await expect.poll(async () => (await geometry()).height).toBe(before.height);
        await image.evaluate((element) => (element as HTMLImageElement).decode());
        const returned = await geometry();
        expect(returned.imageWidth).toBe(before.imageWidth);
        expect(returned.imageHeight).toBe(before.imageHeight);
        expect(Math.abs(await gap())).toBeLessThanOrEqual(1);
      },
    );
  });
});
