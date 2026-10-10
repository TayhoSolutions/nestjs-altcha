import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";

import { ALTCHA_ERROR_CODE } from "../core/constants";
import type { AltchaVerifier } from "../core/types";

/** Paths (relative to the Better Auth base path) that require a solution by default */
export const DEFAULT_ALTCHA_ENDPOINTS: readonly string[] = [
    "/sign-up/email",
    "/sign-in/email",
    "/sign-in/magic-link",
    "/email-otp/send-verification-otp",
    "/request-password-reset",
];

export interface AltchaPluginOptions {
    /** The same instance as in the Nest module (shared configuration and shared replay protection) */
    verifier: AltchaVerifier;
    /**
     * Protected paths relative to the base path. Replaces the default list entirely.
     * Supports a trailing `*` (one segment) and `**` (any number of segments), e.g. "/sign-in/*".
     */
    endpoints?: readonly string[];
    /**
     * Rate limit of the challenge endpoint (applies when the Better Auth rate limiter is enabled). Default: 30 per 60 s.
     * Requires Better Auth to detect the client IP (behind a proxy configure `advanced.ipAddress`);
     * otherwise all visitors share a single counter.
     */
    challengeRateLimit?: { window: number; max: number };
}

const CHALLENGE_PATH = "/altcha/challenge";

/** Methods without a body that never trigger a protected action (CORS preflight, HEAD) */
const UNCHECKED_METHODS = new Set(["OPTIONS", "HEAD"]);

/**
 * Determines the base path exactly like the Better Auth router does: from the path of `ctx.baseURL`.
 * `options.basePath` alone is not enough – Better Auth ignores it when baseURL (or BETTER_AUTH_URL)
 * contains a path itself.
 */
function resolveBasePath(ctx: { baseURL?: string; options: { basePath?: string } }): string {
    if (ctx.baseURL) {
        try {
            return new URL(ctx.baseURL).pathname;
        } catch {
            // invalid baseURL: fall back to the option
        }
    }
    return ctx.options.basePath ?? "/api/auth";
}

function normalizePath(pathname: string, rawBasePath: string): string {
    const basePath = rawBasePath.replace(/\/+$/, "");
    let path = basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
    path = path.replace(/\/{2,}/g, "/");
    if (!path.startsWith("/")) path = `/${path}`;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return path;
}

function matchesEndpoint(pattern: string, path: string): boolean {
    if (pattern.endsWith("/**")) {
        const prefix = pattern.slice(0, -3);
        return path === prefix || path.startsWith(`${prefix}/`);
    }
    if (pattern.endsWith("/*")) {
        const prefix = pattern.slice(0, -2);
        if (!path.startsWith(`${prefix}/`)) return false;
        const rest = path.slice(prefix.length + 1);
        return rest.length > 0 && !rest.includes("/");
    }
    return pattern === path;
}

function failure(reason: string): { response: Response } {
    return {
        response: new Response(
            JSON.stringify({ code: ALTCHA_ERROR_CODE, reason, message: "ALTCHA verification failed" }),
            {
                status: reason === "store_unavailable" ? 503 : 403,
                headers: { "Content-Type": "application/json" },
            },
        ),
    };
}

/**
 * Better Auth plugin: requires a valid ALTCHA solution in a header (default `x-altcha`) for the configured
 * auth routes and serves challenges at `<basePath>/altcha/challenge`.
 *
 * Verification happens in `onRequest`, i.e. for HTTP requests only. Server-side calls via `auth.api.*`
 * (e.g. from your own services) are not affected.
 */
export const altcha = (options: AltchaPluginOptions) => {
    const { verifier } = options;
    const endpoints = options.endpoints ?? DEFAULT_ALTCHA_ENDPOINTS;
    const rateLimit = options.challengeRateLimit ?? { window: 60, max: 30 };

    return {
        id: "altcha",
        endpoints: {
            altchaChallenge: createAuthEndpoint(
                CHALLENGE_PATH,
                { method: "GET", metadata: { noStore: true } },
                async (ctx) => ctx.json(await verifier.createChallenge()),
            ),
        },
        onRequest: async (request, ctx) => {
            if (UNCHECKED_METHODS.has(request.method.toUpperCase())) return;
            const path = normalizePath(new URL(request.url).pathname, resolveBasePath(ctx));
            if (!endpoints.some((pattern) => matchesEndpoint(pattern, path))) return;

            const result = await verifier.verify(request.headers.get(verifier.header) ?? undefined);
            if (!result.ok) return failure(result.reason);
        },
        rateLimit: [{ pathMatcher: (path: string) => path === CHALLENGE_PATH, ...rateLimit }],
    } satisfies BetterAuthPlugin;
};

export type { AltchaVerifier };
