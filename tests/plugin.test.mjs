import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import test from 'node:test';
import { apply, name } from '../index.js';
import { API_BASE, APP_ID } from '../lib/paths.mjs';

test('bundle, host and sidebar register matching identifiers', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  let client;
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(module) { client = module; } } },
  });
  assert.equal(packageJson.name, '@local/online_helper');
  assert.equal(client.id, packageJson.name);
  assert.equal(name, APP_ID);
  assert.ok(patch.includes(`id: ${APP_ID}`));
  assert.ok(patch.includes(`name: '${packageJson.name}'`));

  const registrations = [];
  const plugin = client.factory((id) => {
    assert.equal(id, 'react');
    return { createElement() {} };
  });
  plugin.apply({ slots: {
    inject(slot, callback) { callback(); },
    register(options) { registrations.push(options); },
  } });
  assert.equal(registrations.find((entry) => entry.name === 'sidebar.panellist').id, APP_ID);
  assert.equal(registrations.find((entry) => entry.name === 'main').key, APP_ID);
});

test('host routes expose status, manage rules and dispose correctly after migration', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'online-helper-host-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let dispose;
  let route;
  let routeDisposed = false;
  t.after(async () => {
    try {
      await dispose?.();
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });
  const legacy = join(home, 'dsh-autoplay');
  await mkdir(legacy);
  await writeFile(join(legacy, 'settings.json'), JSON.stringify({ url: 'https://learn.example.com/video/1', port: 9333 }));
  const { promise: ready, resolve: registered } = Promise.withResolvers();
  apply({
    effect(callback) { dispose = callback(); },
    webServer: { register(options) {
      route = options;
      registered();
      return () => { routeDisposed = true; };
    } },
  });
  await ready;
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, API_BASE);

  async function request(method, endpoint, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = API_BASE + endpoint;
    const response = {};
    await route.handler(req, {
      writeHead(status, headers) { response.status = status; response.headers = headers; },
      end(text) { response.body = JSON.parse(text); },
    });
    return response;
  }

  const initial = await request('GET', '/status');
  assert.equal(initial.status, 200);
  assert.equal(initial.headers['cache-control'], 'no-store');
  assert.equal(initial.body.port, 9333);
  assert.equal(initial.body.url, 'https://learn.example.com/video/1');
  assert.equal(initial.body.rules.length, 2);
  assert.equal(initial.body.rulesDir, join(home, APP_ID, 'rules'));

  const spec = await request('GET', '/spec');
  assert.equal(spec.body.ok, true);
  assert.ok(spec.body.text.includes('online_helper'));

  const rule = { id: 'example', match: ['learn.example.com'], advance: { selector: '.next' } };
  assert.equal((await request('POST', '/rules', { rule })).body.ok, true);
  assert.equal((await request('GET', '/status')).body.rules.length, 3);
  assert.equal((await request('POST', '/rules/delete', { id: '../settings' })).body.ok, false);
  assert.equal(JSON.parse(await readFile(join(home, APP_ID, 'settings.json'), 'utf8')).port, 9333);
  assert.equal((await request('POST', '/rules/delete', { id: 'example' })).body.ok, true);
  assert.equal((await request('GET', '/status')).body.rules.length, 2);

  for (const url of ['', 'not a url', 'file:///tmp/course']) {
    assert.equal((await request('POST', '/start', { url })).body.ok, false);
  }
  assert.equal((await request('POST', '/stop')).body.ok, true);
  assert.equal((await request('GET', '/unknown')).status, 404);
  await dispose();
  dispose = null;
  assert.equal(routeDisposed, true);
});
