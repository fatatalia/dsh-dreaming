/**
 * 一次性迁移：messages_vec（一消息一向量） → msg_chunks + chunks_vec（一消息多块）。
 *
 * 只搬已有向量，不重算 —— 老向量是按「整条消息」嵌的，语义上仍是这条消息的
 * 代表向量，作为 seq=0 完全成立。之后新消息走切分路径，长消息才会有 seq>0。
 *
 * 幂等：先清空两张新表再灌，重复跑结果一致。
 *
 * 用法：node scripts/vec-migrate-chunks.mjs [--force]
 *   --force  新表已有数据也覆盖（默认遇到数据会拒绝，防误操作）
 */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as V from "../lib/vec-store.mjs";

const force = process.argv.includes("--force");
const DB = join(homedir(), ".dsh", "dreaming-memory.db");

const req = createRequire(import.meta.url);
V.setVecRequire(req);

const db = new DatabaseSync(DB, { allowExtension: true });
if (!V.loadVecExtension(db)) {
  console.error("vec0 扩展加载失败，中止");
  process.exit(1);
}

V.initVecSchema(db);

const existing = Number(db.prepare("SELECT COUNT(*) c FROM msg_chunks").get().c);
const legacy = Number(db.prepare("SELECT COUNT(*) c FROM messages_vec").get().c);
console.log(`新表现有 ${existing} 块，旧表 ${legacy} 条向量`);

if (existing > 0 && !force) {
  console.log("新表已有数据，跳过（要覆盖加 --force）");
  process.exit(0);
}

if (legacy === 0) {
  console.log("旧表为空，无需迁移");
  process.exit(0);
}

const rows = db.prepare("SELECT id, embedding FROM messages_vec").all();
console.log(`开始迁移 ${rows.length} 条...`);

const t0 = Date.now();
db.exec("BEGIN IMMEDIATE");
try {
  db.exec("DELETE FROM chunks_vec");
  db.exec("DELETE FROM msg_chunks");

  const insChunk = db.prepare("INSERT INTO msg_chunks(chunk_id, msg_id, seq) VALUES(?, ?, 0)");
  const insVec = db.prepare("INSERT INTO chunks_vec(chunk_id, embedding) VALUES(?, ?)");

  let n = 0;
  for (const r of rows) {
    const mid = Number(r.id);
    const cid = BigInt(mid) * 100n; // seq = 0
    insChunk.run(cid, BigInt(mid));
    // embedding 已经是 Uint8Array(3072) = Float32×768，直接原样喂
    insVec.run(cid, r.embedding);
    n++;
    if (n % 2000 === 0) console.log(`  ${n}/${rows.length}`);
  }

  db.exec("COMMIT");
  console.log(`完成 ${n} 条，耗时 ${Date.now() - t0}ms`);
} catch (e) {
  try { db.exec("ROLLBACK"); } catch {}
  console.error("迁移失败，已回滚：", e?.message || e);
  process.exit(1);
}

const after = Number(db.prepare("SELECT COUNT(DISTINCT msg_id) c FROM msg_chunks").get().c);
const chunks = Number(db.prepare("SELECT COUNT(*) c FROM msg_chunks").get().c);
console.log(`新表：${after} 条消息 / ${chunks} 块`);
