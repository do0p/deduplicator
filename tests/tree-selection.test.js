// Tree selection invariant tests using jsdom + node:test (no browser needed).
//
// Invariants enforced:
//   Folder tree: cb.checked && !cb.indeterminate  ↔  path is in selectedDirs
//   Bin tree:    bc-check.checked                 ↔  path is in selectedBinPaths
//   Accepted:    ac-check.checked                 ↔  path is in selectedAcceptedPaths
//
// Dir checkboxes in bin/accepted trees reflect the aggregate state of their
// leaf descendants (checked = all, indeterminate = some, unchecked = none).

const { test, describe } = require('node:test');
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

// Flat items used for bin and accepted tree tests.
// Tree structure: photos/ → { a.jpg, b.jpg }, c.jpg (at root level)
const BIN_ITEMS = [
  { path: '/recycle/photos/a.jpg', relPath: 'photos/a.jpg', name: 'a.jpg', size: 100, modTime: '' },
  { path: '/recycle/photos/b.jpg', relPath: 'photos/b.jpg', name: 'b.jpg', size: 200, modTime: '' },
  { path: '/recycle/c.jpg',        relPath: 'c.jpg',        name: 'c.jpg', size: 300, modTime: '' },
];

const ACCEPTED_ITEMS = [
  { path: '/mnt/docs/x.jpg', relPath: 'docs/x.jpg', name: 'x.jpg', size: 10, modTime: '' },
  { path: '/mnt/docs/y.jpg', relPath: 'docs/y.jpg', name: 'y.jpg', size: 20, modTime: '' },
  { path: '/mnt/z.jpg',      relPath: 'z.jpg',      name: 'z.jpg', size: 30, modTime: '' },
];

// makeFetch accepts an extras map of pathname → data to override default responses.
function makeFetch(extras = {}) {
  return async (url) => {
    const u = new URL(url, 'http://localhost');
    const p = u.pathname;
    let data;
    if (p in extras) {
      data = extras[p];
    } else if (p === '/api/version') {
      data = { version: 'test' };
    } else if (p === '/api/config') {
      data = { recycleBinEnabled: true };
    } else if (p === '/api/status') {
      data = { phase: '' };
    } else if (p === '/api/browse') {
      data = BROWSE[u.searchParams.get('path') ?? ''] ?? [];
    } else {
      data = {};
    }
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

async function createApp(fetchExtras = {}) {
  const html = HTML.replace('<script src="/app.js"></script>', '');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:3099',
  });

  const win = dom.window;
  win.fetch = makeFetch(fetchExtras);
  win.WebSocket = class { constructor() {} close() {} };

  // Strip 'use strict' so that top-level var declarations (selectedDirs,
  // selectedBinPaths, selectedAcceptedPaths) become window properties —
  // strict-mode eval scopes vars to the eval block.
  const js = JS.replace(/^'use strict';\n/, '');
  win.eval(js);

  await new Promise(r => setTimeout(r, 50));
  return win;
}

async function createBinApp() {
  const win = await createApp({ '/api/bin': BIN_ITEMS });
  await win.openBinView();
  await new Promise(r => setTimeout(r, 20));
  return win;
}

async function createAcceptedApp() {
  const win = await createApp({ '/api/accepted': ACCEPTED_ITEMS });
  await win.openAcceptedView();
  await new Promise(r => setTimeout(r, 20));
  return win;
}

// ---------------------------------------------------------------------------
// Shared click helper
// ---------------------------------------------------------------------------

function click(cb) {
  const win = cb.ownerDocument.defaultView;
  // mousedown first so app's mousedown handler captures pre-click indeterminate state
  cb.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  // native click: jsdom pre-activates (toggles checked) then fires change
  cb.click();
}

// ---------------------------------------------------------------------------
// Folder tree helpers & invariant
// ---------------------------------------------------------------------------

function assertConsistent(win) {
  const cbs = [...win.document.querySelectorAll('#folder-tree input[type=checkbox][data-path]')];
  const fromUI  = cbs.filter(cb => cb.checked && !cb.indeterminate).map(cb => cb.dataset.path).sort();
  const fromSet = [...win.selectedDirs].sort();
  assert.deepEqual(fromUI, fromSet,
    `Folder invariant broken:\n  UI:  ${JSON.stringify(fromUI)}\n  Set: ${JSON.stringify(fromSet)}`);
}

function cbFor(win, path) {
  return win.document.querySelector(`#folder-tree input[type=checkbox][data-path="${path}"]`);
}

async function expand(win, folderPath) {
  const item = [...win.document.querySelectorAll('#folder-tree .tree-item')]
    .find(el => el.querySelector(`input[data-path="${folderPath}"]`));
  const expander = item && item.querySelector('.expander');
  if (expander) expander.click();
  await new Promise(r => setTimeout(r, 30));
}

// ---------------------------------------------------------------------------
// Bin tree helpers & invariant
// ---------------------------------------------------------------------------

