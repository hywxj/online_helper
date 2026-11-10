import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { migrateLegacyDataDir, resolveDataDir } from '../lib/paths.mjs';

const run = promisify(execFile);

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'online helper paths '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function seed(dir, text) {
  await mkdir(join(dir, 'rules'), { recursive: true });
  await writeFile(join(dir, 'settings.json'), text);
  await writeFile(join(dir, 'rules', 'custom.json'), text);
}

test('fresh installations resolve to online_helper without creating legacy data', async (t) => {
  const home = await workspace(t);
  assert.equal(resolveDataDir(home), join(home, 'online_helper'));
  assert.equal(await migrateLegacyDataDir(home), null);
});

for (const name of ['dsh-autoplay', 'course-watch']) {
  test(`migrates settings and user rules from ${name}`, async (t) => {
    const home = await workspace(t);
    const from = join(home, name);
    const to = resolveDataDir(home);
    await seed(from, name);
    assert.deepEqual(await migrateLegacyDataDir(home), { from, to });
    assert.equal(await readFile(join(to, 'settings.json'), 'utf8'), name);
    assert.equal(await readFile(join(to, 'rules', 'custom.json'), 'utf8'), name);
    await assert.rejects(readFile(join(from, 'settings.json')), { code: 'ENOENT' });
    assert.equal(await migrateLegacyDataDir(home), null);
  });
}

test('existing new data is never replaced by legacy data', async (t) => {
  const home = await workspace(t);
  await seed(resolveDataDir(home), 'current');
  await seed(join(home, 'dsh-autoplay'), 'legacy');
  assert.equal(await migrateLegacyDataDir(home), null);
  assert.equal(await readFile(join(resolveDataDir(home), 'settings.json'), 'utf8'), 'current');
  assert.equal(await readFile(join(home, 'dsh-autoplay', 'settings.json'), 'utf8'), 'legacy');
});

test('the latest legacy project takes precedence when both directories exist', async (t) => {
  const home = await workspace(t);
  await seed(join(home, 'dsh-autoplay'), 'recent');
  await seed(join(home, 'course-watch'), 'old');
  await migrateLegacyDataDir(home);
  assert.equal(await readFile(join(resolveDataDir(home), 'settings.json'), 'utf8'), 'recent');
  assert.equal(await readFile(join(home, 'course-watch', 'settings.json'), 'utf8'), 'old');
});

test('watch CLI uses DSH_HOME and reads state in paths containing spaces', async (t) => {
  const home = await workspace(t);
  await mkdir(resolveDataDir(home));
  const state = { running: false, lessonsAdvanced: 7 };
  await writeFile(join(resolveDataDir(home), 'watch-state.json'), JSON.stringify(state));
  const modulePath = fileURLToPath(new URL('../lib/watch.mjs', import.meta.url));
  const { stdout, stderr } = await run(process.execPath, [modulePath, 'state'], {
    env: { ...process.env, DSH_HOME: home },
  });
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout).state, state);
});
