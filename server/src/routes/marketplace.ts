import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  publishListingSchema,
  importListingSchema,
  addReviewSchema,
  marketplaceQuerySchema,
} from "@paperclipai/shared";
import { marketplaceService } from "../services/marketplace.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";

export function marketplaceRoutes(db: Db) {
  const router = Router();
  const svc = marketplaceService(db);

  // Public: browse listings
  router.get("/marketplace/listings", async (req, res) => {
    const filters = marketplaceQuerySchema.parse(req.query);
    const result = await svc.list(filters);
    res.json(result);
  });

  // Public: search listings
  router.get("/marketplace/search", async (req, res) => {
    const q = (req.query.q as string) ?? "";
    const result = await svc.search(q);
    res.json(result);
  });

  // Public: get listing detail
  router.get("/marketplace/listings/:slug", async (req, res) => {
    const slug = req.params.slug as string;
    const listing = await svc.getBySlug(slug);
    const reviews = await svc.getReviews(listing.id);
    res.json({ ...listing, reviews });
  });

  // Authenticated: publish a listing
  router.post(
    "/marketplace/listings",
    validate(publishListingSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.body.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = req.actor.userId ?? "unknown";
      const result = await svc.publish(companyId, userId, req.body);
      res.status(201).json(result);
    },
  );

  // Authenticated: update listing status
  router.put("/marketplace/listings/:id/status", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const { status } = req.body;
    const result = await svc.updateStatus(id, status);
    res.json(result);
  });

  // Authenticated: add version
  router.post("/marketplace/listings/:id/versions", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const { version, portablePackage, changelog } = req.body;
    const result = await svc.publishVersion(id, version, portablePackage, changelog);
    res.status(201).json(result);
  });

  // Authenticated: import listing into company
  router.post(
    "/marketplace/listings/:id/import",
    validate(importListingSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.body.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = req.params.id as string;
      const { collisionStrategy } = req.body;
      const result = await svc.importListing(companyId, id, collisionStrategy);
      res.json(result);
    },
  );

  // Authenticated: add review
  router.post(
    "/marketplace/listings/:id/reviews",
    validate(addReviewSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const userId = req.actor.userId ?? "unknown";
      const result = await svc.addReview(id, userId, req.body);
      res.status(201).json(result);
    },
  );

  return router;
}
