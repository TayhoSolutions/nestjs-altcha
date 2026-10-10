import { solveChallenge } from "altcha-lib";
import type { Challenge } from "altcha-lib";
import { deriveKey as deriveKeyPbkdf2 } from "altcha-lib/algorithms/pbkdf2";
import { deriveKey as deriveKeySha } from "altcha-lib/algorithms/sha";

import { createAltchaVerifier } from "../src";
import type { AltchaVerifierOptions } from "../src";

export const SECRET = "test-secret-0123456789-0123456789-abcdef";

/** Verifier with very low difficulty so that the tests run fast */
export function fastVerifier(overrides: Partial<AltchaVerifierOptions> = {}) {
    return createAltchaVerifier({ hmacSecret: SECRET, cost: 1, counter: { min: 0, max: 20 }, ...overrides });
}

/** Solves a challenge like the widget does and returns the base64 payload */
export async function solve(challenge: Challenge): Promise<string> {
    const deriveKey = challenge.parameters.algorithm.startsWith("PBKDF2/") ? deriveKeyPbkdf2 : deriveKeySha;
    const solution = await solveChallenge({ challenge, deriveKey });
    if (!solution) throw new Error("challenge could not be solved");
    const { codeChallenge: _ignored, ...rest } = challenge;
    return Buffer.from(JSON.stringify({ challenge: rest, solution })).toString("base64");
}

/** Decodes a payload, mutates it and encodes it again */
export function mutatePayload(payload: string, mutate: (decoded: any) => void): string {
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    mutate(decoded);
    return Buffer.from(JSON.stringify(decoded)).toString("base64");
}
