import { Hono } from "hono";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool } from "@neondatabase/serverless";
import { transactionTable } from "./schema/transaction";
import { sum, between, count, asc, eq } from "drizzle-orm";
import { logger } from "hono/logger";
import { z } from "zod";
import { Redis } from "@upstash/redis/cloudflare";

export type Env = {
  DATABASE_URL: string;
  API_KEY: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
};

interface RedisEnv {
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use(logger());
app.use(async (c, next) => {
  const start = Date.now();
  await next();
  const end = Date.now();
  c.res.headers.set("X-Response-Time", `${end - start}`);
});

app.use("/transaction/*", async (c, next) => {
  const apiKey = c.req.header("X-API-KEY");
  if (apiKey !== c.env.API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

app.post("/transaction/add", async (c) => {
  const body = await c.req.json();
  const client = new Pool({ connectionString: c.env.DATABASE_URL });
  const db = drizzle(client);
  const nonnegative = z.number().nonnegative();

  await db.insert(transactionTable).values({
    amount: nonnegative.parse(body.amount).toString(),
    type: nonnegative.parse(body.type),
    kind: nonnegative.parse(body.kind),
    currency: nonnegative.parse(body.currency),
  });
  return c.json({
    ok: true,
  });
});

app.post("/transaction/delete", async (c) => {
  const body = await c.req.json();
  const client = new Pool({ connectionString: c.env.DATABASE_URL });
  const db = drizzle(client);
  const nonnegative = z.number().nonnegative();
  
  await db.delete(transactionTable).where(eq(transactionTable.id, nonnegative.parse(body.id)));

  return c.json({
    ok: true,
  });
});

app.get("/transaction/list", async (c) => {
  const date = z.string().date();
  const start_at = date.parse(c.req.query("start_at"));
  const end_at = date.parse(c.req.query("end_at"));

  const startTimeLocal = start_at + " 00:00:00";
  const endTimeLocal = end_at + " 23:59:59";

  const utcStartAt = new Date(
    new Date(startTimeLocal).getTime() - 8 * 60 * 60 * 1000
  );
  const utcEndAt = new Date(
    new Date(endTimeLocal).getTime() - 8 * 60 * 60 * 1000
  );
  const client = new Pool({ connectionString: c.env.DATABASE_URL });
  const db = drizzle(client);

  const redisEnv: RedisEnv = {
    UPSTASH_REDIS_REST_URL: c.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: c.env.UPSTASH_REDIS_REST_TOKEN,
  }
  const key = "transaction:list-" + start_at + "-" + end_at;
  const redis = Redis.fromEnv(redisEnv);
  const redisResult = await redis.get(key);

  if (redisResult) {
    return c.json({
      ok: true,
      data: redisResult,
    });
  }
  const result = await db
    .select({
      id: transactionTable.id,
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

  await redis.set(key, JSON.stringify(dataWithLocalTime), {ex:3600});
  return c.json({
    ok: true,
    data: dataWithLocalTime,
  });
});

app.get("/transaction/overview", async (c) => {
  const date = z.string().date();
  const start_at = date.parse(c.req.query("start_at"));
  const end_at = date.parse(c.req.query("end_at"));
  const startTimeLocal = start_at + " 00:00:00";
  const endTimeLocal = end_at + " 23:59:59";

  const utcStartAt = new Date(startTimeLocal);
  const utcEndAt = new Date(endTimeLocal);

  const redisEnv: RedisEnv = {
    UPSTASH_REDIS_REST_URL: c.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: c.env.UPSTASH_REDIS_REST_TOKEN,
  }

  const key = "transaction:overview-" + start_at + "-" + end_at;
  const redis = Redis.fromEnv(redisEnv);
  const redisResult = await redis.get(key);
  if (redisResult) {
    return c.json({
      ok: true,
      start_at: startTimeLocal,
      end_at: endTimeLocal,
      data: redisResult,
    });
  }

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

  await redis.set(key, JSON.stringify(result), {ex:3600});

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
