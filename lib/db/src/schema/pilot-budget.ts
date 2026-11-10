import {sql} from "drizzle-orm";
import {check, foreignKey, integer, pgTable, primaryKey, text, timestamp, uuid} from "drizzle-orm/pg-core";

// Coordination only: neither catalog data nor verified-link claims.
// Live scripts never create/seed these tables; see scripts/INSTAGRAM_PILOT_BUDGET.md.
export const instagramPilotCeilings = pgTable("instagram_pilot_ceilings", {
  id: text("id").primaryKey(),
  capCents: integer("cap_cents").notNull(),
  reservedCents: integer("reserved_cents").notNull(),
}, t => [
  check("instagram_pilot_ceilings_cap_cents_check", sql`${t.capCents} = 1000`),
  check("instagram_pilot_ceilings_reserved_cents_check", sql`${t.reservedCents} BETWEEN 0 AND ${t.capCents}`),
]);

export const instagramPilotRuns = pgTable("instagram_pilot_runs", {
  budgetId: text("budget_id").notNull().references(() => instagramPilotCeilings.id),
  runId: text("run_id").notNull(),
  owner: uuid("owner").notNull(),
  capCents: integer("cap_cents").notNull(),
  reservedCents: integer("reserved_cents").notNull().default(0),
}, t => [
  primaryKey({columns:[t.budgetId,t.runId]}),
  check("instagram_pilot_runs_cap_cents_check", sql`${t.capCents} BETWEEN 1 AND 1000`),
  check("instagram_pilot_runs_reserved_cents_check", sql`${t.reservedCents} BETWEEN 0 AND ${t.capCents}`),
]);

export const instagramPilotReservations = pgTable("instagram_pilot_reservations", {
  budgetId: text("budget_id").notNull(),
  runId: text("run_id").notNull(),
  admissionKey: text("admission_key").notNull(),
  cents: integer("cents").notNull(),
  profileId: text("profile_id").notNull(),
  kind: text("kind").notNull(),
  admittedAt: timestamp("admitted_at",{withTimezone:true}).notNull().default(sql`clock_timestamp()`),
}, t => [
  primaryKey({columns:[t.budgetId,t.runId,t.admissionKey]}),
  foreignKey({columns:[t.budgetId,t.runId],foreignColumns:[instagramPilotRuns.budgetId,instagramPilotRuns.runId]}),
  check("instagram_pilot_reservations_cents_check", sql`${t.cents} >= 0`),
]);
