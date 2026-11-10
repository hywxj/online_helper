/** Browser-independent monitor configuration and site matching. */
import { DEFAULT_PORT } from "./cdp.mjs";
import { loadBuiltinRules } from "./rules.mjs";

const DEFAULT_SITES = loadBuiltinRules();

const DEFAULTS = {
  port: DEFAULT_PORT,
  startUrl: null,
  open: false,
  pollMs: 5000,
  logEveryMs: 30000,
  endThresholdSec: 2,
  minDurationSec: 10,
  resumeIfPaused: true,
  resumeAfterTicks: 2,
  // 点完翻页控件后，最多等多久让新视频出现；等不到就算这个策略失败，换下一个
  afterAdvanceWaitMs: 25000,
  advanceAttempts: 3,
  maxLessons: 60,
  // 还没开始播之前，等用户把课程页打开的耐心
  noVideoTimeoutMs: 900000,
  // 已经在播了却突然找不到视频：等这么久就尝试自救
  lostVideoTimeoutMs: 120000,
  maxRecoveries: 2,
  // 连不上调试端口（浏览器被关了）时等多久。用户可能只是手滑关窗，等他把窗口开回来。
  browserDownTimeoutMs: 1800000,
  stopWhenBlocked: true,
  // 通用兜底：任何站点都能用文案匹配和链接列表
  advance: { selector: null, js: null, nextUnit: null, navItem: null },
  sites: DEFAULT_SITES,
};

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** 取出一条规则声明的匹配模式；`match` 允许是字符串或数组。 */
function matchPatterns(rule) {
  const raw = rule?.match;
  if (typeof raw === "string") return raw.length > 0 ? [raw] : [];
  if (Array.isArray(raw)) return raw.filter((value) => typeof value === "string" && value.length > 0);
  return [];
}

/**
 * 判断一条站点规则是否匹配某个域名。
 * 不带 `*` 的模式按「包含」匹配（和旧写法兼容）；带 `*` 的按通配符整串匹配。
 */
export function matchesHost(rule, host) {
  if (host === null || host === undefined) return false;
  return matchPatterns(rule).some((pattern) => {
    if (!pattern.includes("*")) return host.includes(pattern);
    const source = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp("^" + source + "$", "i").test(host);
  });
}

/**
 * 合并站点规则：内置打底，外部（规则仓库文件）按 `id` 覆盖或追加。
 * 想改内置平台的规则时，用同一个 `id` 导入即可覆盖，不必改代码。
 */
export function mergeSites(fromConfig) {
  const byId = new Map();
  for (const rule of DEFAULT_SITES) byId.set(rule.id, rule);
  for (const rule of fromConfig ?? []) {
    if (rule === null || typeof rule !== "object") continue;
    const id = typeof rule.id === "string" && rule.id.length > 0 ? rule.id : JSON.stringify(rule.match ?? null);
    byId.set(id, { ...(byId.get(id) ?? {}), ...rule });
  }
  return [...byId.values()];
}

/** 按当前视频地址挑出该站点的翻页设置，缺项回落到通用设置。 */
export function advanceFor(config, url) {
  const host = hostOf(url) ?? hostOf(config?.startUrl);
  const site = (config?.sites ?? []).find((rule) => matchesHost(rule, host));
  const siteAdvance = site?.advance ?? {};
  // config.advance 缺失时不能让整条链路崩掉：用空对象兜底。
  const generic = config?.advance ?? {};
  const pick = (key) => (siteAdvance[key] !== undefined ? siteAdvance[key] : generic[key]);
  return {
    selector: pick("selector") ?? null,
    js: pick("js") ?? null,
    nextUnit: pick("nextUnit") ?? null,
    navItem: pick("navItem") ?? null,
    matchedSite: site?.id ?? null,
  };
}

export async function loadConfig(overrides = {}) {
  return {
    ...DEFAULTS,
    ...overrides,
    advance: { ...DEFAULTS.advance, ...(overrides.advance ?? {}) },
    sites: mergeSites(overrides.sites),
  };
}
