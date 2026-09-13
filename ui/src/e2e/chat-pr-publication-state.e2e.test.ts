import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  publicationMethods,
  publicationOptions,
  showPublicationBranch,
  waitForWatchedSessionKey,
} from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const suite = createControlUiE2eSuite({ name: "Control UI PR publication state" });
const publicationContextOptions = () => ({
  colorScheme: "light" as const,
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { height: 800, width: 1180 },
});

suite.define(() => {
  it("keeps a merged transcript PR separate from an idle publication workspace", async () => {
    await suite.withPage(publicationContextOptions(), async ({ page }) => {
      const href = "https://github.com/synthetic/publication-demo/pull/42";
      const gateway = await installMockGateway(page, {
        communityInvite: false,
        featureMethods: [...publicationMethods, "controlUi.githubPreview"],
        deferredMethods: ["sessions.github.options"],
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: `The previous task PR was merged: ${href}` }],
          },
        ],
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "sessions.github.options": publicationOptions,
          "controlUi.githubPreview": {
            kind: "pull",
            number: 42,
            owner: "synthetic",
            repo: "publication-demo",
            state: "closed",
            mergedAt: "2026-09-12T00:00:00Z",
            createdAt: "2026-09-11T00:00:00Z",
            updatedAt: "2026-09-12T00:00:00Z",
            login: "reviewer",
            title: "Completed task in another worktree",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await showPublicationBranch(gateway, "openclaw/review-request");
      await gateway.waitForRequest("sessions.github.options");
      const chip = page.locator(`a.markdown-github-item[href="${href}"]`);
      await expect.poll(() => chip.getAttribute("data-github-state")).toBe("merged");
      await chip.focus();
      await expect
        .poll(() => page.locator(".github-link-hovercard").textContent())
        .toContain("Merged");
      await page.keyboard.press("Escape");
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "merged-pr-discovery.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".chat-prs"), [chip]),
        );
      }
      expect(await chip.getAttribute("data-github-state")).toBe("merged");
      expect(await page.locator(".chat-prs").textContent()).not.toContain("Publishing");
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      await gateway.resolveDeferred("sessions.github.options");
      await page.getByRole("button", { name: "Publish PR", exact: true }).waitFor();
      expect(await page.locator(".chat-prs").textContent()).toContain("openclaw/review-request");
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      expect(await gateway.getRequests("controlUi.githubPreview")).toHaveLength(1);
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "merged-pr-idle-workspace.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".chat-prs"), [chip]),
        );
      }
    });
  });

  it("shows unavailable cached PR state distinctly and clears the warning after recovery", async () => {
    await suite.withPage(publicationContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        communityInvite: false,
        featureMethods: publicationMethods,
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "sessions.github.options": publicationOptions,
        },
      });
      await page.goto(suite.server.baseUrl + "chat");
      const key = await waitForWatchedSessionKey(gateway);
      const repository = { owner: "synthetic", repo: "publication-demo" };
      const emit = (status: "ready" | "unavailable", state: "open" | "merged" = "open") =>
        gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [key]: {
              repository,
              pullRequests: [
                {
                  ...repository,
                  number: 43,
                  branch: "feature/current-task",
                  title: "Current task",
                  url: "https://github.com/synthetic/publication-demo/pull/43",
                  state,
                },
              ],
              rateLimited: false,
              status,
            },
          },
        });
      const row = page.locator(".chat-prs");
      const warning = row.locator(".chat-pr__warning");
      await emit("ready");
      await expect.poll(() => row.textContent()).toContain("#43");
      expect(await warning.count()).toBe(0);
      await emit("unavailable", "merged");
      await expect.poll(() => warning.getAttribute("aria-label")).toContain("last known state");
      expect(await warning.getAttribute("aria-label")).not.toContain("rate limit");
      expect(await row.textContent()).toContain("#43");
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "unavailable-pr-status.png"),
          await takeControlUiViewportScreenshot(page, row, [warning]),
        );
      }
      expect(await row.locator("article").getAttribute("data-state")).toBe("merged");
      await emit("ready", "merged");
      await expect.poll(() => warning.count()).toBe(0);
      expect(await row.textContent()).toContain("#43");
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          [key]: {
            repository,
            branch: { ...repository, branch: "feature/next-task", additions: 9 },
            pullRequests: [],
            rateLimited: false,
            status: "unavailable",
          },
        },
      });
      await expect.poll(() => row.textContent()).toContain("feature/next-task");
      expect(await row.textContent()).not.toContain("#43");
      expect(await row.locator("article").getAttribute("data-state")).toBe("branch");
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    });
  });
});
