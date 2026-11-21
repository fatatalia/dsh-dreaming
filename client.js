/**
 * dsh-dreaming — client 半部分（浏览器 bundle）
 *
 * 2026-09-25 改版：从会话页 Tab（conversation.view）升级为**左侧菜单独立页面**，
 * 对齐官方 @deepseek-ai/dsh-client-ui-schedule 的做法：
 *   ① main 槽位          —— 页面本体（用 key 关联）
 *   ② sidebar.panellist  —— 左侧菜单项（用 id 关联；与 ① 同一个 id "dreaming"）
 * 点击左侧「梦境记忆」→ main 区域切换到本页面，不再是会话内的一个 Tab。
 *
 * 页面内部再分"梦境日记 / 晋升沉淀"两个子 Tab；梦境日记支持按日期查询，
 * 默认展示今天（凌晨）的梦境，可手工选择日期查看历史。
 * 配置项（provider/model/窗口时间）仍留在 Settings → 梦境记忆，**不搬进页面**。
 * 数据经 connection.rpc 走 "/dsh-dreaming" 通道。
 */
window.__ModuleLoader__.load({
  id: "dsh-dreaming",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const S = require("react/jsx-runtime");

    const CHANNEL = "/dsh-dreaming";

    /** 本地日期 YYYY-MM-DD（浏览器时区 = 北京时间）。 */
    function todayStr() {
      return new Date().toLocaleDateString("en-CA");
    }

    function createDreamingRuntime(rpc, sessionId) {
      const call = async (endpoint, payload) => {
        const response = await rpc.call(CHANNEL, endpoint, payload || {});
        if (!response || !response.ok) {
          throw new Error(response?.error?.message || `${endpoint} failed`);
        }
        return response.value;
      };
      return {
        listDreams: (opts) => call("listDreams", opts || {}),
        listPromotions: () => call("listPromotions", {}),
        memoryStatus: () => call("memoryStatus", {}),
        vectorStatus: () => call("vectorStatus", {}),
        vectorPause: () => call("vectorPause", {}),
        vectorResume: () => call("vectorResume", {}),
        downloadModel: () => call("downloadModel", {}),
        runNow: () => call("runNow", {}),
      };
    }

    const card = {
      background: "var(--dsw-alias-bg-base)",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: 10,
      padding: "14px 16px",
      marginBottom: 12,
    };
    const title = { fontWeight: 600, fontSize: 13, marginBottom: 4 };
    const meta = { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginBottom: 8 };
    const body = { fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap", color: "var(--dsw-alias-label-primary)" };
    const empty = { color: "var(--dsw-alias-label-tertiary)", padding: "24px 0", textAlign: "center" };

    // ── 页面级布局（对齐官方 TaskManagerPage：整页容器 + 内部滚动 + 内容居中）──
    const page = {
      width: "100%",
      minWidth: 0,
      height: "100%",
      minHeight: 0,
      color: "var(--dsw-alias-label-primary)",
      background: "var(--dsw-alias-bg-base)",
      fontSize: 14,
      lineHeight: 1.6,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    };
    const pageScroll = { flex: 1, minHeight: 0, overflow: "auto", scrollbarGutter: "stable" };
    const pageContent = { maxWidth: 960, margin: "0 auto", padding: "0 clamp(24px, 4vw, 48px) 48px" };
    const pageHeading = {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 16,
      marginBottom: 20,
      paddingTop: 28,
      flexWrap: "wrap",
    };
    const h1 = { flex: 1, minWidth: 0, margin: 0, fontSize: 20, fontWeight: 500, lineHeight: "28px" };

    const tabBtn = (active) => ({
      padding: "6px 16px",
      borderRadius: 8,
      border: active ? "1px solid var(--dsw-alias-state-business-primary)" : "1px solid var(--dsw-alias-border-l2)",
      background: active ? "color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, var(--dsw-alias-bg-base))" : "var(--dsw-alias-bg-base)",
      color: active ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-label-secondary)",
      fontWeight: active ? 600 : 400,
      cursor: "pointer",
    });

    const fmtB = (n) => (typeof n === "number" && n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n || 0} B`);

    /**
     * 细长进度条。放在模块级（不是一个组件内部）—— MemoryPanel 和
     * DreamSettings 都要用；只定义在 MemoryPanel 里的话，设置页引用它会
     * ReferenceError，表现为「设置页整个不渲染」（2026-11-21 踩的）。
     */
    const bar = (pct, danger) => S.jsx("div", {
      style: { height: 6, borderRadius: 3, background: "var(--dsw-alias-bg-l2, #e8e8e8)", overflow: "hidden", marginTop: 6 },
      children: S.jsx("div", {
        style: {
          width: `${Math.min(100, Math.max(0, pct))}%`,
          height: "100%",
          background: danger
            ? "var(--dsw-alias-state-error-primary, #d33)"
            : "var(--dsw-alias-state-success-primary, #4caf50)",
        },
      }),
    });

    /** 「记忆注入」子 Tab：只读快照，显示 system prompt 里实际注入了什么。 */
    function MemoryPanel({ data, runtime }) {
      /*
       * ⚠️ hooks 必须放在下面的 early return 之前 —— React 规定每次渲染的
       * hooks 顺序必须一致，把 useState/useEffect 写在 return 后面会直接报
       * "Rendered more hooks than during the previous render"。
       */
      const [vec, setVec] = React.useState(null);
      const [vecBusy, setVecBusy] = React.useState(false);
      // 手动触发重跑（暂停/继续之后要重新开轮询，光靠 phase 变化不可靠）
      const [vecTick, setVecTick] = React.useState(0);

      React.useEffect(() => {
        let current = true;
        let timer = null;
        const poll = () => {
          Promise.resolve().then(() => runtime.vectorStatus()).then((st) => {
            if (!current) return;
            setVec(st || null);
            // 还有活干就继续盯；idle / paused 停下来别再空转
            const active = st && st.enabled && st.pending > 0 && st.phase !== "paused";
            if (active) timer = setTimeout(poll, 3000);
          }).catch(() => { if (current) setVec(null); });
        };
        poll();
        return () => { current = false; if (timer) clearTimeout(timer); };
      }, [runtime, vecTick]);

      const toggleVec = () => {
        if (!vec || vecBusy) return;
        setVecBusy(true);
        const action = vec.phase === "paused" ? runtime.vectorResume : runtime.vectorPause;
        Promise.resolve().then(action)
          .then(() => runtime.vectorStatus())
          .then((st) => { setVec(st || null); setVecTick((t) => t + 1); })
          .catch(() => {})
          .finally(() => setVecBusy(false));
      };

      if (data === null) return S.jsx("p", { style: empty, children: "加载中…" });
      const m = data;
      const budget = m.budgetBytes || 10240;
      const errColor = "var(--dsw-alias-state-error-primary, #d33)";
      return S.jsxs("div", { children: [
        S.jsxs("div", { style: card, children: [
          S.jsx("div", { style: title, children: "MEMORY.md —— 公共环境事实" }),
          S.jsx("div", { style: meta, children: `${m.memoryPath || ""} · ${fmtB(m.memoryBytes)} / 上限 ${fmtB(budget)}` }),
          bar((m.memoryBytes / budget) * 100, m.memoryBytes > budget * 0.9),
        ]}),
        S.jsxs("div", { style: card, children: [
          S.jsx("div", { style: title, children: "USER.md —— 各工作区个人事实" }),
          S.jsx("div", { style: { ...meta, marginBottom: 4 }, children: "MEMORY + USER 合计必须 ≤ 上限，超了截断 USER 并告警" }),
          (m.workspaces || []).length === 0 ? S.jsx("div", { style: empty, children: "没有找到工作区 USER.md" }) :
            m.workspaces.map((w) => S.jsxs("div", { key: w.name, style: { marginTop: 12 }, children: [
              S.jsxs("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 13, gap: 12 }, children: [
                S.jsx("span", { style: { fontWeight: 500 }, children: w.name }),
                S.jsx("span", {
                  style: { color: (w.impossible || w.truncated) ? errColor : "var(--dsw-alias-label-secondary)" },
                  children: `${fmtB(w.userBytes)} · 合计 ${fmtB(w.totalBytes)} · 余 ${fmtB(Math.max(0, w.headroomBytes))}`,
                }),
              ] }),
              bar((w.totalBytes / budget) * 100, w.impossible || w.truncated),
              w.impossible ? S.jsx("div", { style: { fontSize: 12, color: errColor, marginTop: 4 }, children: "MEMORY 独占预算，USER 完全放不进" }) : null,
              w.truncated ? S.jsx("div", { style: { fontSize: 12, color: errColor, marginTop: 4 }, children: "超预算，正在截断注入" }) : null,
            ] })),
        ]}),
        vec ? S.jsxs("div", { style: card, children: [
          S.jsx("div", { style: title, children: "语义索引" }),
          vec.enabled === false
            ? S.jsx("div", { style: meta, children: "未启用。到「设置 → 梦境记忆 → 语义检索」打开。" })
            : S.jsxs("div", { children: [
              S.jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 13 }, children: [
                S.jsx("span", {
                  style: { fontWeight: 500 },
                  children: ({
                    warming: "① 建立近期索引",
                    building: "② 补齐历史索引",
                    updating: "追平新消息",
                    idle: "✓ 索引已是最新",
                    paused: "已暂停",
                  })[vec.phase] || vec.phase,
                }),
                vec.phase !== "idle" ? S.jsx("button", {
                  type: "button",
                  disabled: vecBusy,
                  onClick: toggleVec,
                  style: { padding: "2px 10px", fontSize: 12, cursor: vecBusy ? "default" : "pointer" },
                  children: vec.phase === "paused" ? "继续" : "暂停",
                }) : null,
              ] }),
              bar(Number(vec.total) > 0 ? (Number(vec.indexed) / Number(vec.total)) * 100 : 0, false),
              S.jsxs("div", {
                style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", marginTop: 6, display: "flex", flexWrap: "wrap", gap: 10 },
                children: [
                  S.jsx("span", { children: `已索引 ${Number(vec.indexed || 0).toLocaleString()} / ${Number(vec.total || 0).toLocaleString()}` }),
                  vec.pending > 0 ? S.jsx("span", { children: `待补 ${Number(vec.pending).toLocaleString()}` }) : null,
                  vec.etaMinutes ? S.jsx("span", { children: `预计还需 ${vec.etaMinutes} 分钟` }) : null,
                  vec.avgMsPerItem ? S.jsx("span", { children: `约 ${vec.avgMsPerItem} ms/条` }) : null,
                ],
              }),
            ] }),
        ]}) : null,
        S.jsxs("details", { style: card, children: [
          S.jsx("summary", { style: { ...title, cursor: "pointer", marginBottom: 0 }, children: "展开 MEMORY.md 正文" }),
          S.jsx("pre", { style: { ...body, fontSize: 12, marginTop: 10, marginBottom: 0 }, children: m.memoryText || "（空）" }),
        ]}),
        (m.workspaces || []).map((w) => S.jsxs("details", { key: `d-${w.name}`, style: card, children: [
          S.jsx("summary", { style: { ...title, cursor: "pointer", marginBottom: 0 }, children: `展开 ${w.name}/USER.md 正文` }),
          S.jsx("pre", { style: { ...body, fontSize: 12, marginTop: 10, marginBottom: 0 }, children: w.userText || "（空）" }),
        ] })),
      ] });
    }

    function DreamView({ runtime }) {
      const [tab, setTab] = React.useState("dreams"); // "dreams" | "promotions" | "memory"
      const [date, setDate] = React.useState(todayStr());
      const [dreams, setDreams] = React.useState(null);
      const [promotions, setPromotions] = React.useState(null);
      const [memory, setMemory] = React.useState(null);
      const [error, setError] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [tick, setTick] = React.useState(0);

      // 梦境日记：按选中日期查询（默认今天，即今天凌晨的梦境）。
      React.useEffect(() => {
        let current = true;
        setDreams(null);
        runtime.listDreams({ date })
          .then((d) => { if (current) { setDreams(d || []); setError(""); } })
          .catch((e) => { if (current) setError(e.message); });
        return () => { current = false; };
      }, [runtime, date, tick]);

      // 晋升记录：独立加载（首次 + 刷新）。
      React.useEffect(() => {
        let current = true;
        setPromotions(null);
        runtime.listPromotions()
          .then((p) => { if (current) { setPromotions(p || []); setError(""); } })
          .catch((e) => { if (current) setError(e.message); });
        return () => { current = false; };
      }, [runtime, tick]);

      // 记忆注入快照：只在切到该 Tab 时拉取。
      React.useEffect(() => {
        if (tab !== "memory") return;
        let current = true;
        setMemory(null);
        runtime.memoryStatus()
          .then((m) => { if (current) { setMemory(m || null); setError(""); } })
          .catch((e) => { if (current) setError(e.message); });
        return () => { current = false; };
      }, [runtime, tab, tick]);

      const triggerDream = () => {
        setBusy(true);
        runtime.runNow()
          .then(() => { setTimeout(() => setTick((t) => t + 1), 3000); })
          .catch((e) => setError(e.message))
          .finally(() => setBusy(false));
      };

      return S.jsx("div", {
        style: page,
        children: S.jsx("div", {
          style: pageScroll,
          children: S.jsx("div", {
            style: pageContent,
            children: S.jsxs("div", {
              children: [
                // 页面标题栏（独立页面的页头；左侧菜单点进来就是这个页面）
                S.jsxs("div", { style: pageHeading, children: [
                  S.jsx("h1", { style: h1, children: "🌙 梦境记忆" }),
                  S.jsxs("div", { style: { display: "flex", gap: 8, alignItems: "center", flex: "none" }, children: [
                    S.jsx("button", {
                      type: "button",
                      disabled: busy,
                      onClick: triggerDream,
                      style: { padding: "6px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", cursor: busy ? "default" : "pointer", fontWeight: 500 },
                      children: busy ? "做梦进行中…" : "立即做梦",
                    }),
                    S.jsx("button", {
                      type: "button",
                      onClick: () => setTick((t) => t + 1),
                      style: { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", cursor: "pointer" },
                      children: "刷新",
                    }),
                  ]}),
                ]}),
          error ? S.jsx("p", { style: { color: "var(--dsw-alias-state-error-primary)", marginBottom: 12 }, children: `加载失败：${error}` }) : null,

          // 子 Tab
          S.jsxs("div", { style: { display: "flex", gap: 8, marginBottom: 16 }, children: [
            S.jsx("button", { type: "button", onClick: () => setTab("dreams"), style: tabBtn(tab === "dreams"), children: "梦境日记" }),
            S.jsx("button", { type: "button", onClick: () => setTab("promotions"), style: tabBtn(tab === "promotions"), children: `晋升沉淀${promotions && promotions.length ? ` (${promotions.length})` : ""}` }),
            S.jsx("button", { type: "button", onClick: () => setTab("memory"), style: tabBtn(tab === "memory"), children: "记忆注入" }),
          ]}),

          tab === "dreams" ? S.jsxs("div", { children: [
            // 日期查询
            S.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }, children: [
              S.jsx("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary)" }, children: "按日期查看：" }),
              S.jsx("input", {
                type: "date",
                value: date,
                max: todayStr(),
                onChange: (e) => setDate(e.target.value || todayStr()),
                style: { padding: "5px 8px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", fontFamily: "inherit" },
              }),
              S.jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }, children: "默认今天凌晨的梦境，可选历史日期" }),
            ]}),
            !dreams ? S.jsx("p", { style: empty, children: "加载中…" }) :
              dreams.length === 0 ? S.jsx("p", { style: empty, children: `${date} 没有梦境日记 —— 梦境会在凌晨随机时间自动运行，也可点「立即做梦」。` }) :
                dreams.map((d) => S.jsxs("div", { key: d.id, style: card, children: [
                  S.jsx("div", { style: title, children: `🌙 ${d.date}` }),
                  S.jsx("div", { style: meta, children: `#${d.id} · ${new Date(d.created_at).toLocaleString("zh-CN")}` }),
                  S.jsx("div", { style: body, children: d.content }),
                ] })),
          ]}) : tab === "promotions" ? S.jsxs("div", { children: [
            !promotions ? S.jsx("p", { style: empty, children: "加载中…" }) :
              promotions.length === 0 ? S.jsx("p", { style: empty, children: "暂无晋升记录。" }) :
                promotions.map((p) => S.jsxs("div", { key: p.id, style: card, children: [
                  S.jsx("div", { style: meta, children: `${p.dream_date || "—"} · ${p.target}` }),
                  S.jsx("div", { style: body, children: p.content }),
                ] })),
              ]}) : S.jsx(MemoryPanel, { data: memory, runtime }),
              ],
            }),
          }),
        }),
      });
    }

    const inject = ["slots", "connection", "remote"];

    // ── remote 贡献：声明 host remote service（梦境设置读写） ────────────────
    const identity = (value) => value;
    const codec = (symbol) => ({ mode: "strict", typeSymbol: symbol, schema: { parse: identity }, create: () => ({ parse: identity }) });
    const CONTRIBUTION = {
      package: "dsh-dreaming",
      descriptors: [
        {
          id: "dsh-dreaming#dreaming/getConfig",
          service: "dreaming",
          namespace: "dreaming",
          method: "getConfig",
          invocation: { kind: "direct" },
          parameters: [],
          result: codec("dsh-dreaming#DreamingConfig"),
        },
        {
          id: "dsh-dreaming#dreaming/listProviders",
          service: "dreaming",
          namespace: "dreaming",
          method: "listProviders",
          invocation: { kind: "direct" },
          parameters: [],
          result: codec("dsh-dreaming#ProviderList"),
        },
        {
          id: "dsh-dreaming#dreaming/listModels",
          service: "dreaming",
          namespace: "dreaming",
          method: "listModels",
          invocation: { kind: "direct" },
          parameters: [{ name: "payload", wire: "payload", source: "json", codec: codec("dsh-dreaming#ProviderParam") }],
          result: codec("dsh-dreaming#ModelList"),
        },
        {
          id: "dsh-dreaming#dreaming/setConfig",
          service: "dreaming",
          namespace: "dreaming",
          method: "setConfig",
          invocation: { kind: "direct" },
          parameters: [{ name: "payload", wire: "payload", source: "json", codec: codec("dsh-dreaming#SetPayload") }],
          result: codec("dsh-dreaming#SetResult"),
        },
      ],
    };

    const row = { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 };
    const labelStyle = { flex: "0 0 110px", fontWeight: 500, fontSize: 13 };
    const inputStyle = { flex: 1, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, #ddd)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", fontFamily: "inherit" };

    /** Settings → 梦境记忆：默认工作区 + 随机窗口。 */
    /**
     * 设置页区块的错误边界。
     *
     * 为什么需要它：Settings 渲染时如果某个 section 组件抛异常，React 会把
     * **整个区块**卸载掉，页面上什么都不显示、控制台也未必看得见 ——
     * 排查时完全抓瞎（2026-11-21 就是这样白了两轮）。
     * 有了它，异常会以文本形式直接印在设置页上，一眼能看到出错行。
     */
    class SectionBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
      }
      static getDerivedStateFromError(err) {
        return { err };
      }
      render() {
        if (this.state.err) {
          const e = this.state.err;
          return S.jsx("pre", {
            style: {
              margin: 0,
              padding: 10,
              fontSize: 11,
              lineHeight: 1.5,
              color: "var(--dsw-alias-state-error-primary, #d33)",
              background: "var(--dsw-alias-bg-l2, #f6f6f6)",
              borderRadius: 6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              maxHeight: 320,
              overflow: "auto",
            },
            children: `梦境记忆设置渲染失败：\n${String(e?.stack || e)}`,
          });
        }
        return this.props.children;
      }
    }

    function DreamSettings(props) {
      const { getConfig, setConfig, listProviders, listModels, runtime } = props;
      const [state, setState] = React.useState({ status: "loading", writable: true });
      const [memoryEnabled, setMemoryEnabled] = React.useState(true);
      const [storeReasoning, setStoreReasoning] = React.useState(false);
      const [maxPerTurn, setMaxPerTurn] = React.useState(2000);
      const [memoryVerbose, setMemoryVerbose] = React.useState(true);
      const [dreamingEnabled, setDreamingEnabled] = React.useState(true);
      const [nudgeEnabled, setNudgeEnabled] = React.useState(true);
      const [nudgeTurnThreshold, setNudgeTurnThreshold] = React.useState(10);
      const [nudgeMinGapMin, setNudgeMinGapMin] = React.useState(5);
      const [semanticEnabled, setSemanticEnabled] = React.useState(false);
      const [semanticAutoInject, setSemanticAutoInject] = React.useState(true);
      const [semanticIntervalMin, setSemanticIntervalMin] = React.useState(10);
      const [semanticMinScore, setSemanticMinScore] = React.useState(0.62);
      const [semanticTopK, setSemanticTopK] = React.useState(6);
      const [semanticVectorWeight, setSemanticVectorWeight] = React.useState(0.7);
      const [semanticMaxSnippetChars, setSemanticMaxSnippetChars] = React.useState(200);
      const [semanticAutoDownload, setSemanticAutoDownload] = React.useState(true);
      // 模型运行状态（只读，来自 vectorStatus）—— 与配置项无关，不参与保存。
      const [vecModel, setVecModel] = React.useState(null);
      const [modelBusy, setModelBusy] = React.useState(false);
      const [provider, setProvider] = React.useState("");
      const [windowStart, setWindowStart] = React.useState("02:00");
      const [windowEnd, setWindowEnd] = React.useState("04:30");
      const [model, setModel] = React.useState("");
      const [reasoningEffort, setReasoningEffort] = React.useState("high");
      const [stepTimeoutSec, setStepTimeoutSec] = React.useState(0);
      const [providers, setProviders] = React.useState([]);
      const [models, setModels] = React.useState([]);
      const [saved, setSaved] = React.useState(false);
      const [loadTick, setLoadTick] = React.useState(0);

      React.useEffect(() => {
        let current = true;
        Promise.resolve().then(() => getConfig()).then((cfg) => {
          if (!current) return;
          setMemoryEnabled(cfg?.memoryEnabled !== false);
          setStoreReasoning(cfg?.storeReasoning === true);
          if (typeof cfg?.maxPerTurn === "number") setMaxPerTurn(cfg.maxPerTurn);
          setMemoryVerbose(cfg?.memoryVerbose !== false);
          setDreamingEnabled(cfg?.dreamingEnabled !== false);
          setNudgeEnabled(cfg?.nudgeEnabled !== false);
          if (typeof cfg?.nudgeTurnThreshold === "number") setNudgeTurnThreshold(cfg.nudgeTurnThreshold);
          if (typeof cfg?.nudgeMinGapMin === "number") setNudgeMinGapMin(cfg.nudgeMinGapMin);
          setSemanticEnabled(cfg?.semanticEnabled === true);
          setSemanticAutoInject(cfg?.semanticAutoInject !== false);
          if (typeof cfg?.semanticIntervalMin === "number") setSemanticIntervalMin(cfg.semanticIntervalMin);
          if (typeof cfg?.semanticMinScore === "number") setSemanticMinScore(cfg.semanticMinScore);
          if (typeof cfg?.semanticTopK === "number") setSemanticTopK(cfg.semanticTopK);
          if (typeof cfg?.semanticVectorWeight === "number") setSemanticVectorWeight(cfg.semanticVectorWeight);
          if (typeof cfg?.semanticMaxSnippetChars === "number") setSemanticMaxSnippetChars(cfg.semanticMaxSnippetChars);
          setSemanticAutoDownload(cfg?.semanticAutoDownload !== false);
          setWindowStart(typeof cfg?.windowStart === "string" ? cfg.windowStart : "02:00");
          setWindowEnd(typeof cfg?.windowEnd === "string" ? cfg.windowEnd : "04:30");
          setProvider(typeof cfg?.provider === "string" ? cfg.provider : "");
          setModel(typeof cfg?.model === "string" ? cfg.model : "");
          setReasoningEffort(typeof cfg?.reasoningEffort === "string" ? cfg.reasoningEffort : "high");
          if (typeof cfg?.stepTimeoutSec === "number") setStepTimeoutSec(cfg.stepTimeoutSec);
          setState({ status: "ready", writable: cfg?.writable !== false });
        }, () => { if (current) setState({ status: "error", writable: true }); });
        return () => { current = false; };
      }, [getConfig, loadTick]);

      /*
       * 模型运行状态轮询。
       *
       * 只在「正在下载」时密集轮询（1 秒）—— 313MB 要下几分钟，
       * 用 3 秒间隔百分比会一顿一顿地跳，看着像卡住。
       * 其他状态（ready / missing / failed）是静态的，拉一次就够，
       * 不轮询也不占 RPC。
       */
      React.useEffect(() => {
        let current = true;
        let timer = null;
        const pull = () => {
          Promise.resolve().then(() => runtime?.vectorStatus?.()).then((st) => {
            if (!current || !st) return;
            setVecModel(st.model || null);
            if (st.model?.state === "loading") timer = setTimeout(pull, 1000);
          }).catch(() => { if (current) setVecModel(null); });
        };
        pull();
        return () => { current = false; if (timer) clearTimeout(timer); };
      }, [runtime, loadTick]);

      // 加载可用 provider 目录；provider 变化时加载其模型列表。
      React.useEffect(() => {
        let current = true;
        Promise.resolve().then(() => listProviders()).then((list) => {
          if (current) setProviders(list || []);
        }).catch(() => {});
        return () => { current = false; };
      }, [listProviders, loadTick]);
      React.useEffect(() => {
        let current = true;
        if (!provider) { setModels([]); return () => { current = false; }; }
        setModels(null);
        Promise.resolve().then(() => listModels({ provider })).then((list) => {
          if (current) setModels(list || []);
        }).catch(() => { if (current) setModels([]); });
        return () => { current = false; };
      }, [listModels, provider, loadTick]);

      // 思考等级下拉：优先用所选模型自报的支持档位（listModels 附带的 efforts），
      // 模型未选/能力未知时回落标准五档。
      const selectedModel = (models || []).find((m) => m.id === model);
      const effortOptions = Array.isArray(selectedModel?.efforts) && selectedModel.efforts.length > 0
        ? selectedModel.efforts
        : ["off", "low", "medium", "high", "max"];

      const save = () => {
        Promise.resolve().then(() => setConfig({
          provider, model, reasoningEffort, windowStart, windowEnd, stepTimeoutSec,
          memoryEnabled, storeReasoning, maxPerTurn, memoryVerbose, dreamingEnabled,
          nudgeEnabled, nudgeTurnThreshold, nudgeMinGapMin,
          semanticEnabled, semanticAutoInject, semanticIntervalMin, semanticMinScore,
          semanticTopK, semanticVectorWeight, semanticMaxSnippetChars,
        }))
          .then(() => { setSaved(true); setTimeout(() => setSaved(false), 1500); })
          .catch((e) => console.error("dsh-dreaming save failed", e));
      };

      if (state.status === "loading") return S.jsx("p", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: "正在读取梦境配置…" });
      if (state.status === "error") return S.jsxs("div", { children: [
        S.jsx("p", { style: { color: "var(--dsw-alias-state-error-primary)" }, children: "暂时无法读取配置。" }),
        S.jsx("button", { onClick: () => setLoadTick((t) => t + 1), style: { marginTop: 8, padding: "4px 10px" }, children: "重试" }),
      ] });

      const writable = state.writable;
      const hint = { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 };
      const groupTitle = { margin: "18px 0 8px", fontWeight: 600, fontSize: 13, color: "var(--dsw-alias-label-secondary)" };
      /*
       * 可折叠分组。用原生 <details>/<summary> —— 不用自己管展开状态，
       * 键盘和读屏都能用，也不需要额外 state。
       */
      const groupBox = {
        margin: "10px 0",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8,
        // 左右留出内边距给内容；summary 用负 margin 顶回去，让标题背景铺满整行
        padding: "0 12px 4px",
      };
      const groupSummary = {
        margin: "0 -12px 8px",
        padding: "10px 12px",
        fontWeight: 600,
        fontSize: 13,
        color: "var(--dsw-alias-label-secondary)",
        cursor: "pointer",
        background: "var(--dsw-alias-bg-l1, #fafafa)",
        userSelect: "none",
        // 不设 listStyle: none —— 那会把原生三角一起藏掉，用户就看不出能展开
      };
      return S.jsxs("div", { style: { maxWidth: 640, fontFamily: "inherit", fontSize: 14, lineHeight: 1.6 }, children: [
        S.jsx("p", { style: { color: "var(--dsw-alias-label-secondary)", margin: "0 0 12px" }, children: "本插件管两件事：① 梦境——每天凌晨随机窗口内运行一次，从全部工作区取材，生成梦境日记，并把高价值洞察晋升进 MEMORY.md；② 对话沉淀——对话进行中每隔若干轮，把值得记的内容抄进当天的 memory/daily 草稿，夜间再由梦境提炼成长期记忆。时间均为本地时间 HH:mm。" }),
        S.jsxs("div", { style: { display: "flex", gap: 10 }, children: [
          S.jsxs("div", { style: { ...row, flex: 1 }, children: [
            S.jsx("label", { style: labelStyle, children: "窗口开始" }),
            S.jsx("input", { type: "time", value: windowStart, disabled: !writable, onChange: (e) => setWindowStart(e.target.value), style: inputStyle }),
          ] }),
          S.jsxs("div", { style: { ...row, flex: 1 }, children: [
            S.jsx("label", { style: labelStyle, children: "窗口结束" }),
            S.jsx("input", { type: "time", value: windowEnd, disabled: !writable, onChange: (e) => setWindowEnd(e.target.value), style: inputStyle }),
          ] }),
        ] }),
        S.jsx("div", { style: row, children: [
          S.jsx("label", { style: labelStyle, children: "Provider" }),
          S.jsx("select", { value: provider, disabled: !writable, onChange: (e) => { setProvider(e.target.value); setModel(""); }, style: inputStyle, children: [
            S.jsx("option", { value: "", children: "（全局默认）" }),
            ...providers.map((p) => S.jsx("option", { key: p.id, value: p.id, children: `${p.name} (${p.id})` })),
          ] }),
        ] }),
        S.jsx("div", { style: row, children: [
          S.jsx("label", { style: labelStyle, children: "模型" }),
          S.jsx("select", { value: model, disabled: !writable || !provider, onChange: (e) => setModel(e.target.value), style: inputStyle, children: [
            S.jsx("option", { value: "", children: "（全局默认）" }),
            ...(models || []).map((m) => S.jsx("option", { key: m.id, value: m.id, children: m.name })),
          ] }),
        ] }),
        S.jsxs("div", { style: row, children: [
          S.jsx("label", { style: labelStyle, children: "思考等级" }),
          S.jsx("select", { value: reasoningEffort, disabled: !writable, onChange: (e) => setReasoningEffort(e.target.value), style: inputStyle, children: [
            S.jsx("option", { value: "", children: "（provider 默认）" }),
            ...effortOptions.map((lvl) => S.jsx("option", { key: lvl, value: lvl, children: lvl })),
          ] }),
          S.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 }, children: selectedModel?.defaultEffort ? `模型默认：${selectedModel.defaultEffort}` : "默认 high；仅影响梦境会话" }),
        ] }),
        S.jsxs("div", { style: row, children: [
          S.jsx("label", { style: labelStyle, children: "单步超时" }),
          S.jsx("input", { type: "number", min: 0, step: 1, value: stepTimeoutSec, disabled: !writable, onChange: (e) => setStepTimeoutSec(Number(e.target.value) || 0), style: { ...inputStyle, maxWidth: 160 }, placeholder: "0 = 不限制" }),
          S.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 }, children: "秒，单步（一次模型请求）超过该时长强制中断，0 = 不限制" }),
        ] }),
        S.jsxs("details", { style: groupBox, children: [
          S.jsx("summary", { style: groupSummary, children: "记忆" }),
          S.jsxs("div", { style: row, children: [
            S.jsx("label", { style: labelStyle, children: "对话落库" }),
            S.jsxs("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: writable ? "pointer" : "default" }, children: [
              S.jsx("input", { type: "checkbox", checked: memoryEnabled, disabled: !writable, onChange: (e) => setMemoryEnabled(e.target.checked) }),
              S.jsx("span", { style: hint, children: "把每轮对话存进本地库，供检索" }),
            ] }),
          ] }),
          S.jsxs("div", { style: row, children: [
            S.jsx("label", { style: labelStyle, children: "记录思考过程" }),
            S.jsxs("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: writable ? "pointer" : "default" }, children: [
              S.jsx("input", { type: "checkbox", checked: storeReasoning, disabled: !writable, onChange: (e) => setStoreReasoning(e.target.checked) }),
              S.jsx("span", { style: hint, children: "体积大，默认关" }),
            ] }),
          ] }),
          S.jsxs("div", { style: row, children: [
            S.jsx("label", { style: labelStyle, children: "单轮上限" }),
            S.jsx("input", { type: "number", min: 1, step: 100, value: maxPerTurn, disabled: !writable, onChange: (e) => setMaxPerTurn(Number(e.target.value) || 2000), style: { ...inputStyle, maxWidth: 160 } }),
            S.jsx("span", { style: hint, children: "条，单轮最多入库多少条" }),
          ] }),
          S.jsxs("div", { style: row, children: [
            S.jsx("label", { style: labelStyle, children: "落库日志" }),
            S.jsxs("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: writable ? "pointer" : "default" }, children: [
              S.jsx("input", { type: "checkbox", checked: memoryVerbose, disabled: !writable, onChange: (e) => setMemoryVerbose(e.target.checked) }),
              S.jsx("span", { style: hint, children: "关掉只保留错误日志" }),
            ] }),
          ] }),
          S.jsxs("div", { style: row, children: [
            S.jsx("label", { style: labelStyle, children: "梦境提炼" }),
            S.jsxs("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: writable ? "pointer" : "default" }, children: [
              S.jsx("input", { type: "checkbox", checked: dreamingEnabled, disabled: !writable, onChange: (e) => setDreamingEnabled(e.target.checked) }),
              S.jsx("span", { style: hint, children: "每晚从 daily 提炼到 MEMORY.md / USER.md" }),
            ] }),
          ] }),
        ] }),
        S.jsxs("details", { style: groupBox, children: [
          S.jsx("summary", { style: groupSummary, children: "语义检索" }),
          S.jsxs("div", { style: row, children: [
            S.jsx("label", { style: labelStyle, children: "启用" }),
            S.jsxs("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: writable ? "pointer" : "default" }, children: [
              S.jsx("input", {
                type: "checkbox", checked: semanticEnabled, disabled: !writable,
                onChange: (e) => {
                  const on = e.target.checked;
                  // 打开要先确认：首次开启会启动嵌入子进程并开始建立索引，
                  // 这一步在 2 核机器上要占不少时间，不该一次误点就悄悄开始。
                  if (on && !window.confirm("开启后会立即开始为历史对话建立向量索引，\n期间会持续占用一个 CPU 核心（可随时暂停）。\n\n现在开启吗？")) return;
                  setSemanticEnabled(on);
                },
              }),
              S.jsx("span", { style: hint, children: "向量语义检索；关闭时行为与现在完全一致" }),
            ] }),
          ] }),
          /*
           * 嵌入模型状态（2026-11-21）。
           * 放在启用开关之后、子配置之前 —— 开关关着也要能看到模型有没有。
           * 这是只读状态，不参与保存。
           */
          (() => {
            const mdl = vecModel;
            if (!mdl) return null;
            const st = mdl.state || "missing";
            const tone = st === "ready"
              ? "var(--dsw-alias-state-success-primary, #4caf50)"
              : st === "failed" ? "var(--dsw-alias-state-error-primary, #d33)" : "var(--dsw-alias-label-secondary)";
            const text = st === "ready"
              ? `✓ 已就绪 · ${mdl.displaySize || fmtB(mdl.bytes || 0)}`
              : st === "loading"
                ? `下载中 ${mdl.percent || 0}% · ${mdl.speedBps ? (mdl.speedBps / 1048576).toFixed(1) : "0"} MB/s`
                : st === "failed"
                  ? `不可用：${mdl.error || "未知原因"}${noEngine ? "（装好依赖后重启）" : ""}`
                  : `未检测到 · 需要 313MB`;
            // no_engine 缺的是 node-llama-cpp，不是模型文件 —— 再下载多少次也没用，
            // 别给一个按下去必然无效的「重试」按钮。
            const noEngine = st === "failed" && mdl.errorCode === "no_engine";
            const canDownload = (st === "missing" && semanticAutoDownload) || (st === "failed" && !noEngine);
            return S.jsxs("div", { style: { marginTop: 6 }, children: [
              S.jsxs("div", { style: row, children: [
                S.jsx("label", { style: labelStyle, children: "嵌入模型" }),
                S.jsxs("div", { style: { flex: 1, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }, children: [
                  S.jsx("span", { style: { fontSize: 13, color: tone, fontWeight: st === "ready" ? 500 : 400 }, children: text }),
                  canDownload ? S.jsx("button", {
                    type: "button",
                    disabled: modelBusy || st === "loading",
                    onClick: () => {
                      setModelBusy(true);
                      Promise.resolve().then(() => runtime.downloadModel())
                        .catch(() => {})
                        .finally(() => {
                          // 下载在后台跑，这里只是把按钮解锁；进度靠轮询反映
                          setTimeout(() => setModelBusy(false), 800);
                        });
                    },
                    style: { padding: "2px 10px", fontSize: 12, cursor: modelBusy ? "default" : "pointer" },
                    children: st === "failed" ? "重试" : "下载",
                  }) : null,
                  mdl.state === "loading" ? S.jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, children: `${fmtB(mdl.downloaded || 0)} / ${fmtB(mdl.total || 0)} · 源 ${mdl.host || "huggingface.co"}` }) : null,
                ] }),
              ] }),
              // 下载中才画进度条，其他状态不占纵向空间
              st === "loading" ? bar(mdl.percent || 0, false) : null,
              // 就绪时把实际路径露出来 —— 排查「到底用的哪个文件」时这是唯一线索
              st === "ready" && mdl.path ? S.jsx("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)", marginTop: 2, wordBreak: "break-all" }, children: mdl.path }) : null,
              st === "missing" && !semanticAutoDownload ? S.jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary, #d33)", marginTop: 4 }, children: "自动下载已关闭。把模型文件放进 ~/.node-llama-cpp/models，或用 DSH_VEC_MODEL 指定路径。" }) : null,
            ] });
          })(),
          semanticEnabled ? S.jsxs("div", { style: { marginTop: 8 }, children: [
            S.jsxs("div", { style: row, children: [
              S.jsx("label", { style: labelStyle, children: "自动注入" }),
              S.jsxs("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: writable ? "pointer" : "default" }, children: [
                S.jsx("input", { type: "checkbox", checked: semanticAutoInject, disabled: !writable, onChange: (e) => setSemanticAutoInject(e.target.checked) }),
                S.jsx("span", { style: hint, children: "每轮对话自动检索相关记忆并注入；关掉则只索引不注入" }),
              ] }),
            ] }),
            S.jsxs("div", { style: row, children: [
              S.jsx("label", { style: labelStyle, children: "同步间隔" }),
              S.jsx("input", { type: "number", min: 1, step: 1, value: semanticIntervalMin, disabled: !writable, onChange: (e) => setSemanticIntervalMin(Math.max(1, Number(e.target.value) || 10)), style: { ...inputStyle, maxWidth: 120 } }),
              S.jsx("span", { style: hint, children: "分钟；索引追平后按此间隔检查新消息" }),
            ] }),
            S.jsxs("div", { style: row, children: [
              S.jsx("label", { style: labelStyle, children: "相似度下限" }),
              S.jsx("input", { type: "number", min: 0, max: 1, step: 0.01, value: semanticMinScore, disabled: !writable, onChange: (e) => setSemanticMinScore(Math.min(1, Math.max(0, Number(e.target.value) || 0.62))), style: { ...inputStyle, maxWidth: 120 } }),
              S.jsx("span", { style: hint, children: "0–1，低于此分的命中被丢弃；实测中位数约 0.70" }),
            ] }),
            S.jsxs("div", { style: row, children: [
              S.jsx("label", { style: labelStyle, children: "返回条数" }),
              S.jsx("input", { type: "number", min: 1, max: 20, step: 1, value: semanticTopK, disabled: !writable, onChange: (e) => setSemanticTopK(Math.min(20, Math.max(1, Number(e.target.value) || 6))), style: { ...inputStyle, maxWidth: 120 } }),
              S.jsx("span", { style: hint, children: "条，合并后最多返回多少条" }),
            ] }),
            S.jsxs("div", { style: row, children: [
              S.jsx("label", { style: labelStyle, children: "向量权重" }),
              S.jsx("input", { type: "number", min: 0, max: 1, step: 0.05, value: semanticVectorWeight, disabled: !writable, onChange: (e) => setSemanticVectorWeight(Math.min(1, Math.max(0, Number(e.target.value) || 0.7))), style: { ...inputStyle, maxWidth: 120 } }),
              S.jsx("span", { style: hint, children: "0–1，其余权重自动分给关键词；两路都归一后加权" }),
            ] }),
            S.jsxs("div", { style: row, children: [
              S.jsx("label", { style: labelStyle, children: "片段长度" }),
              S.jsx("input", { type: "number", min: 50, step: 10, value: semanticMaxSnippetChars, disabled: !writable, onChange: (e) => setSemanticMaxSnippetChars(Math.max(50, Number(e.target.value) || 200)), style: { ...inputStyle, maxWidth: 120 } }),
              S.jsx("span", { style: hint, children: "字，注入时每条截断到这个长度" }),
            ] }),
          ] }) : null,
        ] }),
        S.jsxs("details", { style: groupBox, children: [
          S.jsx("summary", { style: groupSummary, children: "对话沉淀" }),
          S.jsxs("div", { style: row, children: [
            S.jsx("label", { style: labelStyle, children: "启用" }),
            S.jsxs("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: writable ? "pointer" : "default" }, children: [
              S.jsx("input", { type: "checkbox", checked: nudgeEnabled, disabled: !writable, onChange: (e) => setNudgeEnabled(e.target.checked) }),
              S.jsx("span", { style: hint, children: "对话进行中把值得记的抄进 memory/daily，只写草稿层" }),
            ] }),
          ] }),
          S.jsxs("div", { style: row, children: [
            S.jsx("label", { style: labelStyle, children: "触发轮数" }),
            S.jsx("input", { type: "number", min: 1, step: 1, value: nudgeTurnThreshold, disabled: !writable || !nudgeEnabled, onChange: (e) => setNudgeTurnThreshold(Number(e.target.value) || 10), style: { ...inputStyle, maxWidth: 160 } }),
            S.jsx("span", { style: hint, children: "轮，累计多少轮对话沉淀一次" }),
          ] }),
          S.jsxs("div", { style: row, children: [
            S.jsx("label", { style: labelStyle, children: "最小间隔" }),
            S.jsx("input", { type: "number", min: 1, step: 1, value: nudgeMinGapMin, disabled: !writable || !nudgeEnabled, onChange: (e) => setNudgeMinGapMin(Number(e.target.value) || 5), style: { ...inputStyle, maxWidth: 160 } }),
            S.jsx("span", { style: hint, children: "分钟，同一会话两次沉淀之间至少隔这么久" }),
          ] }),
        ] }),
        S.jsxs("div", { style: { marginTop: 14, display: "flex", gap: 8 }, children: [
        S.jsx("button", { type: "button", disabled: !writable, onClick: save, style: { padding: "6px 14px", borderRadius: 8, cursor: writable ? "pointer" : "default", fontWeight: 500 }, children: saved ? "✓ 已保存" : "保存" }),
        S.jsx("button", { type: "button", disabled: !writable, onClick: () => setLoadTick((t) => t + 1), style: { padding: "6px 14px", borderRadius: 8, cursor: writable ? "pointer" : "default" }, children: "放弃修改" }),
        ] }),
      ] });
    }

    /**
     * 左侧菜单项图标：月牙。
     *
     * ⚠️ 对齐官方 TaskManagerIcon 的约束：返回的 <svg> 必须是侧边栏行的
     * **直接图形子元素**，不要再套一层 inline wrapper —— 官方注释说明，套 wrapper
     * 会让它成为行内盒的基线、把图标顶到标签上方（"an inline wrapper makes it the
     * baseline of a line box inside the row's glyph slot, which lifts it above the
     * label"）。侧边栏自己负责无障碍导航标签，这里只负责画图形。
     */
    function DreamIcon(props) {
      const size = (props && props.size) || 16;
      return S.jsx("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        xmlns: "http://www.w3.org/2000/svg",
        "aria-hidden": "true",
        focusable: "false",
        children: S.jsx("path", {
          // 空心月牙（描边轮廓），与 ledger 的账本图标统一风格。
          // 内外弧半径差留足（6.8 / 4.4）：差值太小的话，16px 下 stroke 会把月牙糊实。
          d: "M8 1.4a6.8 6.8 0 1 0 6.8 6.8A4.4 4.4 0 0 1 8 1.4Z",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.4,
          strokeLinejoin: "round",
        }),
      });
    }

    function apply(ctx) {
      // 设置页卡片（Settings → 梦境记忆）—— 配置项留在这里，不搬进独立页面。
      const mount = ctx.remote.$mount(CONTRIBUTION);
      const callRemote = async (method, ...args) => {
        await mount;
        const remote = ctx.get("remote.dreaming");
        if (remote === void 0) throw new Error("remote.dreaming 不可用");
        const result = await remote[method](...args);
        if (!result || !result.ok) throw new Error(`dreaming.${method} failed`);
        return result.value;
      };
      const getConfig = () => callRemote("getConfig");
      const setConfig = (payload) => callRemote("setConfig", payload);
      const listProviders = () => callRemote("listProviders");
      const listModels = (payload) => callRemote("listModels", payload);

      /*
       * runtime 必须在这里就创建 —— 设置页（settings.section）也要用它读
       * vectorStatus，看模型是否就绪。原来它创建在下面页面注册之前，
       * 设置页拿不到，模型状态就画不出来。
       */
      const runtime = createDreamingRuntime(ctx.connection.rpc);

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "dreaming",
            order: 26,
            label: () => "梦境记忆",
            inject: () => ({ getConfig, setConfig, listProviders, listModels, runtime }),
          },
          // 用错误边界包一层：组件抛异常时把报错印在页面上，而不是整块消失
          (props) => S.jsx(SectionBoundary, { children: S.jsx(DreamSettings, props) }),
        ),
      );

      // ── 左侧菜单独立页面（2026-09-25 改版）───────────────────────────────
      // 对齐官方 @deepseek-ai/dsh-client-ui-schedule 的双注册做法：
      //   ① main 槽位         —— 页面本体，用 key 关联；
      //   ② sidebar.panellist —— 左侧菜单项，用 id 关联。
      // 两处共用同一个 id "dreaming"（页面写 key、菜单写 id），点菜单即切到该页面。
      // 注：原 conversation.view Tab 已移除 —— 同一功能不再重复占用会话页。
      // runtime 已在上面创建（设置页共用同一个实例，不重复构造）。
      const PAGE_ID = "dreaming";

      ctx.slots.inject("main", () =>
        ctx.slots.register(
          {
            name: "main",
            key: PAGE_ID,
            inject: () => ({ runtime }),
          },
          DreamView,
        ),
      );

      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PAGE_ID,
            order: 30,
            label: () => "梦境记忆",
          },
          DreamIcon,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
