/**
 * dsh-dreaming — 语义索引的定时同步器
 *
 * 职责：把 messages 表里还没向量化的消息，随时间慢慢补进 messages_vec。
 * 生命周期完全跟着 dsh 走 —— dsh 退出它就停，dsh 起来它自己接着补。
 * **不依赖任何系统级守护进程**（launchd / systemd / cron 都不需要）。
 *
 * 设计要点：
 *   · 两趟建库（近期优先），与 scripts/vec-backfill.mjs 的语义完全一致
 *   · 每 CHUNK 条推进一次水位线 —— 崩溃最多重算一个 chunk
 *   · 暂停只存内存，重启自动续跑（不做跨重启持久化：那会造出
 *     「重启后仍是暂停、你以为坏了」的难排查状态）
 *   · 单次 tick 有时间预算，到点就停，不阻塞事件循环
 */

import * as V from "./vec-store.mjs";

/** 第 1 趟覆盖的比例与上限 —— 比例/上限，不是绝对条数（公共插件不能写死）。 */
const WARMUP_RATIO = 0.2;
const WARMUP_CAP = 5000;

/** 事务粒度 = 水位线推进粒度。与回填脚本保持一致。 */
const CHUNK = 30;

/** 单次 tick 的处理量上限与时间预算。到任一上限就收工，下个 tick 接着来。 */
const TICK_MAX_ITEMS = 300;
const TICK_BUDGET_MS = 90_000;

/** 追平期（首次建库 / 刚补上大量积压）用短间隔，追平后回到正常间隔。 */
const CATCHUP_MS = 30_000;

export class VectorSync {
  /**
   * @param {object} opts
   * @param {import("node:sqlite").DatabaseSync} opts.db  已加载 vec0、已建表的裸连接
   * @param {{embed:(t:string[])=>Promise<Float32Array[]|null>, start:()=>Promise<boolean>}} opts.embed
   * @param {object} opts.log
   * @param {number} [opts.intervalMs]  正常间隔（默认 10 分钟）
   */
  constructor({ db, embed, log, intervalMs = 10 * 60_000 }) {
    this.db = db;
    this.embed = embed;
    this.log = log;
    this.intervalMs = intervalMs;

    this._timer = null;
    this._paused = false;
    this._running = false;
    this._disposed = false;

    // 只用于展示，不参与正确性
    this._lastSyncAt = null;
    this._lastBatchMs = null;
    this._lastSyncedCount = 0;
  }

  /* ─────────────────────────── 生命周期 ─────────────────────────── */

  start() {
    if (this._disposed) return;
    this._schedule(0); // 立刻跑第一次，不必等满一个间隔
  }

  dispose() {
    this._disposed = true;
    this._clear();
  }

  /** 暂停：不排下一次；当前正在跑的那一批会跑完再停（不半途丢弃）。 */
  pause() {
    if (this._paused) return;
    this._paused = true;
    this._clear();
    this.log?.info?.("语义索引已暂停");
  }

  /** 继续：重新排程。重启后不会保持暂停 —— 状态只在内存里。 */
  resume() {
    if (!this._paused) return;
    this._paused = false;
    this.log?.info?.("语义索引已继续");
    if (!this._disposed) this._schedule(0);
  }

  /* ─────────────────────────── 排程 ─────────────────────────── */

  _clear() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** 跑完再排，不堆积 —— 照抄 dream-engine 的 scheduleNext。 */
  _schedule(delayMs) {
    this._clear();
    if (this._disposed || this._paused) return;
    this._timer = setTimeout(async () => {
      this._timer = null;
      let caughtUp = false;
      try {
        const r = await this.syncOnce();
        caughtUp = r.caughtUp;
      } catch (e) {
        this.log?.error?.(`语义索引本轮失败：${e instanceof Error ? e.message : e}`);
      }
      if (this._disposed || this._paused) return;
      // 还有积压 → 短间隔追平；已追平 → 回到正常间隔
      this._schedule(caughtUp ? this.intervalMs : CATCHUP_MS);
    }, delayMs);
  }

  /* ─────────────────────────── 核心同步 ─────────────────────────── */

