import "reflect-metadata";

import { Body, Controller, Get, INestApplication, Injectable, Module, Post, Req } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { ALTCHA_VERIFIER, AltchaModule, InjectAltchaVerifier, RequireAltcha } from "../src";
import type { AltchaVerifier, AltchaVerifyResult } from "../src";
import { fastVerifier, SECRET, solve } from "./helpers";

@Controller()
class TestController {
    constructor(@InjectAltchaVerifier() private readonly verifier: AltchaVerifier) {}

    @Get("challenge")
    challenge() {
        return this.verifier.createChallenge();
    }

    @RequireAltcha()
    @Post("submit")
    submit(@Body() body: Record<string, unknown>, @Req() req: { altcha?: AltchaVerifyResult }) {
        return { body, altcha: req.altcha };
    }

    @Post("open")
    open() {
        return { ok: true };
    }
}

@RequireAltcha()
@Controller("protected")
class ProtectedController {
    @Post()
    create() {
        return { created: true };
    }
}

let app: INestApplication | undefined;

afterEach(async () => {
    await app?.close();
    app = undefined;
});

async function createApp(altchaModule: ReturnType<typeof AltchaModule.forRoot>) {
    const moduleRef = await Test.createTestingModule({
        imports: [altchaModule],
        controllers: [TestController, ProtectedController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return app;
}

async function payloadFrom(nestApp: INestApplication) {
    const res = await request(nestApp.getHttpServer()).get("/challenge").expect(200);
    return solve(res.body);
}

describe("AltchaModule + @RequireAltcha()", () => {
    it("rejects requests without a solution with 403 and an error code", async () => {
        const nestApp = await createApp(AltchaModule.forRoot(fastVerifier()));
        const res = await request(nestApp.getHttpServer()).post("/submit").send({ name: "x" }).expect(403);
        expect(res.body).toMatchObject({ code: "ALTCHA_FAILED", reason: "missing" });
    });

    it("accepts a solution in the header exactly once", async () => {
        const nestApp = await createApp(AltchaModule.forRoot(fastVerifier()));
        const payload = await payloadFrom(nestApp);

        const ok = await request(nestApp.getHttpServer())
            .post("/submit")
            .set("x-altcha", payload)
            .send({ name: "x" })
            .expect(201);
        expect(ok.body.altcha.ok).toBe(true);
        expect(ok.body.body).toEqual({ name: "x" });

        const replay = await request(nestApp.getHttpServer())
            .post("/submit")
            .set("x-altcha", payload)
            .send({})
            .expect(403);
        expect(replay.body.reason).toBe("replayed");
    });

    it("accepts a solution in the body field and removes the field before the handler", async () => {
        const nestApp = await createApp(AltchaModule.forRoot(fastVerifier()));
        const payload = await payloadFrom(nestApp);

        const res = await request(nestApp.getHttpServer())
            .post("/submit")
            .send({ name: "x", altcha: payload })
            .expect(201);
        expect(res.body.body).toEqual({ name: "x" });
    });

    it("protects all routes of a controller when the decorator is on the class", async () => {
        const nestApp = await createApp(AltchaModule.forRoot(fastVerifier()));
        await request(nestApp.getHttpServer()).post("/protected").expect(403);
        const payload = await payloadFrom(nestApp);
        await request(nestApp.getHttpServer()).post("/protected").set("x-altcha", payload).expect(201);
    });

    it("responds with 503 when the replay store fails", async () => {
        const verifier = fastVerifier({
            store: {
                claim: async () => {
                    throw new Error("redis down");
                },
            },
            onStoreError: () => {},
        });
        const nestApp = await createApp(AltchaModule.forRoot(verifier));
        const payload = await payloadFrom(nestApp);
        const res = await request(nestApp.getHttpServer()).post("/submit").set("x-altcha", payload).expect(503);
        expect(res.body).toMatchObject({ code: "ALTCHA_FAILED", reason: "store_unavailable" });
    });

    it("leaves routes without the decorator untouched", async () => {
        const nestApp = await createApp(AltchaModule.forRoot(fastVerifier()));
        await request(nestApp.getHttpServer()).post("/open").expect(201);
    });

    it("accepts options instead of an instance", async () => {
        const nestApp = await createApp(
            AltchaModule.forRoot({ hmacSecret: SECRET, cost: 1, counter: { min: 0, max: 10 } }),
        );
        const payload = await payloadFrom(nestApp);
        await request(nestApp.getHttpServer()).post("/submit").set("x-altcha", payload).expect(201);
    });

    it("provides the verifier globally, e.g. for the factory of the Better Auth module", async () => {
        const verifier = fastVerifier();
        @Module({
            providers: [
                { provide: "AUTH_INSTANCE", inject: [ALTCHA_VERIFIER], useFactory: (v: AltchaVerifier) => ({ v }) },
            ],
            exports: ["AUTH_INSTANCE"],
        })
        class FakeAuthModule {}

        const moduleRef = await Test.createTestingModule({
            imports: [AltchaModule.forRoot(verifier), FakeAuthModule],
        }).compile();
        expect(moduleRef.get<{ v: AltchaVerifier }>("AUTH_INSTANCE").v).toBe(verifier);
        await moduleRef.close();
    });

    it("supports forRootAsync with injected providers", async () => {
        @Injectable()
        class FakeConfig {
            get(key: string) {
                return key === "ALTCHA_HMAC_SECRET" ? SECRET : undefined;
            }
        }
        @Module({ providers: [FakeConfig], exports: [FakeConfig] })
        class FakeConfigModule {}

        const nestApp = await createApp(
            AltchaModule.forRootAsync({
                imports: [FakeConfigModule],
                inject: [FakeConfig],
                useFactory: (config: FakeConfig) => ({
                    hmacSecret: config.get("ALTCHA_HMAC_SECRET")!,
                    cost: 1,
                    counter: { min: 0, max: 10 },
                }),
            }),
        );
        const payload = await payloadFrom(nestApp);
        await request(nestApp.getHttpServer()).post("/submit").set("x-altcha", payload).expect(201);
    });
});
