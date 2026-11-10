/** Persistent data location, with migration from earlier project names. */
import { access, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_ID = "online_helper";
export const API_BASE = `/${APP_ID}`;
export const DEFAULT_URL = "https://buaa.yuketang.cn/";

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

export function resolveDataDir(home = dshHome()) {
  return join(home, APP_ID);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** Prefer the most recent legacy directory; never overwrite existing online_helper data. */
export async function migrateLegacyDataDir(home = dshHome()) {
  const current = resolveDataDir(home);
  if (await exists(current)) return null;
  for (const name of ["dsh-autoplay", "course-watch"]) {
    const legacy = join(home, name);
    if (!(await exists(legacy))) continue;
    await rename(legacy, current);
    return { from: legacy, to: current };
  }
  return null;
}
