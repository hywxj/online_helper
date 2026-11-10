/**
 * 网课助手 · 宿主半边。
 *
 * 职责：启动带调试端口的 Chrome，驱动播放监控与自动翻页引擎，并管理站点规则仓库。
 * 界面半边（client.js）通过 `/online_helper` 这条 HTTP 路由与本文件通信——
 * 手写插件无法自建 Typert Remote（那需要编译器产物），而 webServer 路由是
 * 公开的 Service 方法，足够承担这条本地控制通道。
 *
 * 路由用「处理器型」（handler）而不是「资源型」（resource）：资源型只接受
 * GET/HEAD，其它方法在匹配之前就被框架回 405，而控制通道需要 POST。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, PROBE_EXPR, TargetSession, listTargets } from "./lib/cdp.mjs";
import { findBrowser, launchChrome, profileDir } from "./lib/chrome.mjs";
import { readState, runWatch, setDataDir, setLogSink } from "./lib/watch.mjs";
import { APP_ID, API_BASE, DEFAULT_URL, migrateLegacyDataDir, resolveDataDir } from "./lib/paths.mjs";
import { RuleStore } from "./lib/rules.mjs";

export const name = APP_ID;
/** webServer 是硬依赖：没有它就没有控制通道。 */
export const inject = ["webServer"];

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_LIMIT = 150;

