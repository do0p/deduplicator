// Tree selection invariant tests using jsdom + node:test (no browser needed).
//
// Core invariant: for every checkbox with [data-path] in the folder tree,
//   cb.checked && !cb.indeterminate  ↔  path is in selectedDirs
// This must hold after every user interaction.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const JS   = fs.readFileSync(path.join(__dirname, '../web/app.js'),     'utf8');

// ---------------------------------------------------------------------------
// Mock API data
// ---------------------------------------------------------------------------

const BROWSE = {
  '':                 [dir('/mnt/Photos'), dir('/mnt/Videos')],
  '/mnt/Photos':      [dir('/mnt/Photos/2023'), dir('/mnt/Photos/2024')],
  '/mnt/Videos':      [],
  '/mnt/Photos/2023': [],
  '/mnt/Photos/2024': [],
};

function dir(p) { return { name: p.split('/').pop(), path: p, isDir: true }; }

function makeFetch() {
  return async (url) => {
    const u = new URL(url, 'http://localhost');
    const p = u.pathname;
    let data;
    if (p === '/api/version') data = { version: 'test' };
    else if (p === '/api/config') data = { recycleBinEnabled: false };
    else if (p === '/api/status') data = { phase: '' };
    else if (p === '/api/browse') data = BROWSE[u.searchParams.get('path') ?? ''] ?? [];
    else data = {};
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  };
}

// ---------------------------------------------------------------------------
// App factory — creates a fresh JSDOM instance with app.js loaded
// ---------------------------------------------------------------------------

async function createApp() {
  // Strip the <script src> tag so jsdom doesn't try to fetch the file
  const html = HTML.replace('<script src="/app.js"></script>', '');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:3099',
  });

  const win = dom.window;

  // jsdom spec-compliant checkbox activation pre-activates (toggles checked) BEFORE
  // firing the click event, then restores on preventDefault — opposite of Chrome.
  // Patch the impl prototype to disable this so click handlers see the pre-click state.
  {
    const tmp = win.document.createElement('input');
    tmp.type = 'checkbox';
    const implSym = Object.getOwnPropertySymbols(tmp).find(s => s.toString() === 'Symbol(impl)');
    const implProto = Object.getPrototypeOf(tmp[implSym]);
    implProto._legacyPreActivationBehavior = function() {};
    implProto._legacyCanceledActivationBehavior = function() {};
  }

  win.fetch = makeFetch();
  // Stub WebSocket so the status-check in the init IIFE doesn't fail
  win.WebSocket = class { constructor() {} close() {} };

  // Strip 'use strict' so that top-level var declarations (e.g. selectedDirs)
  // become window properties — strict-mode eval scopes vars to the eval block.
  const js = JS.replace(/^'use strict';\n/, '');
  win.eval(js);

  // Drain the microtask / macrotask queues so the init IIFE completes
  // (loadTree fetches + renders folders)
  await new Promise(r => setTimeout(r, 50));

  return win;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// THE invariant: checked & !indeterminate checkboxes must exactly equal selectedDirs
function assertConsistent(win) {
  const cbs = [...win.document.querySelectorAll('#folder-tree input[type=checkbox][data-path]')];
  const fromUI  = cbs.filter(cb => cb.checked && !cb.indeterminate).map(cb => cb.dataset.path).sort();
  const fromSet = [...win.selectedDirs].sort();
  assert.deepEqual(fromUI, fromSet,
    `Invariant broken:\n  UI:  ${JSON.stringify(fromUI)}\n  Set: ${JSON.stringify(fromSet)}`);
}

function cbFor(win, path) {
  return win.document.querySelector(`#folder-tree input[type=checkbox][data-path="${path}"]`);
}

function click(cb) {
  cb.click();
}

