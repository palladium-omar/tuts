import { All, Controller, Inject, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "@palladium/service-kit";
import type { Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { IdentityService } from "./identity.service.js";

@ApiTags("identity")
@Public()
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  @All("*path")
  @ApiOperation({
    summary: "Better Auth email/password, session and sign-out endpoints",
    description:
      "External /api/platform/auth/sign-up/email, /sign-in/email, /get-session, /sign-out. Better Auth owns response shapes and session cookies.",
  })
  async handle(@Req() req: Request, @Res() res: Response) {
    // Gateway strips /api/platform. Reconstruct the configured public auth path
    // and explicitly reuse Nest's parsed body rather than a consumed stream.
    const suffix = req.originalUrl.replace(/^\/auth(?=\/|\?|$)/, "");
    const url = `${this.identity.gatewayUrl}/api/platform/auth${suffix}`;
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const headers = fromNodeHeaders(req.headers);
    headers.delete("content-length");
    if (hasBody && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    const response = await this.identity.auth.handler(
      new globalThis.Request(url, {
        method: req.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(req.body ?? {}) } : {}),
      }),
    );
    res.status(response.status);
    response.headers.forEach((value, name) => {
      if (name !== "set-cookie") res.setHeader(name, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader("set-cookie", cookies);
    res.send(Buffer.from(await response.arrayBuffer()));
  }
}
