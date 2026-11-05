import { db, initializeDatabase } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // 等待服务端 schema 就绪：健康检查必须反映“表真的可用”，而不是只测一次 select 1
    await initializeDatabase();
    await db.execute(sql`select 1`);
    return Response.json({ status: "ok", ok: true, db: true });
  } catch {
    // 保持 200（进程与行情链路仍可用），但必须显式暴露 db 不可用，
    // 否则数据库故障会被 health 的 ok 掩盖。
    return Response.json({ status: "ok", ok: true, db: false, fallback: true });
  }
}
