import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { loadBuiltinRules, RuleStore, validateRule } from '../lib/rules.mjs';

const custom = { id: 'example', match: ['learn.example.com'], advance: { selector: '.next' } };

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'online-helper-rules-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('host and monitor share the JSON built-in rules', async (t) => {
  const store = new RuleStore(join(await workspace(t), 'rules'));
  await store.reload();
  assert.deepEqual(store.active(), loadBuiltinRules());
  assert.deepEqual((await loadConfig()).sites, store.active());
});

test('saving JSON persists a rule that a new store can reload', async (t) => {
  const dir = join(await workspace(t), 'rules');
  const store = new RuleStore(dir);
  assert.deepEqual(await store.save(JSON.stringify(custom)), { ok: true, id: custom.id, count: 3 });
  const reloaded = new RuleStore(dir);
  await reloaded.reload();
  assert.deepEqual(reloaded.active().find((rule) => rule.id === custom.id), custom);
  assert.equal(reloaded.summary().find((rule) => rule.id === custom.id).source, 'user');
});

test('user override takes precedence and deleting it restores the built-in', async (t) => {
  const store = new RuleStore(join(await workspace(t), 'rules'));
  const builtin = loadBuiltinRules()[0];
  const override = { ...builtin, advance: { selector: '.custom-next' } };
  await store.save(override);
  assert.deepEqual(store.active().find((rule) => rule.id === builtin.id), override);
  assert.equal(store.active().length, 2);
  assert.equal((await store.delete(builtin.id)).ok, true);
  assert.deepEqual(store.active().find((rule) => rule.id === builtin.id), builtin);
  assert.equal((await store.delete(builtin.id)).ok, false);
});

test('corrupt user JSON is reported without losing working rules', async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, 'broken.json'), '{broken');
  const store = new RuleStore(dir);
  await store.reload();
  assert.equal(store.active().length, 2);
  const broken = store.summary().find((rule) => rule.id === 'broken.json');
  assert.equal(broken.usable, false);
  assert.ok(broken.errors.length > 0);
});

test('invalid rule imports do not write a file', async (t) => {
  const dir = join(await workspace(t), 'rules');
  const store = new RuleStore(dir);
  for (const raw of ['{bad', null, [], { ...custom, advance: { selector: 42 } }]) {
    assert.equal((await store.save(raw)).ok, false);
  }
  await assert.rejects(readFile(join(dir, 'example.json')), { code: 'ENOENT' });
});

test('rule IDs cannot delete or write outside the rules directory', async (t) => {
  const dir = await workspace(t);
  const outside = join(dir, 'keep.json');
  await writeFile(outside, 'keep');
  const store = new RuleStore(join(dir, 'rules'));
  await store.save(custom);
  for (const id of ['../keep', '..\\keep', '/tmp/keep', '.', '..', '', null]) {
    assert.equal((await store.delete(id)).ok, false);
    assert.equal((await store.save({ ...custom, id })).ok, false);
  }
  assert.equal(await readFile(outside, 'utf8'), 'keep');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'rules', 'example.json'), 'utf8')), custom);
});

test('malformed navigation rules are rejected before the browser sees them', () => {
  for (const advance of [
    { selector: 1 }, { js: {} }, { nextUnit: false }, { selector: '' },
    { js: 'const =' }, { unknown: '.next' }, { navItem: [] },
    { navItem: { item: '.lesson', idPattern: '[' } },
    { navItem: { item: '.lesson', hrefFromId: true } },
  ]) assert.ok(validateRule({ ...custom, advance }).length > 0);
});
