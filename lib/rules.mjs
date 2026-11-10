/** Site rule validation, built-in loading and user rule storage. */
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUILTIN_RULES_DIR = fileURLToPath(new URL("../rules/", import.meta.url));
const ADVANCE_KEYS = new Set(["selector", "js", "nextUnit", "navItem"]);

export function isRuleId(id) {
  return typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== "..";
}

/** 一条规则是否合法；返回错误说明数组，空数组表示通过。 */
export function validateRule(rule) {
  if (rule === null || typeof rule !== "object" || Array.isArray(rule)) return ["规则必须是一个 JSON 对象"];
  const errors = [];
  if (!isRuleId(rule.id)) {
    errors.push("id 必填，只能用字母、数字、点、下划线、连字符");
  }
  const patterns = Array.isArray(rule.match) ? rule.match : typeof rule.match === "string" ? [rule.match] : [];
  if (patterns.length === 0 || patterns.some((value) => typeof value !== "string" || value.length === 0)) {
    errors.push("match 必填：一个字符串，或非空字符串数组");
  }
  const advance = rule.advance;
  if (advance === null || typeof advance !== "object" || Array.isArray(advance)) {
    errors.push("advance 必填，且必须是对象");
    return errors;
  }
  for (const key of Object.keys(advance)) {
    if (!ADVANCE_KEYS.has(key)) errors.push(`advance 里不认识的键：${key}（可用：selector / js / nextUnit / navItem）`);
  }
  for (const key of ["selector", "js", "nextUnit"]) {
    if (advance[key] !== undefined && advance[key] !== null && typeof advance[key] !== "string") {
      errors.push(`advance.${key} 必须是字符串或 null`);
    }
  }
  if (typeof advance.selector === "string" && advance.selector.length === 0) errors.push("advance.selector 不能是空字符串（不用就写 null）");
  if (typeof advance.nextUnit === "string" && advance.nextUnit.length === 0) errors.push("advance.nextUnit 不能是空字符串（不用就写 null）");
  if (typeof advance.js === "string") {
    try {
      new Function(advance.js);
    } catch (error) {
      errors.push(`advance.js 不是合法表达式：${String(error?.message ?? error)}`);
    }
  }
  const navItem = advance.navItem;
  if (navItem !== null && navItem !== undefined) {
    if (typeof navItem !== "object" || Array.isArray(navItem)) {
      errors.push("advance.navItem 必须是对象或 null");
    } else {
      if (typeof navItem.item !== "string" || navItem.item.length === 0) {
        errors.push("advance.navItem.item 必填：课程条目的选择器");
      }
      if (navItem.idPattern !== undefined && navItem.idPattern !== null) {
        try {
          new RegExp(navItem.idPattern);
        } catch {
          errors.push("advance.navItem.idPattern 不是合法正则");
        }
      }
      if (navItem.hrefFromId === true && typeof navItem.idPattern !== "string") {
        errors.push("advance.navItem.hrefFromId 需要同时给出 idPattern");
      }
    }
  }
  return errors;
}

/** Fail early if a bundled rule is broken, rather than silently diverging from the engine. */
export function loadBuiltinRules(dir = BUILTIN_RULES_DIR) {
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => {
    const rule = JSON.parse(readFileSync(join(dir, name), "utf8"));
    const errors = validateRule(rule);
    if (errors.length > 0) throw new Error(`${name}: ${errors.join("；")}`);
    return rule;
  });
}

async function readRuleDir(dir, source) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const fileName of names.sort()) {
    if (!fileName.endsWith(".json")) continue;
    try {
      const rule = JSON.parse(await readFile(join(dir, fileName), "utf8"));
      entries.push({ fileName, source, rule, errors: validateRule(rule) });
    } catch (error) {
      entries.push({ fileName, source, rule: null, errors: [`无法读取规则 JSON：${String(error?.message ?? error)}`] });
    }
  }
  return entries;
}

export class RuleStore {
  constructor(userDir, builtinDir = BUILTIN_RULES_DIR) {
    this.userDir = userDir;
    this.builtinDir = builtinDir;
    this.entries = [];
  }

  async reload() {
    const builtin = await readRuleDir(this.builtinDir, "builtin");
    const user = await readRuleDir(this.userDir, "user");
    const byId = new Map();
    for (const entry of builtin) byId.set(entry.rule?.id ?? entry.fileName, entry);
    for (const entry of user) byId.set(entry.rule?.id ?? entry.fileName, entry);
    this.entries = [...byId.values()];
    return this.entries;
  }

  active() {
    return this.entries.filter((entry) => entry.errors.length === 0).map((entry) => entry.rule);
  }

  summary() {
    return this.entries.map((entry) => ({
      id: entry.rule?.id ?? entry.fileName,
      name: entry.rule?.name ?? entry.fileName,
      match: entry.rule?.match ?? null,
      note: entry.rule?.note ?? null,
      source: entry.source,
      fileName: entry.fileName,
      usable: entry.errors.length === 0,
      errors: entry.errors,
    }));
  }

  async save(raw) {
    let rule = raw;
    if (typeof raw === "string") {
      try {
        rule = JSON.parse(raw);
      } catch (error) {
        return { ok: false, errors: [`不是合法 JSON：${String(error?.message ?? error)}`] };
      }
    }
    const errors = validateRule(rule);
    if (errors.length > 0) return { ok: false, errors };
    await mkdir(this.userDir, { recursive: true });
    await writeFile(join(this.userDir, `${rule.id}.json`), JSON.stringify(rule, null, 2), "utf8");
    await this.reload();
    return { ok: true, id: rule.id, count: this.entries.length };
  }

  async delete(id) {
    if (!isRuleId(id)) return { ok: false, error: "无效的规则 id" };
    try {
      await unlink(join(this.userDir, `${id}.json`));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { ok: false, error: "没有这条用户规则。内置规则不能删除；想改它就用同一个 id 导入一条覆盖。" };
    }
    await this.reload();
    return { ok: true, id };
  }
}
