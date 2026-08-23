/**
 * dsh-dreaming — client 半部分（浏览器 bundle）
 *
 * 在会话页面注册 "梦境" Tab（conversation.view 槽位，同 dsh-automation 模式）：
 * 内部再分"梦境日记 / 晋升沉淀"两个子 Tab；梦境日记支持按日期查询，
 * 默认展示今天（凌晨）的梦境，可手工选择日期查看历史。
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

    const tabBtn = (active) => ({
      padding: "6px 16px",
      borderRadius: 8,
      border: active ? "1px solid var(--dsw-alias-state-business-primary)" : "1px solid var(--dsw-alias-border-l2)",
      background: active ? "color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, var(--dsw-alias-bg-base))" : "var(--dsw-alias-bg-base)",
      color: active ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-label-secondary)",
      fontWeight: active ? 600 : 400,
      cursor: "pointer",
    });

    function DreamView({ runtime }) {
      const [tab, setTab] = React.useState("dreams"); // "dreams" | "promotions"
      const [date, setDate] = React.useState(todayStr());
      const [dreams, setDreams] = React.useState(null);
      const [promotions, setPromotions] = React.useState(null);
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

      const triggerDream = () => {
        setBusy(true);
        runtime.runNow()
          .then(() => { setTimeout(() => setTick((t) => t + 1), 3000); })
          .catch((e) => setError(e.message))
          .finally(() => setBusy(false));
      };

      return S.jsxs("div", {
        style: { maxWidth: 760, padding: "24px 20px", fontFamily: "var(--dsw-font-family,system-ui)", color: "var(--dsw-alias-label-primary)" },
        children: [
          S.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }, children: [
            S.jsx("span", { style: { fontSize: 17, fontWeight: 700 }, children: "🌙 梦境" }),
            S.jsx("button", {
              type: "button",
              disabled: busy,
              onClick: triggerDream,
              style: { marginLeft: "auto", padding: "6px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", cursor: busy ? "default" : "pointer", fontWeight: 500 },
              children: busy ? "做梦进行中…" : "立即做梦",
            }),
            S.jsx("button", {
              type: "button",
              onClick: () => setTick((t) => t + 1),
              style: { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", cursor: "pointer" },
              children: "刷新",
            }),
          ]}),
          error ? S.jsx("p", { style: { color: "var(--dsw-alias-state-error-primary)", marginBottom: 12 }, children: `加载失败：${error}` }) : null,

          // 子 Tab
          S.jsxs("div", { style: { display: "flex", gap: 8, marginBottom: 16 }, children: [
            S.jsx("button", { type: "button", onClick: () => setTab("dreams"), style: tabBtn(tab === "dreams"), children: "梦境日记" }),
            S.jsx("button", { type: "button", onClick: () => setTab("promotions"), style: tabBtn(tab === "promotions"), children: `晋升沉淀${promotions && promotions.length ? ` (${promotions.length})` : ""}` }),
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
          ]}) : S.jsxs("div", { children: [
            !promotions ? S.jsx("p", { style: empty, children: "加载中…" }) :
              promotions.length === 0 ? S.jsx("p", { style: empty, children: "暂无晋升记录。" }) :
                promotions.map((p) => S.jsxs("div", { key: p.id, style: card, children: [
                  S.jsx("div", { style: meta, children: `${p.dream_date || "—"} · ${p.target}` }),
                  S.jsx("div", { style: body, children: p.content }),
                ] })),
          ]}),
        ],
      });
    }

    const inject = ["slots", "connection", "remote"];

    // ── remote 贡献：声明 host remote service（梦境设置读写） ────────────────
    const identity = (value) => value;
    const codec = (symbol) => ({ mode: "strict", typeSymbol: symbol, schema: { parse: identity } });
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

    /** Settings → 梦境：默认工作区 + 随机窗口。 */
    function DreamSettings(props) {
      const { getConfig, setConfig, listProviders, listModels } = props;
      const [state, setState] = React.useState({ status: "loading", writable: true });
      const [workspace, setWorkspace] = React.useState("");
      const [provider, setProvider] = React.useState("");
      const [windowStart, setWindowStart] = React.useState("02:00");
      const [windowEnd, setWindowEnd] = React.useState("04:30");
      const [model, setModel] = React.useState("");
      const [stepTimeoutSec, setStepTimeoutSec] = React.useState(0);
      const [providers, setProviders] = React.useState([]);
      const [models, setModels] = React.useState([]);
      const [saved, setSaved] = React.useState(false);
      const [loadTick, setLoadTick] = React.useState(0);

      React.useEffect(() => {
        let current = true;
        Promise.resolve().then(() => getConfig()).then((cfg) => {
          if (!current) return;
          setWorkspace(typeof cfg?.workspace === "string" ? cfg.workspace : "");
          setWindowStart(typeof cfg?.windowStart === "string" ? cfg.windowStart : "02:00");
          setWindowEnd(typeof cfg?.windowEnd === "string" ? cfg.windowEnd : "04:30");
          setProvider(typeof cfg?.provider === "string" ? cfg.provider : "");
          setModel(typeof cfg?.model === "string" ? cfg.model : "");
          if (typeof cfg?.stepTimeoutSec === "number") setStepTimeoutSec(cfg.stepTimeoutSec);
          setState({ status: "ready", writable: cfg?.writable !== false });
        }, () => { if (current) setState({ status: "error", writable: true }); });
        return () => { current = false; };
      }, [getConfig, loadTick]);

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

      const save = () => {
        Promise.resolve().then(() => setConfig({ workspace, provider, model, windowStart, windowEnd, stepTimeoutSec }))
          .then(() => { setSaved(true); setTimeout(() => setSaved(false), 1500); })
          .catch((e) => console.error("dsh-dreaming save failed", e));
      };

      if (state.status === "loading") return S.jsx("p", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: "正在读取梦境配置…" });
      if (state.status === "error") return S.jsxs("div", { children: [
        S.jsx("p", { style: { color: "var(--dsw-alias-state-error-primary)" }, children: "暂时无法读取配置。" }),
        S.jsx("button", { onClick: () => setLoadTick((t) => t + 1), style: { marginTop: 8, padding: "4px 10px" }, children: "重试" }),
      ] });

      const writable = state.writable;
      return S.jsxs("div", { style: { maxWidth: 640, fontFamily: "inherit", fontSize: 14, lineHeight: 1.6 }, children: [
        S.jsx("p", { style: { color: "var(--dsw-alias-label-secondary)", margin: "0 0 12px" }, children: "梦境在每天凌晨随机窗口内运行一次。设置梦境会话的工作区与随机窗口（本地时间 HH:mm）。" }),
        S.jsx("div", { style: row, children: [
          S.jsx("label", { style: labelStyle, children: "默认工作区" }),
          S.jsx("input", { value: workspace, disabled: !writable, onChange: (e) => setWorkspace(e.target.value), style: inputStyle, placeholder: "/Users/<you>/dsh/mayacode" }),
        ] }),
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
          S.jsx("label", { style: labelStyle, children: "单步超时" }),
          S.jsx("input", { type: "number", min: 0, step: 1, value: stepTimeoutSec, disabled: !writable, onChange: (e) => setStepTimeoutSec(Number(e.target.value) || 0), style: { ...inputStyle, maxWidth: 160 }, placeholder: "0 = 不限制" }),
          S.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 }, children: "秒，单步（一次模型请求）超过该时长强制中断，0 = 不限制" }),
        ] }),
        S.jsxs("div", { style: { marginTop: 14, display: "flex", gap: 8 }, children: [
          S.jsx("button", { type: "button", disabled: !writable, onClick: save, style: { padding: "6px 14px", borderRadius: 8, cursor: writable ? "pointer" : "default", fontWeight: 500 }, children: saved ? "✓ 已保存" : "保存" }),
          S.jsx("button", { type: "button", disabled: !writable, onClick: () => setLoadTick((t) => t + 1), style: { padding: "6px 14px", borderRadius: 8, cursor: writable ? "pointer" : "default" }, children: "放弃修改" }),
        ] }),
      ] });
    }

    function apply(ctx) {
      // 设置页卡片（Settings → 梦境）。
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
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "dreaming",
            order: 26,
            label: () => "梦境",
            inject: () => ({ getConfig, setConfig, listProviders, listModels }),
          },
          DreamSettings,
        ),
      );

      // 梦境 Tab（conversation.view）。
      const runtimes = new Map();
      ctx.effect(() => () => { runtimes.clear(); }, "dsh-dreaming: runtimes");
      ctx.slots.inject("conversation.view", () =>
        ctx.slots.register(
          {
            name: "conversation.view",
            id: "dreaming",
            order: 50,
            label: () => "梦境",
            inject: (sessionId) => {
              let runtime = runtimes.get(sessionId);
              if (runtime === void 0) {
                runtime = createDreamingRuntime(ctx.connection.rpc, sessionId);
                runtimes.set(sessionId, runtime);
              }
              return { runtime };
            },
          },
          DreamView,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
