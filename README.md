# @tayho/nestjs-altcha

[![npm](https://img.shields.io/npm/v/@tayho/nestjs-altcha)](https://www.npmjs.com/package/@tayho/nestjs-altcha)
[![CI](https://github.com/TayhoSolutions/nestjs-altcha/actions/workflows/ci.yml/badge.svg)](https://github.com/TayhoSolutions/nestjs-altcha/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Bot protection for NestJS with [ALTCHA](https://altcha.org) – self-hosted, no third-party service, no cookies. The browser solves a small proof-of-work challenge in the background; your backend verifies the solution and claims it so it cannot be reused.

The package offers two integrations on top of **one** shared verifier:

| Integration | Import | Protects |
|-------------|--------|----------|
| Nest guard `@RequireAltcha()` | `@tayho/nestjs-altcha` | your own controller routes, e.g. `POST /public/bookings` |
| Better Auth plugin `altcha()` | `@tayho/nestjs-altcha/better-auth` | Better Auth routes, e.g. magic link, email OTP, sign-in |

Both share configuration and replay protection: a solution is accepted exactly once, no matter which route it is used on. Better Auth is an optional peer dependency – without it you only use the main entry point.

This is an independent community package and is not affiliated with the ALTCHA project.

## Requirements

- Node.js ≥ 22.12 (Better Auth is ESM-only and is loaded from CommonJS via `require(esm)`)
- `@nestjs/common` 11 or 12
- optionally `better-auth` ≥ 1.7
- TypeScript with `moduleResolution` set to `node16`, `nodenext` or `bundler` (for the `/better-auth` subpath)
- the [`altcha`](https://www.npmjs.com/package/altcha) widget ≥ 3 in the frontend

## Installation

```sh
npm install @tayho/nestjs-altcha
```

## Quick start

### 1. Register the verifier

```ts
import { AltchaModule } from "@tayho/nestjs-altcha";

@Module({
    imports: [
        AltchaModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                // one secret per application, at least 32 characters
                hmacSecret: config.getOrThrow<string>("ALTCHA_HMAC_SECRET"),
            }),
        }),
    ],
})
export class AppModule {}
```

The module is global. `AltchaModule.forRoot(verifierOrOptions)` is available as well if you create the verifier yourself.

### 2. Protect routes

```ts
import { RequireAltcha } from "@tayho/nestjs-altcha";

@Controller("public/bookings")
export class PublicBookingController {
    @RequireAltcha()
    @Post()
    createBooking(@Body() dto: CreateBookingDto) {
        // …
    }
}
```

`@RequireAltcha()` also works on the controller class. The guard runs after global guards (session, rate limiting) and before pipes. It reads the solution from the `x-altcha` header, falling back to the `altcha` body field (JSON or `application/x-www-form-urlencoded`). The body field is removed before validation so that strict schemas do not reject it as an unknown key. The result is available in the handler as `request.altcha`.

- **Multipart uploads:** with `multipart/form-data` (Multer, `FileInterceptor`) the body is still empty when the guard runs. Send the solution in the header.
- **HTTP only:** in other contexts (WebSockets, microservices, GraphQL) the guard always rejects.

### 3a. Challenge endpoint with Better Auth

The plugin serves `<basePath>/altcha/challenge` (with the default base path: `/api/auth/altcha/challenge`) and protects the configured auth routes. Pass the same verifier instance as the Nest module – with [`@thallesp/nestjs-better-auth`](https://www.npmjs.com/package/@thallesp/nestjs-better-auth) via `inject`:

```ts
import { ALTCHA_VERIFIER, type AltchaVerifier } from "@tayho/nestjs-altcha";
import { altcha } from "@tayho/nestjs-altcha/better-auth";

BetterAuthModule.forRootAsync({
    inject: [ALTCHA_VERIFIER],
    useFactory: (verifier: AltchaVerifier) => ({
        auth: betterAuth({
            // …
            plugins: [
                altcha({
                    verifier,
                    endpoints: ["/sign-in/magic-link", "/email-otp/send-verification-otp", "/sign-in/email"],
                }),
            ],
        }),
    }),
});
```

- Without `endpoints`, `/sign-up/email`, `/sign-in/email`, `/sign-in/magic-link`, `/email-otp/send-verification-otp` and `/request-password-reset` are protected. A custom list replaces these entirely. A trailing `*` matches one segment, `**` any number of segments.
- The solution must be sent in the header. Better Auth endpoints accept JSON only; a body field is not evaluated.
- Only HTTP requests are checked (`onRequest`). Server-side calls via `auth.api.*` are not affected. `OPTIONS` and `HEAD` requests (CORS preflight) are not checked.
- Protected paths are resolved relative to the path of `baseURL`, exactly like the Better Auth router does. This also holds when `baseURL` or `BETTER_AUTH_URL` contains a path.
- The challenge endpoint requires no session, sends `Cache-Control: no-store` and is rate limited to 30 requests per minute (`challengeRateLimit`) when the Better Auth rate limiter is enabled. **Behind a reverse proxy**, Better Auth must be able to detect the client IP (`advanced.ipAddress.ipAddressHeaders`, e.g. `["x-real-ip"]` with Traefik). Otherwise all visitors share one counter, and a single client could block challenge requests – and with them every protected sign-in – for everybody.

### 3b. Challenge endpoint without Better Auth

```ts
import { InjectAltchaVerifier, type AltchaVerifier } from "@tayho/nestjs-altcha";

@Controller("public/altcha")
export class AltchaController {
    constructor(@InjectAltchaVerifier() private readonly verifier: AltchaVerifier) {}

    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    @Header("Cache-Control", "no-store")
    @Get("challenge")
    challenge() {
        return this.verifier.createChallenge();
    }
}
```

### 4. Frontend

```html
<altcha-widget challenge="/api/auth/altcha/challenge" auto="onload"></altcha-widget>
<script type="module">import "altcha";</script>
```

The widget stores the solution in a hidden `altcha` input. For classic form posts that is all you need. For JSON requests send it as a header:

```ts
const payload = (document.querySelector('input[name="altcha"]') as HTMLInputElement).value;

await fetch("/api/public/bookings", {
    method: "POST",
    headers: { "content-type": "application/json", "x-altcha": payload },
    body: JSON.stringify(data),
});
await authClient.signIn.magicLink({ email }, { headers: { "x-altcha": payload } });
```

Each solution is accepted only once. After a failed request, reset the widget (`widget.reset()`) so it fetches a new challenge.

## Configuration

Options for `createAltchaVerifier(options)` and `AltchaModule.forRoot(options)`:

| Option | Default | Description |
|--------|---------|-------------|
| `hmacSecret` | – | required, at least 32 characters, one secret per application |
| `algorithm` | `"PBKDF2/SHA-256"` | also `PBKDF2/SHA-384/512`, `SHA-256/384/512` |
| `cost` | `5000` | cost per attempt (PBKDF2: iterations) |
| `counter` | `{ min: 5000, max: 10000 }` | range of attempts the browser has to compute on average |
| `expiresInSeconds` | `600` | lifetime of a challenge |
| `store` | `createMemoryReplayStore()` | replay protection |
| `header` | `"x-altcha"` | header carrying the solution |
| `fieldName` | `"altcha"` | body field used as fallback |
| `maxPayloadLength` | `8192` | longer payloads are rejected without verification |
| `onStoreError` | `console.error` | called when the replay store throws, e.g. for your own logging |

The defaults for algorithm, cost and counter follow the recommendation of `altcha-lib`. Thanks to the key signature, server-side verification costs only a few HMAC computations, regardless of the difficulty.

**Solving time in the browser** grows roughly with `cost × counter`. Measured with the real widget v3 in headless Chromium on 2 CPU cores: defaults about 9 s, `counter` 1000–2000 about 1.3 s, 2000–4000 about 2.1 s. Current desktop browsers and phones with more cores are faster, older phones slower. With `auto="onload"` the widget computes while the visitor fills in the form. For short forms (email address only) choose a smaller `counter`.

## Replay protection

- **`createMemoryReplayStore({ maxSize })`** – in-process, the default. Sufficient for a single instance. A restart only opens a window for solutions whose challenge has not expired yet. Choose `maxSize` (default 10,000) well above the number of submissions within `expiresInSeconds`: when the limit is reached, expired entries are purged and then the oldest claim is evicted – that solution could be reused once.
- **`createRedisReplayStore(redis, { keyPrefix })`** – for multiple instances. Expects a client with `set(key, value, "EX", ttl, "NX")`, such as `ioredis`.

```ts
import Redis from "ioredis";
import { createRedisReplayStore } from "@tayho/nestjs-altcha";

const store = createRedisReplayStore(new Redis(redisUrl), { keyPrefix: "myapp:altcha:" });
```

Custom stores implement `claim(id, ttlSeconds)`: claim atomically and return `true` if the id was new.

Solutions are claimed only after successful verification, so failed attempts cannot fill up the store.

## Error responses

The Nest guard and the Better Auth plugin both respond with **403** when verification fails (**503** for `store_unavailable`):

```json
{ "code": "ALTCHA_FAILED", "reason": "replayed", "message": "ALTCHA verification failed" }
```

| `reason` | Meaning |
|----------|---------|
| `missing` | no solution in the request |
| `malformed` | not valid base64 JSON, wrong structure or too long |
| `expired` | challenge has expired |
| `invalid_signature` | challenge not issued by this server, or tampered with |
| `invalid_solution` | wrong solution |
| `replayed` | solution has already been used |
| `store_unavailable` | replay store unavailable (e.g. Redis outage); rejected because reuse could not be ruled out. Errors are passed to `onStoreError`. |

## What ALTCHA does – and what it does not

Proof of work makes automated requests more expensive; it does not prevent them. A determined attacker simply computes the challenges. Use ALTCHA in addition to server-side limits (rate limits per IP and per email address, business rules such as "one pending reservation per email"), not instead of them.

## Development

```sh
npm install
npm run typecheck
npm test               # Vitest: verifier, stores, Nest guard, Better Auth plugin
npm run build
npm run test:widget    # real widget v3 in Chromium against dist/ (set CHROMIUM_PATH)
```

`ALTCHA_COUNTER_MAX` and `ALTCHA_COST` let `test:widget` measure the solving time for other parameters.

## Releasing

Releases are published to npm by GitHub Actions (`.github/workflows/release.yml`) using [trusted publishing](https://docs.npmjs.com/trusted-publishers), with provenance.

1. Update `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Commit, then create and push a matching tag: `git tag v0.2.0 && git push origin main --tags`.
3. The workflow verifies that the tag matches `package.json`, runs type checks, tests and the build, and publishes.

## License

[MIT](./LICENSE) © Tayho Solutions