// Checked leaf checkboxes must exactly match selectedBinPaths.
function assertBinConsistent(win) {
  const cbs = [...win.document.querySelectorAll('#bin-tree .bc-check')];
  const fromUI  = cbs.filter(cb => cb.checked).map(cb => cb.dataset.path).sort();
  const fromSet = [...win.selectedBinPaths].sort();
  assert.deepEqual(fromUI, fromSet,
    `Bin invariant broken:\n  UI:  ${JSON.stringify(fromUI)}\n  Set: ${JSON.stringify(fromSet)}`);
}

function binCbFor(win, path) {
  return win.document.querySelector(`#bin-tree .bc-check[data-path="${path}"]`);
}

function binDirCbFor(win, name) {
  return win.document.querySelector(`#bin-tree .dir-cb[data-name="${name}"]`);
}

// ---------------------------------------------------------------------------
// Accepted tree helpers & invariant
// ---------------------------------------------------------------------------

function assertAcceptedConsistent(win) {
  const cbs = [...win.document.querySelectorAll('#accepted-tree .ac-check')];
  const fromUI  = cbs.filter(cb => cb.checked).map(cb => cb.dataset.path).sort();
  const fromSet = [...win.selectedAcceptedPaths].sort();
  assert.deepEqual(fromUI, fromSet,
    `Accepted invariant broken:\n  UI:  ${JSON.stringify(fromUI)}\n  Set: ${JSON.stringify(fromSet)}`);
}

function acceptedCbFor(win, path) {
  return win.document.querySelector(`#accepted-tree .ac-check[data-path="${path}"]`);
}

function acceptedDirCbFor(win, name) {
  return win.document.querySelector(`#accepted-tree .dir-cb[data-name="${name}"]`);
}

// ---------------------------------------------------------------------------
// Folder tree tests
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

// ---------------------------------------------------------------------------
// Bin tree tests
// Tree: photos/ → { a.jpg, b.jpg }, c.jpg
// ---------------------------------------------------------------------------

describe('bin tree — selectedBinPaths matches visual state', () => {

  test('initial state: nothing selected', async () => {
    const win = await createBinApp();
    assertBinConsistent(win);
    assert.equal(win.selectedBinPaths.size, 0);
  });

  test('checking a leaf adds it to selectedBinPaths', async () => {
    const win = await createBinApp();
    click(binCbFor(win, '/recycle/photos/a.jpg'));
    assertBinConsistent(win);
    assert.ok(win.selectedBinPaths.has('/recycle/photos/a.jpg'));
    assert.equal(win.selectedBinPaths.size, 1);
  });

  test('unchecking a leaf removes it from selectedBinPaths', async () => {
    const win = await createBinApp();
    click(binCbFor(win, '/recycle/photos/a.jpg'));
    click(binCbFor(win, '/recycle/photos/a.jpg'));
    assertBinConsistent(win);
    assert.equal(win.selectedBinPaths.size, 0);
  });

  test('clicking dir checkbox selects all leaves under it', async () => {
    const win = await createBinApp();
    click(binDirCbFor(win, 'photos'));

    assert.equal(binCbFor(win, '/recycle/photos/a.jpg').checked, true);
    assert.equal(binCbFor(win, '/recycle/photos/b.jpg').checked, true);
    assert.equal(binCbFor(win, '/recycle/c.jpg').checked,        false);
    assertBinConsistent(win);
    assert.equal(win.selectedBinPaths.size, 2);
  });

  test('clicking checked dir unchecks all leaves under it', async () => {
    const win = await createBinApp();
    click(binDirCbFor(win, 'photos'));   // check all in dir
    click(binDirCbFor(win, 'photos'));   // uncheck all

    assert.equal(binCbFor(win, '/recycle/photos/a.jpg').checked, false);
    assert.equal(binCbFor(win, '/recycle/photos/b.jpg').checked, false);
    assertBinConsistent(win);
    assert.equal(win.selectedBinPaths.size, 0);
  });

  test('selecting one leaf makes dir indeterminate', async () => {
    const win = await createBinApp();
    click(binCbFor(win, '/recycle/photos/a.jpg'));

    assert.equal(binDirCbFor(win, 'photos').indeterminate, true);
    assertBinConsistent(win);
  });

  test('selecting all leaves in dir makes dir checked', async () => {
    const win = await createBinApp();
    click(binCbFor(win, '/recycle/photos/a.jpg'));
    click(binCbFor(win, '/recycle/photos/b.jpg'));

    assert.equal(binDirCbFor(win, 'photos').checked,       true);
    assert.equal(binDirCbFor(win, 'photos').indeterminate, false);
    assertBinConsistent(win);
  });

  test('clicking indeterminate dir unchecks all leaves', async () => {
    const win = await createBinApp();
    click(binCbFor(win, '/recycle/photos/a.jpg'));          // dir → indeterminate
    click(binDirCbFor(win, 'photos'));                      // click indeterminate → uncheck all

    assert.equal(binCbFor(win, '/recycle/photos/a.jpg').checked, false);
    assert.equal(binCbFor(win, '/recycle/photos/b.jpg').checked, false);
    assert.equal(binDirCbFor(win, 'photos').checked,             false);
    assert.equal(binDirCbFor(win, 'photos').indeterminate,       false);
    assertBinConsistent(win);
    assert.equal(win.selectedBinPaths.size, 0);
  });

  test('leaf outside dir is independent of dir state', async () => {
    const win = await createBinApp();
    click(binCbFor(win, '/recycle/c.jpg'));

    assert.equal(binCbFor(win, '/recycle/c.jpg').checked,        true);
    assert.equal(binDirCbFor(win, 'photos').checked,             false);
    assert.equal(binDirCbFor(win, 'photos').indeterminate,       false);
    assertBinConsistent(win);
  });

  test('deselecting last leaf in dir makes dir unchecked (not indeterminate)', async () => {
    const win = await createBinApp();
    click(binCbFor(win, '/recycle/photos/a.jpg'));
    click(binCbFor(win, '/recycle/photos/b.jpg'));  // dir → checked
    click(binCbFor(win, '/recycle/photos/a.jpg'));  // dir → indeterminate
    click(binCbFor(win, '/recycle/photos/b.jpg'));  // dir → unchecked

    assert.equal(binDirCbFor(win, 'photos').checked,             false);
    assert.equal(binDirCbFor(win, 'photos').indeterminate,       false);
    assertBinConsistent(win);
    assert.equal(win.selectedBinPaths.size, 0);
  });

  test('assertBinConsistent holds after every step of a complex interaction', async () => {
    const win = await createBinApp();

    click(binDirCbFor(win, 'photos'));                      assertBinConsistent(win);
    click(binCbFor(win, '/recycle/photos/a.jpg'));           assertBinConsistent(win);
    click(binCbFor(win, '/recycle/c.jpg'));                  assertBinConsistent(win);
    click(binDirCbFor(win, 'photos'));                      assertBinConsistent(win);
    click(binDirCbFor(win, 'photos'));                      assertBinConsistent(win);
    click(binCbFor(win, '/recycle/photos/b.jpg'));           assertBinConsistent(win);
    click(binCbFor(win, '/recycle/c.jpg'));                  assertBinConsistent(win);
  });

});

