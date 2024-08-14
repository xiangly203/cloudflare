import { Hono } from "hono";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool } from "@neondatabase/serverless";
import { transactionTable } from "./schema/transaction";
import { sum, between, count, asc, eq, isNull, and } from "drizzle-orm";
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

const getDbInstance = (connectionString: string) => {
  const client = new Pool({ connectionString });
  return drizzle(client);
};

const getRedisInstance = (env: RedisEnv): Redis => {
  return Redis.fromEnv(env);
};

const clearCache = async (redis: Redis) => {
  const keys = await redis.keys('transaction:*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
};

const toLocalTime = (utcDateStr: any): string => {
  const utcDate = new Date(utcDateStr);
  const localDate = new Date(utcDate.getTime() + 8 * 60 * 60 * 1000);
  return localDate.toISOString().replace("T", " ").slice(0, 19);
};

app.post("/transaction/add", async (c) => {
  const body = await c.req.json();
  const nonnegative = z.number().nonnegative();
  const string = z.string();

  const db = getDbInstance(c.env.DATABASE_URL);

  await db.insert(transactionTable).values({
    amount: nonnegative.parse(body.amount).toString(),
    title: string.parse(body.title),
    type: nonnegative.parse(body.type),
    kind: nonnegative.parse(body.kind),
    currency: nonnegative.parse(body.currency),
  });

  const redisEnv: RedisEnv = {
    UPSTASH_REDIS_REST_URL: c.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: c.env.UPSTASH_REDIS_REST_TOKEN,
  };
  const redis = getRedisInstance(redisEnv);
  await clearCache(redis);

  return c.json({ ok: true });
});

app.post("/transaction/update", async (c) => {
  const body = await c.req.json();
  const nonnegative = z.number().nonnegative();
  const db = getDbInstance(c.env.DATABASE_URL);

  // 获取 Redis 环境变量
  const redisEnv = {
    UPSTASH_REDIS_REST_URL: c.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: c.env.UPSTASH_REDIS_REST_TOKEN,
  };
  const redis = getRedisInstance(redisEnv);

  // 检查是否是删除操作
  if (body.is_delete) {
    await db.update(transactionTable).set({ deletedAt: new Date() }).where(eq(transactionTable.id, nonnegative.parse(body.id)));
  } else {
    // 更新操作
    const positive = z.number().positive();
    await db.update(transactionTable)
      .set({ amount: positive.parse(body.amount).toString() })
      .where(eq(transactionTable.id, nonnegative.parse(body.id)));
  }

  // 清除缓存
  await clearCache(redis);

  return c.json({ ok: true });
});

app.get("/transaction/list", async (c) => {
  const date = z.string().date();
  const start_at = date.parse(c.req.query("start_at"));
  const end_at = date.parse(c.req.query("end_at"));

  const startTimeLocal = start_at + " 00:00:00";
  const endTimeLocal = end_at + " 23:59:59";

  const utcStartAt = new Date(startTimeLocal + "Z");
  const utcEndAt = new Date(endTimeLocal + "Z");

  const redisEnv: RedisEnv = {
    UPSTASH_REDIS_REST_URL: c.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: c.env.UPSTASH_REDIS_REST_TOKEN,
  };
  const key = "transaction:list-" + start_at + "-" + end_at;
  const redis = getRedisInstance(redisEnv);
  const redisResult = await redis.get(key);

  if (redisResult) {
    return c.json({
      ok: true,
      data: redisResult,
    });
  }

  const db = getDbInstance(c.env.DATABASE_URL);

  const result = await db
    .select({
      id: transactionTable.id,
      title: transactionTable.title,
      amount: transactionTable.amount,
      type: transactionTable.type,
      date: transactionTable.createdAt,
    })
    .from(transactionTable)
    .where(and(between(transactionTable.createdAt, utcStartAt, utcEndAt),isNull(transactionTable.deletedAt)))
    .orderBy(asc(transactionTable.createdAt));

  const dataWithLocalTime = result.map((item) => {
    return { ...item, date: toLocalTime(item.date) };
  });

  await redis.set(key, JSON.stringify(dataWithLocalTime), { ex: 3600 });
  
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

  const utcStartAt = new Date(startTimeLocal + "Z");
  const utcEndAt = new Date(endTimeLocal + "Z");

  const redisEnv: RedisEnv = {
    UPSTASH_REDIS_REST_URL: c.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: c.env.UPSTASH_REDIS_REST_TOKEN,
  };

  const key = "transaction:overview-" + start_at + "-" + end_at;
  const redis = getRedisInstance(redisEnv);
  const redisResult = await redis.get(key);
  if (redisResult) {
    return c.json({
      ok: true,
      start_at: startTimeLocal,
      end_at: endTimeLocal,
      data: redisResult,
    });
  }

  const db = getDbInstance(c.env.DATABASE_URL);

  const result = await db
    .select({
      type: transactionTable.type,
      sum: sum(transactionTable.amount),
      count: count(transactionTable.amount),
    })
    .from(transactionTable)
    .where(and(between(transactionTable.createdAt, utcStartAt, utcEndAt),isNull(transactionTable.deletedAt)))
    .groupBy(transactionTable.type);

  await redis.set(key, JSON.stringify(result), { ex: 3600 });

  return c.json({
    ok: true,
    start_at: startTimeLocal,
    end_at: endTimeLocal,
    data: result,
  });
});

app.onError((error, c) => {
  console.log(error);
  return c.json({ error }, 400);
});

export default app;