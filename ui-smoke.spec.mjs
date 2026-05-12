import { expect, test } from "@playwright/test";

const baseUrl = process.env.REALTIME_OPERATOR_URL || "http://127.0.0.1:49376/";
const token = process.env.REALTIME_OPERATOR_TOKEN || "";

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectInFirstViewport(page, selector) {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

async function expectConnectFailureBeforeRealtime(page, setupScript, expectedText) {
  const runtimeErrors = [];
  let realtimeSessionCalls = 0;
  let sdpCalls = 0;
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.addInitScript(setupScript);
  await page.route("**/api/realtime-session", async (route) => {
    realtimeSessionCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      json: {
        ok: true,
        model: "gpt-realtime-2",
        voice: "marin",
        voiceStyle: "calm_operator",
        session: { client_secret: { value: "should-not-be-created" } },
      },
    });
  });
  await page.route("https://api.openai.com/v1/realtime/calls", async (route) => {
    sdpCalls += 1;
    await route.fulfill({ body: "should-not-connect", contentType: "application/sdp", status: 200 });
  });

  await page.goto(baseUrl);
  await page.locator("#connect").click();
  await expect(page.locator("#log")).toContainText(expectedText);
  await expect(page.locator("#log")).not.toContainText("Cannot read properties");
  await expect(page.locator("#status")).toContainText("Connection failed");
  await expect(page.locator("#connect")).toBeEnabled();
  expect(realtimeSessionCalls).toBe(0);
  expect(sdpCalls).toBe(0);
  expect(runtimeErrors).toEqual([]);
}

test.describe("Realtime Operator UI", () => {
  test("wide layout renders controls and local tools", async ({ page }) => {
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(baseUrl);
    await expect(page).toHaveTitle("Realtime Operator");
    await expect(page.getByRole("heading", { name: "Talk. The operator acts." })).toBeVisible();
    await expect(page.locator("#connect")).toBeVisible();
    await expect(page.locator("#muteMic")).toBeVisible();
    await expect(page.locator("#muteMic")).toBeDisabled();
    await expectInFirstViewport(page, "#connect");
    await expectInFirstViewport(page, "#muteMic");
    await expectInFirstViewport(page, "#disconnect");
    await page.locator("#toolStatus").click();
    await expect(page.locator("#log")).toContainText("get_system_status", { timeout: 10_000 });
    await page.locator("#discover").click();
    await expect(page.locator("#log")).toContainText("run_command", { timeout: 10_000 });
    await expectNoHorizontalOverflow(page);
    expect(consoleErrors).toEqual([]);
  });

  test("mobile layout has an explicit menu close control", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseUrl);
    await expect(page.getByRole("heading", { name: "Talk. The operator acts." })).toBeVisible();
    await expect(page.locator("#connect")).toBeVisible();
    await expectInFirstViewport(page, "#connect");
    await page.locator("#toggleMenu").click();
    await expect(page.locator("#rail")).toBeVisible();
    await expect(page.locator("#closeMenu")).toBeVisible();
    await expect(page.locator("#closeMenu")).toHaveAccessibleName("Close menu");
    await page.locator("#closeMenu").click();
    await expect(page.locator("body")).not.toHaveClass(/dock-open/);
    await expectNoHorizontalOverflow(page);
  });

  test("mute toggles the active microphone track while connected", async ({ page }) => {
    await page.addInitScript(() => {
      const track = { enabled: true, kind: "audio", stop() {} };
      const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
      window.__operatorTestTrack = track;
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: async () => stream },
      });
      window.RTCPeerConnection = class FakeRTCPeerConnection {
        constructor() {
          this.connectionState = "new";
          this._dataChannel = null;
        }
        addTrack() {}
        createDataChannel() {
          const channel = {
            readyState: "connecting",
            sent: [],
            close() { this.readyState = "closed"; this.onclose?.(); },
            send(payload) { this.sent.push(JSON.parse(payload)); },
          };
          this._dataChannel = channel;
          window.__operatorTestChannel = channel;
          return channel;
        }
        async createOffer() { return { type: "offer", sdp: "fake-offer-sdp" }; }
        async setLocalDescription() {}
        async setRemoteDescription() {
          this.connectionState = "connected";
          this.onconnectionstatechange?.();
          if (this._dataChannel) {
            this._dataChannel.readyState = "open";
            this._dataChannel.onopen?.();
          }
        }
        close() {
          this.connectionState = "closed";
          this.onconnectionstatechange?.();
        }
      };
    });
    await page.route("**/api/realtime-session", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: { ok: true, model: "gpt-realtime-2", voice: "marin", session: { client_secret: { value: "test-secret" } } },
      });
    });
    await page.route("https://api.openai.com/v1/realtime/calls", async (route) => {
      await route.fulfill({ body: "fake-answer-sdp", contentType: "application/sdp", status: 200 });
    });

    await page.goto(baseUrl);
    await page.locator("#connect").click();
    await expect(page.locator("#muteMic")).toBeEnabled();
    await expect(page.locator("#liveLabel")).toHaveText("Live");
    await expect.poll(() => page.evaluate(() => window.__operatorTestTrack.enabled)).toBe(true);

    await page.evaluate(() => {
      window.__operatorTestChannel.onmessage({
        data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "Hello", item_id: "hello" }),
      });
    });
    await expect.poll(() => page.evaluate(() => window.__operatorTestChannel.sent.filter((event) => event.type === "response.create").length)).toBe(1);

    await page.evaluate(() => {
      window.__operatorTestChannel.onmessage({
        data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "um", item_id: "filler" }),
      });
    });
    await expect.poll(() => page.evaluate(() => window.__operatorTestChannel.sent.filter((event) => event.type === "response.create").length)).toBe(1);

    await page.locator("#muteMic").click();
    await expect(page.locator("#muteMic")).toHaveText("Unmute");
    await expect(page.locator("#muteMic")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#liveLabel")).toHaveText("Muted");
    await expect.poll(() => page.evaluate(() => window.__operatorTestTrack.enabled)).toBe(false);
  });

  test("connect gives HTTPS microphone guidance when mediaDevices is missing", async ({ page }) => {
    await expectConnectFailureBeforeRealtime(
      page,
      () => {
        Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
      },
      "Microphone API is unavailable",
    );
  });

  test("connect gives permission guidance when microphone access is blocked", async ({ page }) => {
    await expectConnectFailureBeforeRealtime(
      page,
      () => {
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: { getUserMedia: async () => { throw new DOMException("blocked", "NotAllowedError"); } },
        });
        window.RTCPeerConnection = class FakeRTCPeerConnection {};
      },
      "Microphone permission was blocked",
    );
  });

  test("connect gives browser guidance when WebRTC is missing", async ({ page }) => {
    await expectConnectFailureBeforeRealtime(
      page,
      () => {
        Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: undefined });
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: { getUserMedia: async () => ({ getAudioTracks: () => [{ enabled: true, stop() {} }], getTracks: () => [{ stop() {} }] }) },
        });
      },
      "WebRTC is not available",
    );
  });

  test("connect fails clearly when browser returns no microphone track", async ({ page }) => {
    await expectConnectFailureBeforeRealtime(
      page,
      () => {
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: { getUserMedia: async () => ({ getAudioTracks: () => [], getTracks: () => [{ stop() {} }] }) },
        });
        window.RTCPeerConnection = class FakeRTCPeerConnection {};
      },
      "No microphone audio track was returned",
    );
  });
});