// ---------------------------------------------------------------------------
// Accepted tree tests
// Tree: docs/ → { x.jpg, y.jpg }, z.jpg
// ---------------------------------------------------------------------------

describe('accepted tree — selectedAcceptedPaths matches visual state', () => {

  test('initial state: nothing selected', async () => {
    const win = await createAcceptedApp();
    assertAcceptedConsistent(win);
    assert.equal(win.selectedAcceptedPaths.size, 0);
  });

  test('checking a leaf adds it to selectedAcceptedPaths', async () => {
    const win = await createAcceptedApp();
    click(acceptedCbFor(win, '/mnt/docs/x.jpg'));
    assertAcceptedConsistent(win);
    assert.ok(win.selectedAcceptedPaths.has('/mnt/docs/x.jpg'));
  });

  test('clicking dir checkbox selects all leaves under it', async () => {
    const win = await createAcceptedApp();
    click(acceptedDirCbFor(win, 'docs'));

    assert.equal(acceptedCbFor(win, '/mnt/docs/x.jpg').checked, true);
    assert.equal(acceptedCbFor(win, '/mnt/docs/y.jpg').checked, true);
    assert.equal(acceptedCbFor(win, '/mnt/z.jpg').checked,      false);
    assertAcceptedConsistent(win);
  });

  test('selecting one leaf makes dir indeterminate', async () => {
    const win = await createAcceptedApp();
    click(acceptedCbFor(win, '/mnt/docs/x.jpg'));

    assert.equal(acceptedDirCbFor(win, 'docs').indeterminate, true);
    assertAcceptedConsistent(win);
  });

  test('clicking indeterminate dir unchecks all leaves', async () => {
    const win = await createAcceptedApp();
    click(acceptedCbFor(win, '/mnt/docs/x.jpg'));       // dir → indeterminate
    click(acceptedDirCbFor(win, 'docs'));                // click indeterminate → uncheck

    assert.equal(acceptedCbFor(win, '/mnt/docs/x.jpg').checked, false);
    assert.equal(acceptedCbFor(win, '/mnt/docs/y.jpg').checked, false);
    assertAcceptedConsistent(win);
    assert.equal(win.selectedAcceptedPaths.size, 0);
  });

  test('assertAcceptedConsistent holds after every step of a complex interaction', async () => {
    const win = await createAcceptedApp();

    click(acceptedDirCbFor(win, 'docs'));                     assertAcceptedConsistent(win);
    click(acceptedCbFor(win, '/mnt/docs/x.jpg'));              assertAcceptedConsistent(win);
    click(acceptedCbFor(win, '/mnt/z.jpg'));                   assertAcceptedConsistent(win);
    click(acceptedDirCbFor(win, 'docs'));                     assertAcceptedConsistent(win);
    click(acceptedDirCbFor(win, 'docs'));                     assertAcceptedConsistent(win);
    click(acceptedCbFor(win, '/mnt/docs/y.jpg'));              assertAcceptedConsistent(win);
  });

});
