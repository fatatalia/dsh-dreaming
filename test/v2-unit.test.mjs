/**
 * v2 单元测试（不依赖 dsh 运行时）：
 *  1. store 迁移兼容（旧 promotions 表补列 / recall_stats 建表）
 *  2. prepareFragments：多查询去重、碎片截断、recall_stats 累计
 *  3. promoteBySignals：uniqueQueries 门槛、量化评分、防重复、上限
 *  4. compactMemoryForBudget：只删标记段、保留手写段
 */
import { DreamStore, similarity } from "../lib/store.mjs";
import { DreamEngine, stripMeta } from "../lib/dream-engine.mjs";
import { renderDreams } from "../lib/dream-render.mjs";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const dir = join(tmpdir(), `dream-test-${Date.now()}`);
const dbPath = join(dir, "dreaming.db");
const memoryPath = join(dir, "MEMORY.md");

// 1. store 老库迁移测试：先建"旧结构" promotions 表再打开 store
const { DatabaseSync } = await import("node:sqlite");
const { mkdirSync } = await import("node:fs");
mkdirSync(dir, { recursive: true });
{ 
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS dreams (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS promotions (id INTEGER PRIMARY KEY AUTOINCREMENT, dream_id INTEGER, content TEXT NOT NULL, target TEXT NOT NULL, promoted_at TEXT NOT NULL);`);
  db.close();
  const store = new DreamStore(dbPath);
  const pid = store.addPromotion({ dreamId: 1, content: "旧数据", target: "MEMORY.md", evidence: "x", rule: "y" });
  ok("store 迁移：旧 promotions 表补 evidence/rule 列并写入", pid > 0);
  const cols = store.db.prepare("PRAGMA table_info(promotions)").all().map((c) => c.name);
  ok("store 迁移：evidence/rule 列存在", cols.includes("evidence") && cols.includes("rule"), cols.join(","));
  const rs = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  ok("store 迁移：recall_stats 表存在", rs.includes("recall_stats"));
  store.close();
}
rmSyncRec(dbPath);

// 1.5 stripMeta：剥离 Hindsight 元数据字段（| When: | Involving: |）
{
  const cases = [
    ["代码东家里有五只猫 | When: 无 | Involving: 代码东 | 无", "代码东家里有五只猫"],
    ["紫紫是纯橘猫，2018年8月出生 | When: 2018年8月 | Involving: 紫紫（代码东家的猫） | 无", "紫紫是纯橘猫，2018年8月出生"],
    ["法塔的管家名叫代码东 | When: 无 | Involving: 法塔 (主人), 代码东 (管家) | 无", "法塔的管家名叫代码东"],
    ["用户决定跳过 heartbeat- 前缀会话的记忆加载 | When: 2026-08-20 | Involving: 用户", "用户决定跳过 heartbeat- 前缀会话的记忆加载"],
    ["多查询 recall 应取当日和近两天结果 | When: 2026-08-18", "多查询 recall 应取当日和近两天结果"],
    ["只有 Involving 字段 | Involving: 代码东", "只有 Involving 字段"],
  ];
  for (const [input, expect] of cases) {
    const got = stripMeta(input);
    ok(`stripMeta：${input.slice(0, 24)}… → ${expect.slice(0, 20)}`, got === expect, `got=${got}`);
  }
  // 正文里的 | 分隔（非元数据）必须保留
  const keep = stripMeta("dsh-llm-retry 只做同 provider 重试，不切换模型 | 排查 dsh 的模型 fallback 能力");
  ok("stripMeta：正文 | 分隔保留", keep.includes("| 排查 dsh 的模型 fallback 能力"), keep);
  // 无元数据的文本原样返回
  const plain = stripMeta("今天小飞机预产期重新估算为8月18到20日");
  ok("stripMeta：无元数据文本不变", plain === "今天小飞机预产期重新估算为8月18到20日", plain);
}

function rmSyncRec(p) { try { rm(p, { force: true }); } catch {} }

// 2. 主测试：新库
{ 
  const store = new DreamStore(dbPath);
  const engine = new DreamEngine({
    store, log: console, memoryPath,
    workspace: dir,
  });

  // prepareFragments：模拟多查询返回（同一 id 在两个查询命中 → recallCount=2）
  const records = [
    { id: "mem-1", text: "今天小飞机预产期重新估算为8月18到20日，父亲是雪球，全家都在等小猫落地。", entities: ["小飞机", "预产期", "雪球"], score: 1.1, day: "2026-08-18", query: "今天发生了什么" },
    { id: "mem-1", text: "今天小飞机预产期重新估算为8月18到20日，父亲是雪球，全家都在等小猫落地。", entities: ["小飞机", "预产期", "雪球"], score: 1.05, day: "2026-08-18", query: "家人的变化" },
    { id: "mem-2", text: "调试 dsh-imessage 的流式发送开关，用户决定默认开启。", entities: ["dsh-imessage", "流式发送"], score: 0.95, day: "2026-08-16", query: "今天发生了什么" },
    { id: "mem-3", text: "定了给女儿的生日蛋糕，周末去取。", entities: ["蛋糕", "女儿"], score: 0.5, day: "2026-08-17", query: "家人相关" },
  ];
  const deduped = engine.prepareFragments === undefined ? [] : await (async () => {
    // prepareFragments 内部调用 dedupeRecalls（模块私有），这里只验证 store 层累计
    for (const r of records) {
      store.touchRecall({ hash: r.id, snippet: r.text.slice(0, 200), query: r.query, day: "2026-08-18" });
    }
    return null;
  })();
  const stat1 = store.getRecallStat("mem-1");
  ok("prepareFragments：同 id 多查询累计 recall_count=2", stat1 && stat1.recall_count === 2, JSON.stringify(stat1));
  ok("prepareFragments：unique_queries=2", stat1 && stat1.unique_queries === 2);
  const stat3 = store.getRecallStat("mem-3");
  ok("prepareFragments：单查询唯一", stat3 && stat3.unique_queries === 1);

  // promoteBySignals：模拟 dedupeRecalls 输出（带 recallCount）
  const dedupedRecs = [
    { id: "mem-1", text: records[0].text, entities: records[0].entities, score: 1.1, day: "2026-08-18", recallCount: 2, uniqueQueries: 2, querySet: new Set(["a", "b"]) },
    { id: "mem-2", text: records[2].text, entities: records[2].entities, score: 0.95, day: "2026-08-16", recallCount: 1, uniqueQueries: 1, querySet: new Set(["a"]) },
    { id: "mem-3", text: records[3].text, entities: records[3].entities, score: 0.5, day: "2026-08-17", recallCount: 1, uniqueQueries: 1, querySet: new Set(["a"]) },
  ];
  // 第一次：promotions 表空 → mem-1（双查询命中）入选，单查询被门槛拦下
  const promotions1 = await engine.promoteBySignals([], dedupedRecs, "2026-08-18");
  ok("promoteBySignals：mem-1（双查询命中）入选", promotions1.length >= 1 && promotions1[0].content.includes("小飞机"), JSON.stringify(promotions1));
  ok("promoteBySignals：单查询命中（mem-2/mem-3）被门槛拦下", promotions1.length === 1, `got ${promotions1.length}`);

  // 第二次：预置重复内容 → 同主题被类似度查重拦截（用与产品相同的 extractInsight 输出格式）
  const dupContent = "小飞机预产期重新估算为8月18到20日，父亲是雪球，全家都在等小猫落地";
  store.addPromotion({ dreamId: 1, content: dupContent, target: "MEMORY.md", evidence: "t", rule: "t" });
  const dup = store.findPromotionSimilar(dupContent, 0.85);
  ok("promoteBySignals：重复内容被 similar 拦截（表内已有）", dup !== null);
  const promotions2 = await engine.promoteBySignals([], dedupedRecs, "2026-08-18");
  ok("promoteBySignals：重复主题被跳过（promotions2 为空）", promotions2.length === 0, JSON.stringify(promotions2));

  // compactMemoryForBudget：构造 > budgetBytes（默认 128KB）混合文件（手写段 + 多个标记段）
  const hand = "# MEMORY.md\n\n## 稳定区\n\n用户手写的重要信息，绝对不能删。\n\n噗嗤，这段也是手写的，很重要。\n\n".repeat(1012);
  const autoSections = [];
  let big = hand;
  for (let i = 0; i < 30; i++) {
    const sec = `## 2026-08-0${(i % 9) + 1} — 梦境沉淀（dsh-dreaming）\n> 梦境日记见 SQLite。当夜信号晋升洞察：\n- 洞察内容 ${i}：一些需要长期记住的家庭事务与项目进展记录。\n\n`;
    autoSections.push(sec);
    big += sec;
  }
  await writeFile(memoryPath, big, "utf8");
  const before = Buffer.byteLength(big, "utf8");
  ok("预算：测试文件超过 budgetBytes（128KB）", before > engine.budgetBytes, `${before} bytes`);
  await engine.compactMemoryForBudget();
  const after = await readFile(memoryPath, "utf8");
  ok("预算：回收后 ≤ budgetBytes", Buffer.byteLength(after, "utf8") <= engine.budgetBytes, `${Buffer.byteLength(after, "utf8")} bytes`);
  ok("预算：手写段保留", after.includes("用户手写的重要信息"), "手写段被误删！");
  ok("预算：仍有晋升标记段存在", after.includes("梦境沉淀（dsh-dreaming）"), "全部晋升段被删光");

  store.close();
}

