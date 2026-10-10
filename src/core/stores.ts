import type { AltchaReplayStore } from "./types";

export interface MemoryReplayStoreOptions {
    /**
     * Maximum number of simultaneously claimed solutions. When reached, the oldest claim is evicted.
     * Choose it well above the expected submissions within the challenge lifetime.
     * Default: 10000
     */
    maxSize?: number;
}

/**
 * In-process replay protection.
 *
 * Sufficient for a single instance. Claims are lost on restart, which only opens a window for solutions
 * whose challenge has not expired yet. Use createRedisReplayStore() for multiple instances.
 */
export function createMemoryReplayStore(options: MemoryReplayStoreOptions = {}): AltchaReplayStore {
    const maxSize = options.maxSize ?? 10_000;
    if (!Number.isInteger(maxSize) || maxSize < 1) {
        throw new Error("maxSize must be a positive integer");
    }
    /** id → expiry timestamp (ms); Map keeps insertion order (oldest first) */
    const entries = new Map<string, number>();

    const purgeExpired = (now: number) => {
        for (const [id, expiresAt] of entries) {
            // Entries are ordered by insertion time and remaining lifetimes are similar. Stop at the first
            // valid entry – remaining expired ones are removed by a later call or by the maxSize purge.
            if (expiresAt > now) break;
            entries.delete(id);
        }
    };

    return {
        claim(id, ttlSeconds) {
            const now = Date.now();
            purgeExpired(now);
            const existing = entries.get(id);
            if (existing !== undefined && existing > now) return false;

            entries.delete(id);
            entries.set(id, now + Math.max(1, ttlSeconds) * 1000);
            if (entries.size > maxSize) {
                // Remove all expired entries before evicting (lifetimes are not strictly ordered by
                // insertion time), so that valid claims are evicted as rarely as possible.
                for (const [key, expiresAt] of entries) if (expiresAt <= now) entries.delete(key);
            }
            while (entries.size > maxSize) {
                const oldest = entries.keys().next().value as string;
                entries.delete(oldest);
            }
            return true;
        },
    };
}

/**
 * Minimal Redis interface (matches ioredis): `SET key value EX ttl NX`.
 * Returns "OK" if the key was newly set, otherwise null.
 */
export interface RedisSetNxClient {
    set(key: string, value: string, secondsToken: "EX", seconds: number, nx: "NX"): Promise<string | null>;
}

export interface RedisReplayStoreOptions {
    /** Prefix of the Redis keys, e.g. "myapp:altcha:". Default: "altcha:used:" */
    keyPrefix?: string;
}

/** Replay protection in Redis – atomic via SET NX EX, shared by all instances */
export function createRedisReplayStore(
    client: RedisSetNxClient,
    options: RedisReplayStoreOptions = {},
): AltchaReplayStore {
    const keyPrefix = options.keyPrefix ?? "altcha:used:";
    return {
        async claim(id, ttlSeconds) {
            const result = await client.set(`${keyPrefix}${id}`, "1", "EX", Math.max(1, Math.ceil(ttlSeconds)), "NX");
            return result === "OK";
        },
    };
}
