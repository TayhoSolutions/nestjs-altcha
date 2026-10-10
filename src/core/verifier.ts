import { createHmac } from "node:crypto";

import { createChallenge, randomInt, verifySolution } from "altcha-lib";
import type { Challenge, DeriveKeyFunction, Payload } from "altcha-lib";
import { deriveKey as deriveKeyPbkdf2 } from "altcha-lib/algorithms/pbkdf2";
import { deriveKey as deriveKeySha } from "altcha-lib/algorithms/sha";

import { createMemoryReplayStore } from "./stores";
import type { AltchaAlgorithm, AltchaVerifier, AltchaVerifierOptions, AltchaVerifyResult } from "./types";

const DEFAULTS = {
    algorithm: "PBKDF2/SHA-256" as AltchaAlgorithm,
    cost: 5_000,
    counter: { min: 5_000, max: 10_000 },
    expiresInSeconds: 600,
    header: "x-altcha",
    fieldName: "altcha",
    maxPayloadLength: 8_192,
};

const MIN_SECRET_LENGTH = 32;

function deriveKeyFor(algorithm: AltchaAlgorithm): DeriveKeyFunction {
    return algorithm.startsWith("PBKDF2/") ? deriveKeyPbkdf2 : deriveKeySha;
}

/**
 * Derives a second secret for the key signature from the main secret
 * (deterministic mode: the server verifies a solution with a single HMAC computation).
 */
function deriveKeySignatureSecret(hmacSecret: string): string {
    return createHmac("sha256", hmacSecret).update("tayho-nestjs-altcha:key-signature").digest("hex");
}

function assertPositiveInteger(name: string, value: number) {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
}

/** Decodes the widget's base64 payload ({ challenge, solution }) and checks its structure */
function parsePayload(payload: string): Payload | null {
    let decoded: unknown;
    try {
        decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    } catch {
        return null;
    }
    if (!decoded || typeof decoded !== "object") return null;
    const { challenge, solution } = decoded as Partial<Payload>;
    if (
        !challenge ||
        typeof challenge !== "object" ||
        !challenge.parameters ||
        typeof challenge.parameters !== "object"
    ) {
        return null;
    }
    if (!solution || typeof solution !== "object") return null;
    if (typeof challenge.parameters.nonce !== "string" || challenge.parameters.nonce.length === 0) return null;
    return { challenge, solution } as Payload;
}

/**
 * Creates the shared verifier of an application. Pass the same instance to the Nest module and to the
 * Better Auth plugin so that configuration and replay protection are identical everywhere.
 */
export function createAltchaVerifier(options: AltchaVerifierOptions): AltchaVerifier {
    if (typeof options.hmacSecret !== "string" || options.hmacSecret.length < MIN_SECRET_LENGTH) {
        throw new Error(`hmacSecret must be a string with at least ${MIN_SECRET_LENGTH} characters`);
    }

    const algorithm = options.algorithm ?? DEFAULTS.algorithm;
    const cost = options.cost ?? DEFAULTS.cost;
    const counter = options.counter ?? DEFAULTS.counter;
    const expiresInSeconds = options.expiresInSeconds ?? DEFAULTS.expiresInSeconds;
    const maxPayloadLength = options.maxPayloadLength ?? DEFAULTS.maxPayloadLength;
    const header = (options.header ?? DEFAULTS.header).toLowerCase();
    const fieldName = options.fieldName ?? DEFAULTS.fieldName;
    const store = options.store ?? createMemoryReplayStore();
    const onStoreError =
        options.onStoreError ?? ((err: unknown) => console.error("[nestjs-altcha] replay store error", err));

    assertPositiveInteger("cost", cost);
    assertPositiveInteger("expiresInSeconds", expiresInSeconds);
    assertPositiveInteger("maxPayloadLength", maxPayloadLength);
    if (
        !Number.isInteger(counter.min) ||
        counter.min < 0 ||
        !Number.isInteger(counter.max) ||
        counter.max < counter.min
    ) {
        throw new Error("counter must satisfy 0 <= min <= max (integers)");
    }

    const deriveKey = deriveKeyFor(algorithm);
    const hmacSignatureSecret = options.hmacSecret;
    const hmacKeySignatureSecret = deriveKeySignatureSecret(options.hmacSecret);

    return {
        header,
        fieldName,

        async createChallenge(data) {
            return createChallenge({
                algorithm,
                cost,
                counter: randomInt(counter.min, counter.max),
                deriveKey,
                expiresAt: Math.floor(Date.now() / 1000) + expiresInSeconds,
                hmacSignatureSecret,
                hmacKeySignatureSecret,
                ...(data ? { data } : {}),
            });
        },

        async verify(payload): Promise<AltchaVerifyResult> {
            if (payload === undefined || payload === null || payload === "") return { ok: false, reason: "missing" };
            if (typeof payload !== "string" || payload.length > maxPayloadLength)
                return { ok: false, reason: "malformed" };

            const parsed = parsePayload(payload);
            if (!parsed) return { ok: false, reason: "malformed" };

            const { parameters } = parsed.challenge;
            // Our own challenges always carry an expiry and the algorithm; both are covered by the signature.
            if (typeof parameters.expiresAt !== "number" || parameters.algorithm !== algorithm) {
                return { ok: false, reason: "invalid_signature" };
            }

            let result;
            try {
                result = await verifySolution({
                    challenge: parsed.challenge as Challenge,
                    solution: parsed.solution,
                    deriveKey,
                    hmacSignatureSecret,
                    hmacKeySignatureSecret,
                });
            } catch {
                return { ok: false, reason: "malformed" };
            }

            if (result.expired) return { ok: false, reason: "expired" };
            if (result.invalidSignature) return { ok: false, reason: "invalid_signature" };
            if (!result.verified) return { ok: false, reason: "invalid_solution" };

            // Claim only after successful verification: failed attempts cannot fill up the store.
            const ttlSeconds = Math.max(1, Math.ceil(parameters.expiresAt - Date.now() / 1000));
            const challengeId = parameters.nonce;
            let claimed: boolean;
            try {
                claimed = await store.claim(challengeId, ttlSeconds);
            } catch (err) {
                // Never accept without replay protection (fail closed); the caller responds with 503.
                onStoreError(err);
                return { ok: false, reason: "store_unavailable" };
            }
            if (!claimed) return { ok: false, reason: "replayed" };

            return { ok: true, challengeId, ...(parameters.data ? { data: parameters.data } : {}) };
        },
    };
}
