import type { Challenge } from "altcha-lib";

/** Supported key derivation functions (Argon2id and scrypt not yet: they need additional memory and parallelism parameters) */
export type AltchaAlgorithm =
    "PBKDF2/SHA-256" | "PBKDF2/SHA-384" | "PBKDF2/SHA-512" | "SHA-256" | "SHA-384" | "SHA-512";

/**
 * Storage for solutions that have already been used (replay protection).
 *
 * `claim` must be atomic: it returns `true` if the id was new and is now claimed, otherwise `false`.
 * The claim must last at least `ttlSeconds` (until the challenge expires).
 */
export interface AltchaReplayStore {
    claim(id: string, ttlSeconds: number): boolean | Promise<boolean>;
}

export interface AltchaVerifierOptions {
    /**
     * Secret used to sign challenges. At least 32 characters, one per application.
     * A second secret for the key signature (fast verification) is derived from it.
     */
    hmacSecret: string;
    /** Default: "PBKDF2/SHA-256" */
    algorithm?: AltchaAlgorithm;
    /** Cost per attempt (PBKDF2: iterations). Default: 5000 */
    cost?: number;
    /**
     * Range from which the solution counter is picked at random (deterministic mode).
     * On average the browser has to compute this many attempts. Default: { min: 5000, max: 10000 }
     */
    counter?: { min: number; max: number };
    /** Lifetime of a challenge in seconds. Default: 600 */
    expiresInSeconds?: number;
    /** Replay protection. Default: createMemoryReplayStore() */
    store?: AltchaReplayStore;
    /** HTTP header carrying the solution. Default: "x-altcha" */
    header?: string;
    /** Form or JSON field carrying the solution (fallback when no header is set). Default: "altcha" */
    fieldName?: string;
    /** Longer payloads are rejected without verification. Default: 8192 */
    maxPayloadLength?: number;
    /** Called when the replay store throws (e.g. for your own logging). Default: console.error */
    onStoreError?: (error: unknown) => void;
}

/** Reasons for a failed verification */
export type AltchaFailureReason =
    /** no solution in the request */
    | "missing"
    /** not valid base64/JSON, wrong structure or too long */
    | "malformed"
    /** challenge has expired */
    | "expired"
    /** signature does not match (different secret or tampered challenge) */
    | "invalid_signature"
    /** wrong solution */
    | "invalid_solution"
    /** solution has already been used */
    | "replayed"
    /** replay store unavailable (e.g. Redis outage) – the request is rejected */
    | "store_unavailable";

export type AltchaVerifyResult =
    | { ok: true; challengeId: string; data?: Record<string, string | number | boolean | null> }
    | { ok: false; reason: AltchaFailureReason };

export interface AltchaVerifier {
    /** Header from which the guard and the Better Auth plugin read the solution (lower case) */
    readonly header: string;
    /** Body field name (fallback for forms without a custom header) */
    readonly fieldName: string;
    /** Creates a new signed challenge for the widget */
    createChallenge(data?: Record<string, string | number | boolean | null>): Promise<Challenge>;
    /** Verifies a solution (the widget's base64 payload) and claims it against reuse */
    verify(payload: unknown): Promise<AltchaVerifyResult>;
}

export type { Challenge };
