import type { AltchaVerifier } from "../core/types";

interface RequestLike {
    headers?: Record<string, string | string[] | undefined>;
    body?: unknown;
}

/**
 * Reads the solution from the header (preferred) or from the body field. The body field is removed so
 * that strict validation schemas (e.g. Zod `.strict()`) do not reject it as an unknown key.
 */
export function takeAltchaPayload(req: RequestLike, verifier: AltchaVerifier): string | undefined {
    const headerValue = req.headers?.[verifier.header];
    const fromHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    let fromBody: string | undefined;
    const body = req.body;
    if (body && typeof body === "object" && verifier.fieldName in body) {
        const value = (body as Record<string, unknown>)[verifier.fieldName];
        if (typeof value === "string") fromBody = value;
        delete (body as Record<string, unknown>)[verifier.fieldName];
    }

    return fromHeader || fromBody || undefined;
}