  /**
   * 单次同步。返回 { done, caughtUp }。
   * done=本轮处理条数，caughtUp=是否已经没有积压。
   */
  async syncOnce() {
    if (this._running) return { done: 0, caughtUp: false };
    this._running = true;
    const t0 = Date.now();
    let done = 0;

    try {
      /* ① 首次建库：第 1 趟，近期优先 */
      if (V.getHotMaxId(this.db) === 0) {
        const warm = this._warmSlice();
        if (warm.length > 0) {
          const n = await this._process(warm, { advanceWatermark: false, limit: TICK_MAX_ITEMS });
          done += n;
          // 每轮把游标推过已处理的部分 —— 这是「不重算」的关键
          if (n > 0) V.setWarmCursor(this.db, warm[n - 1].id);
          // 本段全部处理完 且 没有更老的了 ⇒ 第 1 趟收尾
          const finished = n === warm.length && this._warmSlice().length === 0;
          if (finished) {
            const hotMax = V.getWarmFloor(this.db) - 1;
            V.setHotMaxId(this.db, hotMax);
            // ⚠️ watermark 必须留在 0 —— 第 2 趟要补的是 (0, hotMax] 这一段，
            //    靠 beforeId 限上界。若在这里把 watermark 推到 hotMax，
            //    第 2 趟就再也取不到历史部分了。
            this.log?.info?.(`[dr] 语义索引第 1 趟完成：近期 ${n} 条，hot_max_id=${hotMax}`);
          }
        }
        this._touch(done, t0);
        if (done === 0) {
          this.log?.warn?.(
            `语义索引第 1 趟空转：warm 切片 ${warm.length} 条，但一条都没写成`
          );
        }
        return { done, caughtUp: false };
      }

      /*
       * ②③④⑤ 第 2 趟 / 增量：从旧往新，正序推进水位线。
       * 第 2 趟有上界 hotMax —— 那之上是第 1 趟已经建好的近期部分。
       * 水位线推到 hotMax 之后，上界自然失效，转入纯增量。
       */
      const wm = V.getWatermark(this.db);
      const hotMax = V.getHotMaxId(this.db);
      const upperBound = wm < hotMax ? hotMax : null;
      const rows = V.collectMessages(this.db, {
        afterId: wm,
        beforeId: upperBound,
        limit: TICK_MAX_ITEMS,
      });
      if (rows.length === 0) {
        this._touch(0, t0);
        return { done: 0, caughtUp: true };
      }
      done = await this._process(rows, { advanceWatermark: true });
      this._touch(done, t0);
      return { done, caughtUp: done < TICK_MAX_ITEMS };
    } finally {
      this._running = false;
    }
  }

  /** 第 1 趟要覆盖的条数：最近 WARMUP_RATIO，上限 WARMUP_CAP。 */
  _warmWant() {
    const total = V.countEligible(this.db);
    if (total === 0) return 0;
    return Math.min(Math.ceil(total * WARMUP_RATIO), WARMUP_CAP);
  }

  /**
   * 第 1 趟的下边界：最近 want 条里最老的那条 id。
   * 只在开始时算一次、存库 —— 边跑边算会随着新消息进来漂移。
   */
  _ensureWarmFloor() {
    let floor = V.getWarmFloor(this.db);
    if (floor > 0) return floor;
    const want = this._warmWant();
    if (want === 0) return 0;
    const tail = V.collectMessages(this.db, { afterId: 0, limit: want, desc: true });
    if (tail.length === 0) return 0;
    floor = tail[tail.length - 1].id; // 降序尾巴 = 最老
    V.setWarmFloor(this.db, floor);
    return floor;
  }

  /**
   * 第 1 趟本轮要处理的一段：[floor, cursor) 降序（最新优先），最多 TICK_MAX_ITEMS 条。
   * cursor 是「已处理到的最小 id」，每轮往下推进，绝不回退重算。
   */
  _warmSlice() {
    const floor = this._ensureWarmFloor();
    if (floor === 0) return [];
    const cursor = V.getWarmCursor(this.db);
    if (cursor > 0 && cursor <= floor) return []; // 已经推进到底
    return V.collectMessages(this.db, {
      afterId: floor - 1,
      beforeId: cursor > 0 ? cursor - 1 : null,
      limit: TICK_MAX_ITEMS,
      desc: true, // 近期优先：从最新的往下推，游标随之下移
    });
  }

