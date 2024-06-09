import { Hono } from "hono";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool } from "@neondatabase/serverless";
import { transactionTable } from "./schema/transaction";
import { sum, between, count, asc } from "drizzle-orm";
// import { date } from "drizzle-orm/mysql-core";

export type Env = {
  DATABASE_URL: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

app.post("/transaction/add", async (c) => {
  const body = await c.req.json();
  const client = new Pool({ connectionString: c.env.DATABASE_URL });
  const db = drizzle(client);
  console.log(c.env.DATABASE_URL);

  await db.insert(transactionTable).values({
    amount: body.amount,
    type: body.type,
    kind: body.kind,
    currency: body.currency,
  });
  return c.json({
    ok: true,
  });
});

app.get("/transaction/list", async (c) => {
  const startTimeLocal = c.req.query("start_at") + " 00:00:00";
  const endTimeLocal = c.req.query("end_at") + " 23:59:59";

  const utcStartAt = new Date(
    new Date(startTimeLocal).getTime() - 8 * 60 * 60 * 1000
  );
  const utcEndAt = new Date(
    new Date(endTimeLocal).getTime() - 8 * 60 * 60 * 1000
  );
  const client = new Pool({ connectionString: c.env.DATABASE_URL });
  const db = drizzle(client);

  const result = await db
    .select({
      amount: transactionTable.amount,
      type: transactionTable.type,
      date: transactionTable.createdAt,
    })
    .from(transactionTable)
    .where(between(transactionTable.createdAt, utcStartAt, utcEndAt))
    .orderBy(asc(transactionTable.createdAt));

  const dataWithLocalTime = result.map((item) => {
    const utcDate = new Date(item.date);
    // 加8小时转换为UTC+8
    const localDate = new Date(utcDate.getTime() + 8 * 60 * 60 * 1000);
    // 转换时间为标准格式
    const formattedDate = localDate
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    return { ...item, date: formattedDate };
  });

  return c.json({
    ok: true,
    data: dataWithLocalTime,
  });
});

app.get("/transaction/overview", async (c) => {
  const startTimeLocal = c.req.query("start_at") + " 00:00:00";
  const endTimeLocal = c.req.query("end_at") + " 23:59:59";

  const utcStartAt = new Date(startTimeLocal);
  const utcEndAt = new Date(endTimeLocal);

  const client = new Pool({ connectionString: c.env.DATABASE_URL });
  const db = drizzle(client);
  const result = await db
    .select({
      type: transactionTable.type,
      sum: sum(transactionTable.amount),
      count: count(transactionTable.amount),
    })
    .from(transactionTable)
    .where(between(transactionTable.createdAt, utcStartAt, utcEndAt))
    .groupBy(transactionTable.type); // 在这里移除 orderBy(asc(transactionTable.createdAt))

  return c.json({
    ok: true,
    start_at: startTimeLocal,
    end_at: endTimeLocal,
    date: result,
  });
});

app.onError((error, c) => {
  console.log(error);
  return c.json({ error }, 400);
});

export default app;
