import { applyDecorators, Inject, UseGuards } from "@nestjs/common";

import { AltchaGuard } from "./altcha.guard";
import { ALTCHA_VERIFIER } from "./constants";

/**
 * Requires a valid ALTCHA solution for the route, or for all routes of a controller.
 *
 * @example
 * @AllowAnonymous()
 * @RequireAltcha()
 * @Post()
 * createBooking(...) {}
 */
export function RequireAltcha(): MethodDecorator & ClassDecorator {
    return applyDecorators(UseGuards(AltchaGuard));
}

/** Injects the verifier, e.g. for your own challenge endpoint */
export function InjectAltchaVerifier(): PropertyDecorator & ParameterDecorator {
    return Inject(ALTCHA_VERIFIER);
}
