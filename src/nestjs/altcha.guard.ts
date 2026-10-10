import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Inject,
    Injectable,
    ServiceUnavailableException,
} from "@nestjs/common";

import type { AltchaVerifier, AltchaVerifyResult } from "../core/types";
import { ALTCHA_ERROR_CODE } from "../core/constants";
import { ALTCHA_VERIFIER } from "./constants";
import { takeAltchaPayload } from "./request-payload";

/**
 * Verifies the ALTCHA solution of an HTTP request (header `x-altcha` or body field `altcha`).
 * The result is available as `request.altcha` afterwards. Non-HTTP contexts are rejected.
 */
@Injectable()
export class AltchaGuard implements CanActivate {
    constructor(@Inject(ALTCHA_VERIFIER) private readonly verifier: AltchaVerifier) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        if (context.getType() !== "http") {
            throw new ForbiddenException({ code: ALTCHA_ERROR_CODE, reason: "unsupported_context" });
        }
        const request = context
            .switchToHttp()
            .getRequest<{ altcha?: AltchaVerifyResult } & Parameters<typeof takeAltchaPayload>[0]>();
        const result = await this.verifier.verify(takeAltchaPayload(request, this.verifier));
        request.altcha = result;
        if (!result.ok) {
            const Exception = result.reason === "store_unavailable" ? ServiceUnavailableException : ForbiddenException;
            throw new Exception({
                code: ALTCHA_ERROR_CODE,
                reason: result.reason,
                message: "ALTCHA verification failed",
            });
        }
        return true;
    }
}
