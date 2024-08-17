import { Hono } from "hono";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool } from "@neondatabase/serverless";
import { transactionTable } from "./schema/transaction";
import { sum, between, count, asc, eq, isNull, and } from "drizzle-orm";
import { logger } from "hono/logger";
import { z } from "zod";
import { Redis } from "@upstash/redis/cloudflare";
import dayjs from "dayjs";
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';


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

dayjs.extend(utc)
dayjs.extend(timezone)

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
  // 验证和解析日期参数
  const dateSchema = z.string().date();
  const start_at = dateSchema.parse(c.req.query("start_at"));
  const end_at = dateSchema.parse(c.req.query("end_at"));

  const startTimeLocal = dayjs.tz(start_at, 'Asia/Shanghai').startOf('day').utc().toDate();
  const endTimeLocal = dayjs.tz(end_at, 'Asia/Shanghai').endOf('day').utc().toDate();

  // 设置 Redis 环境变量
  const redisEnv: RedisEnv = {
    UPSTASH_REDIS_REST_URL: c.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: c.env.UPSTASH_REDIS_REST_TOKEN,
  };
  const key = `transaction:list-${start_at}-${end_at}`;
  const redis = getRedisInstance(redisEnv);
  const redisResult = await redis.get(key);

  // 如果缓存命中，直接返回结果
  if (redisResult) {
    return c.json({
      ok: true,
      data: redisResult,
    });
  }

  const db = getDbInstance(c.env.DATABASE_URL);

  // 查询数据库，使用 UTC 时间范围
  const result = await db
      .select({
        id: transactionTable.id,
        title: transactionTable.title,
        amount: transactionTable.amount,
        type: transactionTable.type,
        date: transactionTable.createdAt,
      })
      .from(transactionTable)
      .where(and(between(transactionTable.createdAt, startTimeLocal, endTimeLocal),
          isNull(transactionTable.deletedAt)
      ))
      .orderBy(asc(transactionTable.createdAt));

  // 将结果中的日期转换为本地时间
  const dataWithLocalTime = result.map((item) => ({
    ...item,
    date: dayjs.utc(item.date).tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
  }));

  // 缓存查询结果
  if (result.length) {
    await redis.set(key, JSON.stringify(dataWithLocalTime), {ex: 3600});
  }

  return c.json({
    ok: true,
    data: dataWithLocalTime,
  });
});


app.get("/transaction/overview", async (c) => {
  const dateSchema = z.string().date();
  const start_at = dateSchema.parse(c.req.query("start_at"));
  const end_at = dateSchema.parse(c.req.query("end_at"));
  const startTimeLocal = dayjs.tz(start_at, 'Asia/Shanghai').startOf('day').utc();
  const endTimeLocal = dayjs.tz(end_at, 'Asia/Shanghai').endOf('day').utc();

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
      start_at: dayjs.tz(start_at, 'Asia/Shanghai').startOf('day').format('YYYY-MM-DD HH:mm:ss'),
      end_at: dayjs.tz(start_at, 'Asia/Shanghai').endOf('day').format('YYYY-MM-DD HH:mm:ss'),
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
    .where(and(between(transactionTable.createdAt, startTimeLocal.toDate(), endTimeLocal.toDate()),isNull(transactionTable.deletedAt)))
    .groupBy(transactionTable.type);

  await redis.set(key, JSON.stringify(result), { ex: 3600 });

  return c.json({
    ok: true,
    start_at: dayjs.tz(start_at, 'Asia/Shanghai').startOf('day').format('YYYY-MM-DD HH:mm:ss'),
    end_at: dayjs.tz(start_at, 'Asia/Shanghai').endOf('day').format('YYYY-MM-DD HH:mm:ss'),
    data: result,
  });
});

app.onError((error, c) => {
  console.log(error);
  return c.json({ error }, 400);
});

export default app;