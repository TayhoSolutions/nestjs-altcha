/**
 * End-to-end test with the real ALTCHA widget (v3) in a browser against the built verifier (dist).
 * Checks that the challenge format and the widget's payload match the verifier.
 *
 * Usage:   npm run build && npm run test:widget
 * Browser: CHROMIUM_PATH=/path/to/chrome (any Chromium-based browser)
 * Tuning:  ALTCHA_COST, ALTCHA_COUNTER_MAX (counter range is [max/2, max])
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const { createAltchaVerifier } = require("../dist");

const widgetDist = path.join(__dirname, "..", "node_modules", "altcha", "dist");
const verifier = createAltchaVerifier({
    hmacSecret: "widget-e2e-secret-0123456789-0123456789",
    // default parameters; override via environment variables to measure other settings
    ...(process.env.ALTCHA_COST ? { cost: Number(process.env.ALTCHA_COST) } : {}),
    ...(process.env.ALTCHA_COUNTER_MAX
        ? {
              counter: {
                  min: Math.floor(Number(process.env.ALTCHA_COUNTER_MAX) / 2),
                  max: Number(process.env.ALTCHA_COUNTER_MAX),
              },
          }
        : {}),
});

const page = `<!doctype html><html><body>
<form id="f"><altcha-widget challenge="/challenge" auto="onload"></altcha-widget></form>
<script type="module" src="/altcha/main/altcha.js"></script>
</body></html>`;

const server = http.createServer(async (req, res) => {
    try {
        if (req.url === "/") {
            res.writeHead(200, { "content-type": "text/html" }).end(page);
        } else if (req.url === "/challenge") {
            res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify(await verifier.createChallenge()),
            );
        } else if (req.url?.startsWith("/altcha/")) {
            const file = path.join(widgetDist, req.url.slice("/altcha/".length));
            if (!file.startsWith(widgetDist) || !fs.existsSync(file)) return res.writeHead(404).end();
            res.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync(file));
        } else {
            res.writeHead(404).end();
        }
    } catch (err) {
        res.writeHead(500).end(String(err));
    }
});

(async () => {
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    const browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || undefined,
    });
    try {
        const tab = await browser.newPage();
        tab.on("pageerror", (err) => console.error("pageerror:", err.message));
        await tab.goto(`http://127.0.0.1:${port}/`);
        const started = Date.now();
        const handle = await tab.waitForFunction(
            () => document.querySelector('input[name="altcha"]')?.value || null,
            null,
            { timeout: 60_000 },
        );
        const payload = await handle.jsonValue();
        const params = JSON.parse(Buffer.from(payload, "base64").toString("utf8")).challenge.parameters;
        console.log(
            `Widget solved the challenge in ${Date.now() - started} ms (${params.algorithm}, cost ${params.cost}).`,
        );

        const first = await verifier.verify(payload);
        const replay = await verifier.verify(payload);
        console.log("First verification:", first);
        console.log("Second verification:", replay);
        if (!first.ok || replay.ok || replay.reason !== "replayed") {
            throw new Error("Widget payload was not verified as expected");
        }
        console.log("OK");
    } finally {
        await browser.close();
        server.close();
    }
})().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
