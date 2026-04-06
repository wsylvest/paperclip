import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export function requestIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers["x-request-id"] as string) || randomUUID();
    req.headers["x-request-id"] = requestId;
    res.setHeader("x-request-id", requestId);
    next();
  };
}
