# Changelog

All notable changes to this project are documented in this file. The project follows [Semantic Versioning](https://semver.org).

## 0.1.0 – unreleased

- Shared verifier (`createAltchaVerifier`) based on `altcha-lib` v2 with key signature, expiry and replay protection
- Replay stores for memory (`createMemoryReplayStore`) and Redis (`createRedisReplayStore`); store errors are rejected as `store_unavailable` (503)
- NestJS: `AltchaModule.forRoot` / `forRootAsync`, `@RequireAltcha()`, `AltchaGuard`, `@InjectAltchaVerifier()`
- Better Auth: plugin `altcha()` at `@tayho/nestjs-altcha/better-auth` with a challenge endpoint and protection of configurable auth routes (paths resolved relative to `baseURL` like the Better Auth router; CORS preflights are not checked)
- Tested with NestJS 12, Better Auth 1.7.7 and the ALTCHA widget 3.3