// Expand a folder by clicking its expander arrow, wait for children to load
async function expand(win, folderPath) {
  const item = [...win.document.querySelectorAll('#folder-tree .tree-item')]
    .find(el => el.querySelector(`input[data-path="${folderPath}"]`));
  const expander = item && item.querySelector('.expander');
  if (expander) expander.click();
  await new Promise(r => setTimeout(r, 30));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('folder tree — selectedDirs matches visual state', () => {

  test('initial state: nothing selected', async () => {
    const win = await createApp();
    assertConsistent(win);
    assert.equal(win.selectedDirs.size, 0);
  });

  test('check root selects root + all visible top-level folders', async () => {
    const win = await createApp();
    click(cbFor(win, '/mnt'));
    assertConsistent(win);
    assert.ok(win.selectedDirs.has('/mnt'));
    assert.ok(win.selectedDirs.has('/mnt/Photos'));
    assert.ok(win.selectedDirs.has('/mnt/Videos'));
  });

  test('uncheck one child: parent indeterminate, sibling stays checked', async () => {
    const win = await createApp();
    click(cbFor(win, '/mnt'));           // select all
    click(cbFor(win, '/mnt/Videos'));    // deselect Videos

    assert.equal(cbFor(win, '/mnt/Photos').checked,       true);
    assert.equal(cbFor(win, '/mnt/Videos').checked,       false);
    assert.equal(cbFor(win, '/mnt').indeterminate,        true);
    assertConsistent(win);
    assert.deepEqual([...win.selectedDirs].sort(), ['/mnt/Photos']);
  });

  test('clicking indeterminate root clears everything', async () => {
    const win = await createApp();
    click(cbFor(win, '/mnt'));
    click(cbFor(win, '/mnt/Videos'));    // root → indeterminate
    click(cbFor(win, '/mnt'));           // click indeterminate root

    assert.equal(cbFor(win, '/mnt/Photos').checked,  false);
    assert.equal(cbFor(win, '/mnt/Videos').checked,  false);
    assert.equal(cbFor(win, '/mnt').indeterminate,   false);
    assertConsistent(win);
    assert.equal(win.selectedDirs.size, 0);
  });

  test('clicking checked root clears everything', async () => {
    const win = await createApp();
    click(cbFor(win, '/mnt'));   // select all
    click(cbFor(win, '/mnt'));   // deselect all
    assertConsistent(win);
    assert.equal(win.selectedDirs.size, 0);
  });

  test('deselect all children then reselect parent', async () => {
    const win = await createApp();
    click(cbFor(win, '/mnt'));
    click(cbFor(win, '/mnt/Videos'));    // indeterminate root
    click(cbFor(win, '/mnt/Photos'));    // → nothing selected
    click(cbFor(win, '/mnt'));           // select all again

    assert.equal(cbFor(win, '/mnt/Photos').checked, true);
    assert.equal(cbFor(win, '/mnt/Videos').checked, true);
    assertConsistent(win);
  });

  test('nested: subfolders default to checked when parent was checked on expand', async () => {
    const win = await createApp();
    click(cbFor(win, '/mnt/Photos'));
    await expand(win, '/mnt/Photos');

    assert.equal(cbFor(win, '/mnt/Photos/2023').checked, true);
    assert.equal(cbFor(win, '/mnt/Photos/2024').checked, true);
    assertConsistent(win);
  });

  test('nested: uncheck subfolder makes parent indeterminate', async () => {
    const win = await createApp();
    click(cbFor(win, '/mnt/Photos'));
    await expand(win, '/mnt/Photos');
    click(cbFor(win, '/mnt/Photos/2023'));    // deselect 2023

    assert.equal(cbFor(win, '/mnt/Photos/2023').checked,     false);
    assert.equal(cbFor(win, '/mnt/Photos/2024').checked,     true);
    assert.equal(cbFor(win, '/mnt/Photos').indeterminate,    true);
    assertConsistent(win);
    assert.deepEqual([...win.selectedDirs].sort(), ['/mnt/Photos/2024']);
  });

  test('nested: deselect all subfolders makes parent unchecked, not indeterminate', async () => {
    const win = await createApp();
    click(cbFor(win, '/mnt/Photos'));
    await expand(win, '/mnt/Photos');
    click(cbFor(win, '/mnt/Photos/2023'));
    click(cbFor(win, '/mnt/Photos/2024'));

    assert.equal(cbFor(win, '/mnt/Photos').checked,       false);
    assert.equal(cbFor(win, '/mnt/Photos').indeterminate, false);
    assertConsistent(win);
    assert.equal(win.selectedDirs.size, 0);
  });

  test('nested: clicking indeterminate parent clears its subfolders', async () => {
    const win = await createApp();
    click(cbFor(win, '/mnt/Photos'));
    await expand(win, '/mnt/Photos');
    click(cbFor(win, '/mnt/Photos/2023'));    // Photos → indeterminate
    click(cbFor(win, '/mnt/Photos'));          // click indeterminate → uncheck all

    assert.equal(cbFor(win, '/mnt/Photos/2023').checked, false);
    assert.equal(cbFor(win, '/mnt/Photos/2024').checked, false);
    assertConsistent(win);
    assert.equal(win.selectedDirs.size, 0);
  });

  test('root reflects partial state when only some top-level folders selected', async () => {
    const win = await createApp();
    click(cbFor(win, '/mnt/Photos'));    // select only Photos (no root click)

    assert.equal(cbFor(win, '/mnt').indeterminate, true);    // root IS indeterminate — Photos checked, Videos not
    assertConsistent(win);

    // Now select root → all, then deselect Videos → root goes indeterminate
    click(cbFor(win, '/mnt'));
    click(cbFor(win, '/mnt/Videos'));
    assert.equal(cbFor(win, '/mnt').indeterminate, true);
    assertConsistent(win);
  });

  test('assertConsistent holds after every step of a complex interaction', async () => {
    const win = await createApp();

    click(cbFor(win, '/mnt'));                   assertConsistent(win);
    await expand(win, '/mnt/Photos');            assertConsistent(win);
    click(cbFor(win, '/mnt/Photos/2023'));        assertConsistent(win);
    click(cbFor(win, '/mnt/Videos'));             assertConsistent(win);
    click(cbFor(win, '/mnt/Photos'));             assertConsistent(win);  // indeterminate → uncheck
    click(cbFor(win, '/mnt/Photos'));             assertConsistent(win);  // recheck
    click(cbFor(win, '/mnt'));                    assertConsistent(win);  // indeterminate root → uncheck
  });

});
