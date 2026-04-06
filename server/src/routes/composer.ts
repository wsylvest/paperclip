import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createComposerThreadSchema,
  addComposerMessageSchema,
  convertToTaskSchema,
} from "@paperclipai/shared";
import { composerService } from "../services/composer.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { forbidden } from "../errors.js";

export function composerRoutes(db: Db) {
  const router = Router();
  const svc = composerService(db);

  router.post(
    "/companies/:companyId/composer/threads",
    validate(createComposerThreadSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = req.actor.userId;
      if (!userId) throw forbidden("User identity required");
      const actor = getActorInfo(req);
      const thread = await svc.createThread(companyId, userId, req.body);
      void logActivity({
        db,
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "composer.thread.created",
        entityType: "composer_thread",
        entityId: thread.id,
      });
      res.json(thread);
    },
  );

  router.get("/companies/:companyId/composer/threads", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const kind = req.query.kind as string | undefined;
    const scope = req.query.scope as string | undefined;
    const threads = await svc.listThreads(companyId, { kind, scope });
    res.json(threads);
  });

  router.post(
    "/companies/:companyId/composer/threads/:threadId/messages",
    validate(addComposerMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const threadId = req.params.threadId as string;
      assertCompanyAccess(req, companyId);
      const userId = req.actor.userId;
      if (!userId) throw forbidden("User identity required");
      const actor = getActorInfo(req);
      const message = await svc.addMessage(companyId, threadId, userId, req.body);
      void logActivity({
        db,
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "composer.message.added",
        entityType: "composer_thread",
        entityId: threadId,
      });
      res.json(message);
    },
  );

  router.post(
    "/companies/:companyId/composer/threads/:threadId/convert-to-task",
    validate(convertToTaskSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const threadId = req.params.threadId as string;
      assertCompanyAccess(req, companyId);
      const userId = req.actor.userId;
      if (!userId) throw forbidden("User identity required");
      const actor = getActorInfo(req);
      const result = await svc.convertToTask(companyId, threadId, userId, req.body);
      void logActivity({
        db,
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "composer.thread.converted_to_task",
        entityType: "composer_thread",
        entityId: threadId,
      });
      res.json(result);
    },
  );

  return router;
}
