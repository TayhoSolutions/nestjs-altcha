import Redis from "ioredis";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { createMemoryReplayStore, createRedisReplayStore } from "../src";
import type { RedisSetNxClient } from "../src";

afterEach(() => {
    vi.useRealTimers();
});

describe("createMemoryReplayStore", () => {
    it("claims an id until it expires", () => {
        vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
        const store = createMemoryReplayStore();
        expect(store.claim("a", 10)).toBe(true);
        expect(store.claim("a", 10)).toBe(false);

        vi.setSystemTime(1_000_000 + 10_001);
        expect(store.claim("a", 10)).toBe(true);
    });

    it("evicts the oldest claim on overflow", () => {
        const store = createMemoryReplayStore({ maxSize: 2 });
        expect(store.claim("a", 60)).toBe(true);
        expect(store.claim("b", 60)).toBe(true);
        expect(store.claim("c", 60)).toBe(true);
        expect(store.claim("a", 60)).toBe(true); // "a" was evicted
        expect(store.claim("c", 60)).toBe(false);
    });

    it("rejects invalid sizes", () => {
        expect(() => createMemoryReplayStore({ maxSize: 0 })).toThrow();
    });
});

describe("createRedisReplayStore", () => {
    it("uses SET NX EX with prefix and rounded TTL", async () => {
        const set = vi.fn().mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
        const store = createRedisReplayStore({ set }, { keyPrefix: "myapp:altcha:" });

        expect(await store.claim("nonce", 12.2)).toBe(true);
        expect(await store.claim("nonce", 12.2)).toBe(false);
        expect(set).toHaveBeenCalledWith("myapp:altcha:nonce", "1", "EX", 13, "NX");
    });

    it("matches the ioredis interface", () => {
        expectTypeOf<Redis>().toExtend<RedisSetNxClient>();
    });
});
