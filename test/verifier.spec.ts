import { afterEach, describe, expect, it, vi } from "vitest";

import { createAltchaVerifier } from "../src";
import { fastVerifier, mutatePayload, SECRET, solve } from "./helpers";

afterEach(() => {
    vi.useRealTimers();
});

describe("createAltchaVerifier – configuration", () => {
    it("rejects secrets that are too short", () => {
        expect(() => createAltchaVerifier({ hmacSecret: "short" })).toThrow(/at least 32/);
    });

    it("rejects invalid numeric values", () => {
        expect(() => createAltchaVerifier({ hmacSecret: SECRET, cost: 0 })).toThrow(/cost/);
        expect(() => createAltchaVerifier({ hmacSecret: SECRET, expiresInSeconds: 1.5 })).toThrow(/expiresInSeconds/);
        expect(() => createAltchaVerifier({ hmacSecret: SECRET, counter: { min: 10, max: 5 } })).toThrow(/counter/);
    });

    it("uses the default header and field", () => {
        const verifier = createAltchaVerifier({ hmacSecret: SECRET });
        expect(verifier.header).toBe("x-altcha");
        expect(verifier.fieldName).toBe("altcha");
    });

    it("lower-cases the header", () => {
        expect(createAltchaVerifier({ hmacSecret: SECRET, header: "X-Bot-Check" }).header).toBe("x-bot-check");
    });

    it("creates challenges with the default parameters (PBKDF2/SHA-256, cost 5000, expiry in 10 minutes)", async () => {
        const verifier = createAltchaVerifier({ hmacSecret: SECRET });
        const challenge = await verifier.createChallenge();
        expect(challenge.parameters.algorithm).toBe("PBKDF2/SHA-256");
        expect(challenge.parameters.cost).toBe(5000);
        expect(challenge.parameters.keySignature).toBeTruthy();
        expect(challenge.signature).toBeTruthy();
        const secondsLeft = (challenge.parameters.expiresAt ?? 0) - Date.now() / 1000;
        expect(secondsLeft).toBeGreaterThan(590);
        expect(secondsLeft).toBeLessThanOrEqual(600);
    });
});

describe("verify", () => {
    it("accepts a correct solution exactly once", async () => {
        const verifier = fastVerifier();
        const payload = await solve(await verifier.createChallenge());

        const first = await verifier.verify(payload);
        expect(first.ok).toBe(true);

        expect(await verifier.verify(payload)).toEqual({ ok: false, reason: "replayed" });
    });

    it("returns embedded data", async () => {
        const verifier = fastVerifier();
        const payload = await solve(await verifier.createChallenge({ form: "booking" }));
        expect(await verifier.verify(payload)).toMatchObject({ ok: true, data: { form: "booking" } });
    });

    it("also works with SHA-256", async () => {
        const verifier = fastVerifier({ algorithm: "SHA-256", cost: 1 });
        const payload = await solve(await verifier.createChallenge());
        expect((await verifier.verify(payload)).ok).toBe(true);
    });

    it.each([
        ["undefined", undefined, "missing"],
        ["null", null, "missing"],
        ["an empty string", "", "missing"],
        ["a number", 42, "malformed"],
        ["non-base64 JSON", "not-base64-json!!", "malformed"],
        [
            "JSON without the expected structure",
            Buffer.from(JSON.stringify({ foo: 1 })).toString("base64"),
            "malformed",
        ],
    ])("rejects %s", async (_name, payload, reason) => {
        expect(await fastVerifier().verify(payload)).toEqual({ ok: false, reason });
    });

    it("rejects payloads that are too long without verifying them", async () => {
        const verifier = fastVerifier({ maxPayloadLength: 100 });
        expect(await verifier.verify("a".repeat(101))).toEqual({ ok: false, reason: "malformed" });
    });

    it("rejects solutions to challenges signed with another secret", async () => {
        const other = fastVerifier({ hmacSecret: "another-secret-0123456789-0123456789-xyz" });
        const payload = await solve(await other.createChallenge());
        expect(await fastVerifier().verify(payload)).toEqual({ ok: false, reason: "invalid_signature" });
    });

    it("rejects tampered parameters", async () => {
        const verifier = fastVerifier();
        const payload = await solve(await verifier.createChallenge());
        const tampered = mutatePayload(payload, (d) => {
            d.challenge.parameters.expiresAt += 3600;
        });
        expect(await verifier.verify(tampered)).toEqual({ ok: false, reason: "invalid_signature" });
    });

    it("rejects challenges without an expiry", async () => {
        const verifier = fastVerifier();
        const payload = await solve(await verifier.createChallenge());
        const tampered = mutatePayload(payload, (d) => {
            delete d.challenge.parameters.expiresAt;
        });
        expect(await verifier.verify(tampered)).toEqual({ ok: false, reason: "invalid_signature" });
    });

    it("rejects a wrong solution", async () => {
        const verifier = fastVerifier();
        const payload = await solve(await verifier.createChallenge());
        const wrong = mutatePayload(payload, (d) => {
            d.solution.derivedKey = "00".repeat(32);
        });
        expect(await verifier.verify(wrong)).toEqual({ ok: false, reason: "invalid_solution" });
    });

    it("rejects expired challenges", async () => {
        const verifier = fastVerifier({ expiresInSeconds: 60 });
        const payload = await solve(await verifier.createChallenge());
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61_000 });
        expect(await verifier.verify(payload)).toEqual({ ok: false, reason: "expired" });
    });

    it("rejects when the replay store fails (fail closed)", async () => {
        const onStoreError = vi.fn();
        const verifier = fastVerifier({
            store: {
                claim: () => {
                    throw new Error("redis down");
                },
            },
            onStoreError,
        });
        const payload = await solve(await verifier.createChallenge());
        expect(await verifier.verify(payload)).toEqual({ ok: false, reason: "store_unavailable" });
        expect(onStoreError).toHaveBeenCalledWith(expect.objectContaining({ message: "redis down" }));
    });

    it("claims only successfully verified solutions", async () => {
        const claim = vi.fn().mockReturnValue(true);
        const verifier = fastVerifier({ store: { claim } });
        const payload = await solve(await verifier.createChallenge());
        await verifier.verify(mutatePayload(payload, (d) => (d.solution.derivedKey = "00".repeat(32))));
        expect(claim).not.toHaveBeenCalled();

        await verifier.verify(payload);
        expect(claim).toHaveBeenCalledTimes(1);
        const [id, ttl] = claim.mock.calls[0]!;
        expect(typeof id).toBe("string");
        expect(ttl).toBeGreaterThan(590);
        expect(ttl).toBeLessThanOrEqual(600);
    });
});
