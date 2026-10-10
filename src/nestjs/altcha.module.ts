import { DynamicModule, Module } from "@nestjs/common";
import type { FactoryProvider, ModuleMetadata } from "@nestjs/common";

import { createAltchaVerifier } from "../core/verifier";
import type { AltchaVerifier, AltchaVerifierOptions } from "../core/types";
import { AltchaGuard } from "./altcha.guard";
import { ALTCHA_VERIFIER } from "./constants";

type VerifierOrOptions = AltchaVerifier | AltchaVerifierOptions;

export interface AltchaModuleAsyncOptions {
    imports?: ModuleMetadata["imports"];
    inject?: FactoryProvider["inject"];
    useFactory: (...args: any[]) => VerifierOrOptions | Promise<VerifierOrOptions>;
}

function isVerifier(value: VerifierOrOptions): value is AltchaVerifier {
    return (
        typeof (value as AltchaVerifier).verify === "function" &&
        typeof (value as AltchaVerifier).createChallenge === "function"
    );
}

function toVerifier(value: VerifierOrOptions): AltchaVerifier {
    return isVerifier(value) ? value : createAltchaVerifier(value);
}

/**
 * Provides the verifier globally (token ALTCHA_VERIFIER) and thereby enables @RequireAltcha().
 * If you also use the Better Auth plugin, pass the same verifier instance here.
 */
@Module({})
export class AltchaModule {
    static forRoot(verifierOrOptions: VerifierOrOptions): DynamicModule {
        return {
            module: AltchaModule,
            global: true,
            providers: [{ provide: ALTCHA_VERIFIER, useValue: toVerifier(verifierOrOptions) }, AltchaGuard],
            exports: [ALTCHA_VERIFIER, AltchaGuard],
        };
    }

    static forRootAsync(options: AltchaModuleAsyncOptions): DynamicModule {
        return {
            module: AltchaModule,
            global: true,
            imports: options.imports ?? [],
            providers: [
                {
                    provide: ALTCHA_VERIFIER,
                    inject: options.inject ?? [],
                    useFactory: async (...args: unknown[]) => toVerifier(await options.useFactory(...args)),
                },
                AltchaGuard,
            ],
            exports: [ALTCHA_VERIFIER, AltchaGuard],
        };
    }
}
