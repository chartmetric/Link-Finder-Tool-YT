import { bigint, integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Coordination only. ClickHouse remains the catalog and bulk result archive.
export const profileBulkQueue = pgTable("profile_bulk_queue", {
  id: integer("id").primaryKey(),
  state: jsonb("state").notNull(),
});
export const profileBulkClaims = pgTable("profile_bulk_claims", {
  id: uuid("id").primaryKey(),
  record: jsonb("record").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const profileBulkAttempts = pgTable("profile_bulk_attempts", {
  profileId: bigint("profile_id", { mode: "number" }).primaryKey(),
});
export const insertProfileBulkAttemptSchema = createInsertSchema(profileBulkAttempts);
export type InsertProfileBulkAttempt = z.infer<typeof insertProfileBulkAttemptSchema>;
export const insertProfileBulkQueueSchema = createInsertSchema(profileBulkQueue);
export const insertProfileBulkClaimSchema = createInsertSchema(profileBulkClaims);
export type InsertProfileBulkQueue = z.infer<typeof insertProfileBulkQueueSchema>;
export type InsertProfileBulkClaim = z.infer<typeof insertProfileBulkClaimSchema>;
