import {
  integer,
  pgTable,
  serial,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";

export const transactionTable = pgTable("transactions", {
  id: serial("id").primaryKey(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  type: integer("type").notNull(),
  kind: integer("kind").notNull(),
  currency: integer("currency").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .$onUpdate(() => new Date()),
});

export type InsertTransaction = typeof transactionTable.$inferInsert;
export type SelectTransaction = typeof transactionTable.$inferSelect;