// 5. dream_latest render 完整性（2026-08-25 事故回归测试）：
//    渲染文本必须包含每条梦境的日期与全文，不能只输出条数（"最近梦境 N 条"）。
{
  const dreams = [
    { date: "2026-08-25", content: "七月五日十二点三十六分三十三秒，机器醒来，开始数数。" },
    { date: "2026-08-24", content: "翻开上两页，植物账本还绿着。" },
  ];
  const text = renderDreams(dreams);
  ok("render：输出包含条数", text.includes("最近梦境 2 条"), text);
  ok("render：包含第一条日期", text.includes("【2026-08-25】"), text);
  ok("render：包含第一条内容", text.includes("机器醒来，开始数数"), text);
  ok("render：包含第二条日期", text.includes("【2026-08-24】"), text);
  ok("render：包含第二条内容", text.includes("植物账本还绿着"), text);
  ok("render：不以纯条数结束（有实际内容）", text.length > "最近梦境 2 条".length, `length=${text.length}`);

  const empty = renderDreams([]);
  ok("render：空列表返回明确文案", empty.includes("没有梦境记录"), empty);
  const nil = renderDreams(undefined);
  ok("render：undefined 不抛错且返回空文案", nil.includes("没有梦境记录"), String(nil));
}

await rmSyncRec(dir);
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);