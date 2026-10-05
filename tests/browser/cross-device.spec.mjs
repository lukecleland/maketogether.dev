import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const peerFixture = await readFile(
  new URL("./fixtures/peer.mjs", import.meta.url),
  "utf8",
);

test("desktop, iPhone and tablet share edits, drawings, late joins and rejoining", async ({
  browser,
}) => {
  const pages = [],
    contexts = [],
    errors = [];
  async function device(viewport, mobile = false) {
    const context = await browser.newContext({
      viewport,
      hasTouch: mobile,
      isMobile: mobile,
    });
    contexts.push(context);
    await context.route("**/node_modules/.vite/deps/peerjs.js*", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: peerFixture,
      }),
    );
    await context.exposeBinding(
      "sendTestPeerFrame",
      async ({ page: source }, frame) => {
        await Promise.all(
          pages
            .filter((page) => page !== source && !page.isClosed())
            .map((page) =>
              page
                .evaluate(
                  (message) => window.receiveTestPeerFrame?.(message),
                  frame,
                )
                .catch(() => {}),
            ),
        );
      },
    );
    await context.addInitScript(() => {
      if (navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = () =>
          Promise.reject(new Error("No test devices"));
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    pages.push(page);
    return page;
  }
  async function snapshot(page) {
    if (
      !(await page
        .getByRole("button", { name: "Export room bundle", exact: true })
        .isVisible())
    ) {
      await page
        .getByRole("button", { name: "Open menu", exact: true })
        .click();
    }
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Export room bundle", exact: true })
      .click();
    return JSON.parse(await readFile(await (await download).path(), "utf8"))
      .snapshot;
  }
  const shared = (snapshot) => ({
    panels: snapshot.panels,
    drawings: snapshot.drawings,
    drawingViewport: snapshot.drawingViewport,
    connectors: snapshot.connectors,
    positionTags: snapshot.positionTags,
  });
  try {
    const desktop = await device({ width: 1440, height: 900 });
    await desktop.goto("http://127.0.0.1:5178");
    await desktop
      .getByRole("button", { name: "Start Session", exact: true })
      .click();
    await expect(
      desktop.getByText("Waiting for guest…", { exact: true }),
    ).toBeVisible();
    const room = desktop.url();
    await desktop.getByTitle("Add a sticky note", { exact: true }).click();
    await desktop
      .getByRole("textbox", { name: "Note text", exact: true })
      .fill("Shared from desktop");
    const phone = await device({ width: 390, height: 844 }, true);
    await phone.goto(room);
    await expect(
      phone.getByText("Connected · 2/4", { exact: true }),
    ).toBeVisible();
    await expect(
      phone.getByRole("textbox", { name: "Note text", exact: true }),
    ).toHaveValue("Shared from desktop");
    await phone
      .getByRole("textbox", { name: "Note text", exact: true })
      .fill("Edited from iPhone");
    await expect(
      desktop.getByRole("textbox", { name: "Note text", exact: true }),
    ).toHaveValue("Edited from iPhone");

    // Draw while another device is already connected; then join a third.
    await desktop.getByRole("button", { name: "Pen", exact: true }).click();
    await desktop.mouse.move(920, 650);
    await desktop.mouse.down();
    await desktop.mouse.move(980, 700, { steps: 4 });
    await desktop.mouse.up();
    await desktop
      .getByRole("button", { name: "Text tool", exact: true })
      .click();
    await desktop.mouse.click(1000, 600);
    await desktop
      .getByRole("textbox", { name: "Canvas text", exact: true })
      .fill("Shared canvas label");
    await desktop
      .getByRole("textbox", { name: "Canvas text", exact: true })
      .press("Enter");
    await desktop.getByRole("button", { name: "Pointer", exact: true }).click();

    expect(shared(await snapshot(phone))).toEqual(
      shared(await snapshot(desktop)),
    );

    const tablet = await device({ width: 820, height: 1180 }, true);
    await tablet.goto(room);
    await expect(
      tablet.getByText("Connected · 3/4", { exact: true }),
    ).toBeVisible();
    await expect(
      tablet.getByRole("textbox", { name: "Note text", exact: true }),
    ).toHaveValue("Edited from iPhone");
    const original = await snapshot(desktop);
    expect(original.drawings.length).toBeGreaterThan(1);
    expect(shared(await snapshot(phone))).toEqual(shared(original));
    expect(shared(await snapshot(tablet))).toEqual(shared(original));
    await phone.setViewportSize({ width: 844, height: 390 });
    expect(shared(await snapshot(phone))).toEqual(shared(original));
    // Model the transport close that a real RTC connection emits on navigation.
    await phone.evaluate(() => {
      for (const peer of window.testPeers) peer.destroy();
    });
    await expect(
      desktop.getByText("Connected · 2/4", { exact: true }),
    ).toBeVisible();
    await phone.reload();
    await expect(
      phone.getByText("Connected · 3/4", { exact: true }),
    ).toBeVisible();
    await expect(
      phone.getByRole("textbox", { name: "Note text", exact: true }),
    ).toHaveValue("Edited from iPhone");
    expect(shared(await snapshot(phone))).toEqual(shared(original));
    await phone.evaluate(() => {
      for (const peer of window.testPeers) peer.destroy();
    });
    await expect(
      desktop.getByText("Connected · 2/4", { exact: true }),
    ).toBeVisible();
    await phone.goto("about:blank");
    await desktop
      .getByRole("textbox", { name: "Note text", exact: true })
      .fill("Changed while phone was away");
    await expect(
      tablet.getByRole("textbox", { name: "Note text", exact: true }),
    ).toHaveValue("Changed while phone was away");
    await phone.goto(room);
    await expect(
      phone.getByRole("textbox", { name: "Note text", exact: true }),
    ).toHaveValue("Changed while phone was away");
    expect(shared(await snapshot(phone))).toEqual(
      shared(await snapshot(desktop)),
    );
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