  /**
   * 处理一批：按 CHUNK 切、逐块嵌入 + 事务写 + 推进水位线。
   * @returns {Promise<number>} 实际处理条数
   */
  async _process(rows, { advanceWatermark, limit = Number.POSITIVE_INFINITY }) {
    const t0 = Date.now();
    let done = 0;

    for (let i = 0; i < rows.length && done < limit; i += CHUNK) {
      if (this._paused || this._disposed) break;          // 暂停：这批写完就停
      if (Date.now() - t0 > TICK_BUDGET_MS) break;         // 预算到点，下轮继续

      const slice = rows.slice(i, Math.min(i + CHUNK, i + (limit - done)));
      if (slice.length === 0) break;

      const vectors = await this.embed.embed(slice.map((r) => r.content));
      if (!vectors || vectors.length !== slice.length) {
        // 嵌入失败：不推进水位线，本批丢弃，下轮重试。不抛 —— 别把同步器搞死。
        this.log?.warn?.(`语义索引嵌入失败，本批 ${slice.length} 条留待下轮`);
        break;
      }

      this.db.exec("BEGIN IMMEDIATE");
      try {
        // vec0 不支持 INSERT OR REPLACE（重复 id 报 UNIQUE），必须先删后插
        const del = this.db.prepare("DELETE FROM messages_vec WHERE id = ?");
        const ins = this.db.prepare(
          "INSERT INTO messages_vec(id, embedding) VALUES(?, ?)"
        );
        for (let j = 0; j < slice.length; j++) {
          del.run(BigInt(slice[j].id));
          ins.run(BigInt(slice[j].id), new Float32Array(vectors[j]));
        }
        if (advanceWatermark) {
          V.setWatermark(this.db, slice[slice.length - 1].id);
        }
        this.db.exec("COMMIT");
      } catch (e) {
        try { this.db.exec("ROLLBACK"); } catch {}
        throw e;
      }

      done += slice.length;
      // 每批一条：没有它就只能靠猜「同步器活没活」—— 2026-11-21 卡在这上面半小时。
      this.log?.info?.(
        `语义索引写入 ${done} 条（本批 ${slice.length}，` +
        `${((Date.now() - t0) / done).toFixed(0)}ms/条）`
      );
    }

    if (done > 0) this._lastBatchMs = Date.now() - t0;
    return done;
  }

  _touch(done, t0) {
    this._lastSyncedCount = done;
    if (done > 0) this._lastSyncAt = new Date().toISOString();
    void t0;
  }

  /* ─────────────────────────── 状态 ─────────────────────────── */

  /**
   * 给 UI 用的状态快照。字段与方案 §八 一致。
   * 全部从库里现算 —— 不缓存，避免「显示的和实际不一致」。
   */
  status(extra = {}) {
    const total = V.countEligible(this.db);
    const indexed = Number(V.countVectors(this.db));
    const hotMax = V.getHotMaxId(this.db);
    const watermark = V.getWatermark(this.db);
    const maxId = V.maxMessageId(this.db);
    const pending = V.countMissing(this.db);

    let phase;
    if (this._paused) phase = "paused";
    else if (hotMax === 0) phase = "warming";        // 第 1 趟还没跑完
    else if (pending > 0 && watermark < hotMax) phase = "building";  // 第 2 趟补历史
    else if (pending > 0) phase = "updating";        // 只是在追新消息
    else phase = "idle";

    const avgMs = this._lastBatchMs !== null && this._lastSyncedCount > 0
      ? Math.round(this._lastBatchMs / this._lastSyncedCount)
      : null;

    return {
      ...extra,
      paused: this._paused,
      running: this._running,
      phase,
      pending,
      indexed,
      total,
      watermark,
      hotMax,
      maxId,
      lastSyncAt: this._lastSyncAt,
      avgMsPerItem: avgMs,
      etaMinutes: avgMs !== null && pending > 0
        ? Math.ceil((pending * avgMs) / 60_000)
        : null,
    };
  }
}
