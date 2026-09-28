import type { Express, Request } from "express";
import express from "express";
import { browserMutationGuardMiddleware } from "./csrf.js";
import { isAuthorizedBrowserRequest } from "./http-auth.js";

export const BROWSER_AUTH_VERIFIED_FLAG = "__openclawBrowserAuthVerified";

type BrowserAuthMarkedRequest = Request & {
  [BROWSER_AUTH_VERIFIED_FLAG]?: boolean;
};

export function hasVerifiedBrowserAuth(req: Request): boolean {
  return (req as BrowserAuthMarkedRequest)[BROWSER_AUTH_VERIFIED_FLAG] === true;
}

function markVerifiedBrowserAuth(req: Request) {
  (req as BrowserAuthMarkedRequest)[BROWSER_AUTH_VERIFIED_FLAG] = true;
}

export function installBrowserCommonMiddleware(app: Express) {
  app.use((req, res, next) => {
    const ctrl = new AbortController();
    const abort = () => {
      if (!ctrl.signal.aborted) {
        ctrl.abort(new Error("request aborted"));
      }
    };
    // Node 18+ exposes IncomingMessage.signal; the "aborted" event is deprecated.
    const nativeSignal = (req as unknown as { signal?: AbortSignal }).signal;
    if (nativeSignal) {
      if (nativeSignal.aborted) {
        abort();
      } else {
        nativeSignal.addEventListener("abort", abort, { once: true });
      }
    } else {
      req.once("aborted", abort);
    }
    res.once("close", () => {
      if (!res.writableEnded) {
        abort();
      }
    });
    // Make a disconnect-aware signal available to browser route handlers.
    // Node 24+: IncomingMessage.signal is getter-only; plain assignment throws
    // and Express returns an HTML 500 page before auth/route handlers run.
    // Shadow with an own property so req.signal remains the AbortSignal handlers read.
    Object.defineProperty(req, "signal", {
      value: ctrl.signal,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(browserMutationGuardMiddleware());
}

export function installBrowserAuthMiddleware(
  app: Express,
  auth: { token?: string; password?: string },
) {
  if (!auth.token && !auth.password) {
    return;
  }
  app.use((req, res, next) => {
    if (isAuthorizedBrowserRequest(req, auth)) {
      markVerifiedBrowserAuth(req);
      return next();
    }
    res.status(401).send("Unauthorized");
  });
}