export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir();
  const userRulesDir = join(dataDir, "rules");
  const settingsPath = join(dataDir, "settings.json");
  const rules = new RuleStore(userRulesDir);
  setDataDir(dataDir);

  const runtime = {
    running: false,
    starting: false,
    url: null,
    port: config.port ?? DEFAULT_PORT,
    startedAt: null,
    exitCode: null,
    error: null,
    browser: null,
    latest: null,
    log: [],
    lessonsAdvanced: 0,
  };
  let controller = null;
  let settings = { url: DEFAULT_URL, port: runtime.port };

  setLogSink((record) => {
    runtime.latest = record;
    runtime.log.push(record);
    if (runtime.log.length > LOG_LIMIT) runtime.log.splice(0, runtime.log.length - LOG_LIMIT);
    if (record.event === "advanced") runtime.lessonsAdvanced = record.lessonNumber ?? runtime.lessonsAdvanced;
  });

  /**
   * 用上一次运行留下的日志开头。
   * 内存里的事件流是空的（刚启动），不播种的话「最近动态」会是一片空白，
   * 看起来像功能坏了。
   */
  async function seedLogFromFile() {
    try {
      const text = await readFile(join(dataDir, "watch.log"), "utf8");
      const records = [];
      for (const line of text.split("\n").slice(-60)) {
        if (line.trim().length === 0) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          /* 跳过坏行 */
        }
      }
      if (records.length === 0) return;
      runtime.log = records.slice(-LOG_LIMIT);
      runtime.latest = runtime.log.at(-1) ?? null;
      const lastAdvanced = [...runtime.log].reverse().find((record) => record.event === "advanced");
      runtime.lessonsAdvanced = lastAdvanced?.lessonNumber ?? runtime.lessonsAdvanced;
    } catch {
      /* 首次运行没有日志文件 */
    }
  }

  const sendJson = (res, value, status = 200) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };

  /* ------------------------------------------------------------ 控制通道 */

  async function persistSettings() {
    await mkdir(dataDir, { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  }

  async function loadSettings() {
    try {
      const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
      settings = {
        url: typeof parsed.url === "string" ? parsed.url : DEFAULT_URL,
        port: Number(parsed.port) || DEFAULT_PORT,
      };
    } catch {
      /* 首次运行：用默认值 */
    }
    runtime.url = settings.url;
    runtime.port = settings.port;
  }

  function normalizeUrl(raw) {
    const value = String(raw ?? "").trim();
    if (value.length === 0) throw new Error("请填写课程网页地址。");
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("地址格式不对，需要以 http:// 或 https:// 开头。");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("只支持 http / https 地址。");
    return parsed.href;
  }

  async function start(rawUrl) {
    if (runtime.running || runtime.starting) return { ok: false, error: "已经在监控中，请先停止。" };
    let url;
    try {
      url = normalizeUrl(rawUrl ?? settings.url);
    } catch (error) {
      return { ok: false, error: String(error.message ?? error) };
    }
    if (findBrowser() === null) return { ok: false, error: "没找到 Chrome 或 Edge，无法启动浏览器。" };

    runtime.starting = true;
    runtime.error = null;
    runtime.exitCode = null;
    try {
      const port = settings.port;
      runtime.browser = launchChrome({ url, port });
      settings = { url, port };
      await persistSettings();
      await rules.reload();

      runtime.running = true;
      runtime.url = url;
      runtime.startedAt = new Date().toISOString();
      runtime.lessonsAdvanced = 0;

      controller = new AbortController();
      const signal = controller.signal;
      // open:false —— 地址已经交给 Chrome 命令行打开；再用 CDP 导航会抢在端口就绪之前失败。
      runWatch({ port, startUrl: url, open: false, sites: rules.active() }, { signal })
        .then((code) => {
          runtime.exitCode = code;
        })
        .catch((error) => {
          runtime.error = String(error?.message ?? error);
        })
        .finally(() => {
          runtime.running = false;
          controller = null;
        });

      return { ok: true, url, port, browser: runtime.browser.executable, profile: runtime.browser.profile, rules: rules.active().length };
    } finally {
      runtime.starting = false;
    }
  }

  async function stop(reason = "用户在界面上点了停止") {
    if (controller === null) return { ok: true, note: "当前没有在监控。" };
    controller.abort(reason);
    return { ok: true };
  }

  /** 探测当前打开的课程页：给写规则的人看真实 DOM 长什么样。 */
  async function probePage() {
    let targets;
    try {
      targets = await listTargets(runtime.port);
    } catch (error) {
      return { ok: false, error: `连不上调试端口 ${runtime.port}。请先启动，并让那个 Chrome 打开课程页。（${String(error?.message ?? error)}）` };
    }
    const frames = [];
    for (const target of targets) {
      if (target.type !== "page" && target.type !== "iframe") continue;
      let session = null;
      try {
        session = await TargetSession.open(target, { settleMs: 250 });
        for (const result of await session.evaluateEverywhere(PROBE_EXPR, { awaitPromise: false })) {
          if (result.value !== null && result.value !== undefined) {
            frames.push({ target: String(target.url).slice(0, 140), ...result.value });
          }
        }
      } catch {
        /* 探测不了的目标跳过 */
      } finally {
        session?.close();
      }
    }
    if (frames.length === 0) return { ok: false, error: "所有 frame 都没探到内容，确认课程页已经打开。" };
    return { ok: true, frames };
  }

  async function status() {
    let persisted = null;
    try {
      persisted = await readState();
    } catch {
      /* 状态文件还没生成 */
    }
    return {
      running: runtime.running,
      starting: runtime.starting,
      url: runtime.url,
      port: runtime.port,
      startedAt: runtime.startedAt,
      lessonsAdvanced: runtime.lessonsAdvanced ?? 0,
      exitCode: runtime.exitCode,
      error: runtime.error,
      browser: runtime.browser?.executable ?? null,
      browserFound: findBrowser() !== null,
      profile: profileDir(),
      latest: runtime.latest,
      log: runtime.log.slice(-60),
      persisted,
      rules: rules.summary(),
      rulesDir: userRulesDir,
    };
  }

  const handler = async (req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const readJson = async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length === 0) return {};
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return {};
      }
    };
    try {
      if (req.method === "GET" && path === `${API_BASE}/status`) return sendJson(res, await status());
      if (req.method === "GET" && path === `${API_BASE}/spec`) {
        const text = await readFile(join(PACKAGE_DIR, "RULES.md"), "utf8").catch(() => "");
        return sendJson(res, { ok: text.length > 0, text });
      }
      if (req.method === "POST" && path === `${API_BASE}/start`) {
        const body = await readJson();
        return sendJson(res, await start(body?.url));
      }
      if (req.method === "POST" && path === `${API_BASE}/stop`) return sendJson(res, await stop());
      if (req.method === "POST" && path === `${API_BASE}/probe`) return sendJson(res, await probePage());
      if (req.method === "POST" && path === `${API_BASE}/rules`) {
        const body = await readJson();
        return sendJson(res, await rules.save(body?.rule ?? body));
      }
      if (req.method === "POST" && path === `${API_BASE}/rules/delete`) {
        const body = await readJson();
        return sendJson(res, await rules.delete(body?.id));
      }
      return sendJson(res, { ok: false, error: `unknown route ${req.method} ${path}` }, 404);
    } catch (error) {
      return sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
    }
  };

  ctx.effect(() => {
    let disposeRoute = null;
    const ready = (async () => {
      const migrated = await migrateLegacyDataDir();
      if (migrated !== null) {
        ctx.logger?.info?.(`online_helper: 数据目录已迁移 ${migrated.from} -> ${migrated.to}`);
      }
      await mkdir(userRulesDir, { recursive: true });
      await loadSettings();
      await seedLogFromFile();
      await rules.reload();
      disposeRoute = ctx.webServer.register({ kind: "prefix", path: API_BASE, handler });
      ctx.logger?.info?.(`${APP_ID}: 已注册 ${API_BASE} 控制通道`);
    })();
    return async () => {
      controller?.abort("插件正在卸载");
      await ready.catch(() => {});
      disposeRoute?.();
      setLogSink(null);
    };
  }, "online_helper routes");
}
