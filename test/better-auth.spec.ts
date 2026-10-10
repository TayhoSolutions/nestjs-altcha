import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";

import { altcha } from "../src/better-auth";
import type { AltchaPluginOptions } from "../src/better-auth";
import { fastVerifier, solve } from "./helpers";

const BASE = "http://localhost:3000";

function createAuth(options: Partial<AltchaPluginOptions> = {}) {
    const verifier = options.verifier ?? fastVerifier();
    const auth = betterAuth({
        baseURL: BASE,
        basePath: "/api/auth",
        secret: "better-auth-test-secret-0123456789-0123456789",
        database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
        emailAndPassword: { enabled: true },
        rateLimit: { enabled: false },
        logger: { disabled: true },
        plugins: [altcha({ ...options, verifier })],
    });
    return { auth, verifier };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, ...headers },
        body: JSON.stringify(body),
    });
}

async function challengePayload(auth: ReturnType<typeof createAuth>["auth"]) {
    const res = await auth.handler(new Request(`${BASE}/api/auth/altcha/challenge`));
    expect(res.status).toBe(200);
    return solve(await res.json());
}

const credentials = { email: "nobody@example.com", password: "wrong-password-123" };

describe("Better Auth plugin altcha()", () => {
    it("serves challenges at /altcha/challenge without caching", async () => {
        const { auth } = createAuth();
        const res = await auth.handler(new Request(`${BASE}/api/auth/altcha/challenge`));
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const body = await res.json();
        expect(body.parameters?.nonce).toBeTruthy();
        expect(body.signature).toBeTruthy();
    });

    it("blocks protected routes without a solution", async () => {
        const { auth } = createAuth();
        const res = await auth.handler(post("/sign-in/email", credentials));
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: "ALTCHA_FAILED", reason: "missing" });
    });

    it("lets a valid solution through exactly once (sign-in then fails on the credentials)", async () => {
        const { auth } = createAuth();
        const payload = await challengePayload(auth);

        const first = await auth.handler(post("/sign-in/email", credentials, { "x-altcha": payload }));
        expect(first.status).toBe(401);

        const replay = await auth.handler(post("/sign-in/email", credentials, { "x-altcha": payload }));
        expect(replay.status).toBe(403);
        expect(await replay.json()).toMatchObject({ reason: "replayed" });
    });

    it("leaves routes that are not configured untouched", async () => {
        const { auth } = createAuth({ endpoints: ["/sign-up/email"] });
        const res = await auth.handler(post("/sign-in/email", credentials));
        expect(res.status).toBe(401);
    });

    it("supports wildcards", async () => {
        const { auth } = createAuth({ endpoints: ["/sign-in/*"] });
        expect((await auth.handler(post("/sign-in/email", credentials))).status).toBe(403);
        expect((await auth.handler(post("/sign-up/email", { ...credentials, name: "x" }))).status).not.toBe(403);
    });

    it("does not check server-side calls via auth.api", async () => {
        const { auth } = createAuth();
        await expect(auth.api.signInEmail({ body: credentials })).rejects.toMatchObject({ statusCode: 401 });
    });

    it("protects routes when baseURL contains a path", async () => {
        const auth = betterAuth({
            baseURL: `${BASE}/auth`,
            secret: "better-auth-test-secret-0123456789-0123456789",
            database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
            emailAndPassword: { enabled: true },
            rateLimit: { enabled: false },
            logger: { disabled: true },
            plugins: [altcha({ verifier: fastVerifier() })],
        });
        const res = await auth.handler(
            new Request(`${BASE}/auth/sign-in/email`, {
                method: "POST",
                headers: { "content-type": "application/json", origin: BASE },
                body: JSON.stringify(credentials),
            }),
        );
        expect(res.status).toBe(403);
    });

    it("protects routes when basePath has no leading slash", async () => {
        const auth = betterAuth({
            baseURL: BASE,
            basePath: "api/auth",
            secret: "better-auth-test-secret-0123456789-0123456789",
            database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
            emailAndPassword: { enabled: true },
            rateLimit: { enabled: false },
            logger: { disabled: true },
            plugins: [altcha({ verifier: fastVerifier() })],
        });
        expect((await auth.handler(post("/sign-in/email", credentials))).status).toBe(403);
    });

    it("lets CORS preflights through", async () => {
        const { auth } = createAuth();
        const res = await auth.handler(
            new Request(`${BASE}/api/auth/sign-in/email`, { method: "OPTIONS", headers: { origin: BASE } }),
        );
        expect(res.status).not.toBe(403);
    });

    it("responds with 503 when the replay store fails", async () => {
        const verifier = fastVerifier({
            store: {
                claim: () => {
                    throw new Error("redis down");
                },
            },
            onStoreError: () => {},
        });
        const { auth } = createAuth({ verifier });
        const payload = await challengePayload(auth);
        const res = await auth.handler(post("/sign-in/email", credentials, { "x-altcha": payload }));
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ reason: "store_unavailable" });
    });

    it("shares replay protection with other users of the same verifier (e.g. the Nest guard)", async () => {
        const { auth, verifier } = createAuth();
        const payload = await challengePayload(auth);
        expect((await auth.handler(post("/sign-in/email", credentials, { "x-altcha": payload }))).status).toBe(401);
        expect(await verifier.verify(payload)).toEqual({ ok: false, reason: "replayed" });
    });
});
