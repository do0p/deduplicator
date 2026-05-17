'use strict';

// ---- State ----
var selectedDirs = new Set(); // var so tests can read window.selectedDirs
let allGroups = [];
let currentFilteredGroups = [];
let sortCol = 'size';
let sortAsc = false;
let expandedRow = null;
let selectedPaths = new Set();
let recycleBinEnabled = false;
let exactOnly = false;
let binItems = [];
var selectedBinPaths = new Set();      // var so tests can read window.selectedBinPaths
let acceptedItems = [];
var selectedAcceptedPaths = new Set(); // var so tests can read window.selectedAcceptedPaths

// ---- Utilities ----
const $ = id => document.getElementById(id);

function isVideo(path) {
  return /\.(mp4|mov|avi|mkv|m4v|wmv|flv|webm|3gp|ts|mts|m2ts)$/i.test(path);
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('view-' + name).classList.add('active');
}

function fmt(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function basename(path) {
  return path.split('/').pop();
}

function dirname(path) {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.substring(0, i) : path;
}

function trapFocus(container) {
  const sel = 'button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';
  const getFocusable = () => [...container.querySelectorAll(sel)];
  function handler(e) {
    if (e.key !== 'Tab') return;
    const els = getFocusable();
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch (_) { return iso; }
}

// EXIF dates look like "2023:05:14 10:30:00" — normalize colons before parsing.
function fmtExifDate(s) {
  if (!s) return '';
  const norm = s.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  const d = new Date(norm);
  if (isNaN(d)) return s;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---- View 1: Folder Tree ----

// Sets all checkboxes with data-path inside container to checked/unchecked,
// updating selectedDirs accordingly.
function setSubtreeChecked(container, checked) {
  container.querySelectorAll('input[type=checkbox][data-path]').forEach(cb => {
    cb.checked = checked;
    cb.indeterminate = false;
    if (checked) selectedDirs.add(cb.dataset.path);
    else selectedDirs.delete(cb.dataset.path);
  });
}

async function loadTree(path, container, depth = 0, parentCb = null) {
  const res = await fetch('/api/browse?path=' + encodeURIComponent(path));
  if (!res.ok) return;
  const entries = await res.json();

  container.innerHTML = '';

  // At the root level, prepend a node representing the mount root itself so
  // the user can select all folders with a single click.
  if (depth === 0 && entries && entries.length > 0) {
    const rootPath = entries[0].path.substring(0, entries[0].path.lastIndexOf('/'));
    if (rootPath) {
      const rootItem = document.createElement('div');
      rootItem.className = 'tree-item tree-root';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.path = rootPath;
      cb.title = 'Select all folders';
      let _preInd = false;
      cb.addEventListener('mousedown', () => { _preInd = cb.indeterminate; });
      cb.addEventListener('keydown', e => { if (e.key === ' ') _preInd = cb.indeterminate; });
      cb.addEventListener('change', () => {
        if (_preInd) cb.checked = false;
        cb.indeterminate = false;
        setSubtreeChecked($('folder-tree'), cb.checked);
        $('btn-scan').disabled = selectedDirs.size === 0;
      });

      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = '🗄️';

      const label = document.createElement('span');
      label.className = 'root-label';
      label.textContent = rootPath;

      const hint = document.createElement('span');
      hint.className = 'root-hint';
      hint.textContent = 'all folders';

      rootItem.append(cb, icon, label, hint);
      container.appendChild(rootItem);

      const sep = document.createElement('div');
      sep.className = 'tree-separator';
      container.appendChild(sep);
    }
  }

  for (const e of entries || []) {
    if (!e.isDir) continue;

    const item = document.createElement('div');
    item.className = 'tree-item';
    item.style.paddingLeft = (depth * 1.2) + 'rem';

    const expander = document.createElement('span');
    expander.className = 'expander';
    expander.textContent = '▶';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.path = e.path;

    // If the parent is checked or partially checked, start this node checked too.
    if (parentCb && (parentCb.checked || parentCb.indeterminate)) {
      cb.checked = true;
      selectedDirs.add(e.path);
      $('btn-scan').disabled = false;
    }

    cb._parentCb = parentCb || null;

    const children = document.createElement('div');
    children.className = 'tree-children';
    children.style.display = 'none';

    cb._childrenContainer = children;

    let _preInd = false;
    cb.addEventListener('mousedown', () => { _preInd = cb.indeterminate; });
    cb.addEventListener('keydown', ev => { if (ev.key === ' ') _preInd = cb.indeterminate; });
    cb.addEventListener('change', () => {
      if (_preInd) cb.checked = false;
      cb.indeterminate = false;
      if (cb.checked) selectedDirs.add(e.path);
      else selectedDirs.delete(e.path);
      setSubtreeChecked(children, cb.checked);
      updateFolderAncestors(cb);
      $('btn-scan').disabled = selectedDirs.size === 0;
    });

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '📁';

    const label = document.createElement('span');
    label.textContent = e.name;

    item.append(expander, cb, icon, label);

    let loaded = false;

    async function toggleExpand() {
      if (children.style.display === 'none') {
        if (!loaded) {
          expander.textContent = '⋯';
          await loadTree(e.path, children, depth + 1, cb);
          loaded = true;
        }
        children.style.display = 'block';
        expander.textContent = '▼';
      } else {
        children.style.display = 'none';
        expander.textContent = '▶';
      }
    }

    // Expander arrow and folder label both expand/collapse — only the checkbox selects.
    expander.addEventListener('click', ev => { ev.stopPropagation(); toggleExpand(); });
    label.addEventListener('click', ev => { ev.stopPropagation(); toggleExpand(); });
    icon.addEventListener('click', ev => { ev.stopPropagation(); toggleExpand(); });

    container.appendChild(item);
    container.appendChild(children);
  }

  if (!entries || entries.length === 0) {
    container.innerHTML = '<div style="color:#64748b;font-size:0.8rem;padding:0.25rem 0.5rem">Empty</div>';
  }
}

// ---- Tree indeterminate helpers ----

function updateFolderAncestors(cb) {
  const parentCb = cb._parentCb;
  if (!parentCb) {
    updateRootCheckbox();
    return;
  }
  const childrenContainer = parentCb._childrenContainer;
  if (!childrenContainer) return;

  const childCbs = [...childrenContainer.querySelectorAll('input[type=checkbox][data-path]')];
  if (childCbs.length === 0) return;

  const allChecked = childCbs.every(c => c.checked && !c.indeterminate);
  const anyChecked = childCbs.some(c => c.checked || c.indeterminate);

  if (allChecked) {
    parentCb.checked = true;
    parentCb.indeterminate = false;
    selectedDirs.add(parentCb.dataset.path);
  } else if (anyChecked) {
    parentCb.checked = false;
    parentCb.indeterminate = true;
    selectedDirs.delete(parentCb.dataset.path);
  } else {
    parentCb.checked = false;
    parentCb.indeterminate = false;
    selectedDirs.delete(parentCb.dataset.path);
  }

  updateFolderAncestors(parentCb);
  $('btn-scan').disabled = selectedDirs.size === 0;
}

function updateRootCheckbox() {
  const rootCb = $('folder-tree').querySelector('.tree-root input[type=checkbox]');
  if (!rootCb) return;
  const allCbs = [...$('folder-tree').querySelectorAll('input[type=checkbox][data-path]')]
    .filter(c => !c.closest('.tree-root'));
  if (allCbs.length === 0) return;
  const allChecked = allCbs.every(c => c.checked && !c.indeterminate);
  const anyChecked = allCbs.some(c => c.checked || c.indeterminate);
  rootCb.checked = allChecked;
  rootCb.indeterminate = !allChecked && anyChecked;
  if (allChecked) selectedDirs.add(rootCb.dataset.path);
  else selectedDirs.delete(rootCb.dataset.path);
}

// Updates a single dir checkbox state based on its body's leaf checkboxes.
function updateDirCheckboxState(dirCb, body) {
  const leafCbs = [...body.querySelectorAll('input[type=checkbox]:not(.dir-cb)')];
  if (leafCbs.length === 0) { dirCb.checked = false; dirCb.indeterminate = false; return; }
  const checkedCount = leafCbs.filter(c => c.checked).length;
  if (checkedCount === leafCbs.length) {
    dirCb.checked = true; dirCb.indeterminate = false;
  } else if (checkedCount === 0) {
    dirCb.checked = false; dirCb.indeterminate = false;
  } else {
    dirCb.checked = false; dirCb.indeterminate = true;
  }
}

// Walks up the DOM from startElement and updates all ancestor dir checkboxes.
function updateAncestorDirCheckboxes(startElement) {
  let node = startElement.parentElement;
  while (node) {
    if (node.classList.contains('bin-dir-body')) {
      const hd = node.previousElementSibling;
      if (hd && hd.classList.contains('bin-dir-hd')) {
        const dirCb = hd.querySelector('.dir-cb');
        if (dirCb) updateDirCheckboxState(dirCb, node);
      }
    }
    node = node.parentElement;
  }
}

// ---- View 2: Progress ----
let ws = null;

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return '~' + s + 's';
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return '~' + m + 'm ' + rem + 's';
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return '~' + h + 'h ' + rm + 'm';
}

function startProgress() {
  showView('progress');

  const bar = $('progress-bar');
  const counter = $('counter');
  const phaseLabel = $('phase-label');
  const title = $('progress-title');

  bar.value = 0;
  bar.max = 100;
  counter.textContent = '';
  title.textContent = 'Scanning…';

  let closedIntentionally = false;
  let hashStartTime = null;
  let lastCounterUpdate = 0;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = e => {
    const p = JSON.parse(e.data);

    if (p.phase === 'walking') {
      title.textContent = 'Walking directories…';
      phaseLabel.textContent = 'Collecting image files…';
      bar.removeAttribute('value'); // indeterminate
      counter.textContent = '';
    } else if (p.phase === 'scanning') {
      title.textContent = 'Hashing media files…';
      phaseLabel.textContent = 'Computing hashes…';
      if (p.total > 0) {
        bar.value = p.scanned;
        bar.max = p.total;

        if (p.scanned > 0 && !hashStartTime) {
          const stored = localStorage.getItem('hashStartTime');
          hashStartTime = stored ? parseInt(stored, 10) : Date.now();
          if (!stored) localStorage.setItem('hashStartTime', String(hashStartTime));
        }

        const now = Date.now();
        if (now - lastCounterUpdate >= 1000) {
          lastCounterUpdate = now;
          let eta = '';
          if (hashStartTime && p.scanned > 0) {
            const elapsed = now - hashStartTime;
            // Only show ETA after 5 s of data to avoid wild early estimates.
            if (elapsed >= 5000) {
              const msPerFile = elapsed / p.scanned;
              const remaining = (p.total - p.scanned) * msPerFile;
              eta = ' · ' + fmtDuration(remaining) + ' remaining';
            }
          }
          counter.textContent = p.scanned.toLocaleString() + ' / ' + p.total.toLocaleString() + ' files' + eta;
        }
      }
    } else if (p.phase === 'matching') {
      title.textContent = 'Matching duplicates…';
      phaseLabel.textContent = 'Comparing hashes…';
      bar.value = bar.max = 1;
      counter.textContent = p.total.toLocaleString() + ' files hashed';
    } else if (p.phase === 'done') {
      localStorage.removeItem('hashStartTime');
      closedIntentionally = true;
      ws.close();
      ws = null;
      loadResults();
    } else if (p.phase === 'cancelled') {
      localStorage.removeItem('hashStartTime');
      closedIntentionally = true;
      ws.close();
      ws = null;
      // goToSetup() will be called by the cancel button click handler.
    } else if (p.phase === 'error') {
      localStorage.removeItem('hashStartTime');
      title.textContent = 'Error';
      phaseLabel.textContent = 'Error: ' + (p.error || 'unknown');
      counter.textContent = '';
    }
  };

  ws.onerror = () => { /* onclose handles recovery */ };

  ws.onclose = async () => {
    if (closedIntentionally) return;
    // Unexpected disconnect — check if scan finished while we were disconnected.
    try {
      const res = await fetch('/api/status');
      const status = await res.json();
      if (status.phase === 'done') {
        loadResults();
        return;
      }
      if (status.phase === 'error') {
        phaseLabel.textContent = 'Error: ' + (status.error || 'unknown');
        return;
      }
    } catch (_) { /* ignore fetch errors */ }
    phaseLabel.textContent = 'Connection lost. Start a new scan or reload.';
  };
}

// ---- Selection & Actions ----

function updateActionBar() {
  const n = selectedPaths.size;
  $('sel-count').textContent = n > 0
    ? n + ' image' + (n === 1 ? '' : 's') + ' selected'
    : 'No images selected';
  $('btn-apply').disabled = n === 0;
}

function onFileCheckChange(e) {
  const path = e.target.dataset.path;
  if (e.target.checked) selectedPaths.add(path);
  else selectedPaths.delete(path);
  updateActionBar();
}

function clearSelection() {
  selectedPaths.clear();
  document.querySelectorAll('.fc-check').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('.group-sel-all input').forEach(cb => { cb.checked = false; });
  updateActionBar();
}

function removePathsFromResults(paths) {
  const removed = new Set(paths);
  allGroups = allGroups
    .map(g => ({ ...g, files: g.files.filter(f => !removed.has(f.path)) }))
    .filter(g => g.files.length >= 2);
  renderResults();
}

let confirmTriggerEl = null;
let confirmReleaseTrap = null;

function showConfirm(title, desc, filenames) {
  return new Promise(resolve => {
    $('confirm-title').textContent = title;
    $('confirm-desc').textContent = desc;
    const list = $('confirm-list');
    list.innerHTML = '';
    filenames.forEach(name => {
      const li = document.createElement('li');
      li.textContent = name;
      list.appendChild(li);
    });
    confirmTriggerEl = document.activeElement;
    $('confirm-modal').classList.add('open');
    if (confirmReleaseTrap) confirmReleaseTrap();
    confirmReleaseTrap = trapFocus($('confirm-modal'));
    $('confirm-cancel').focus();

    function finish(result) {
      $('confirm-modal').classList.remove('open');
      if (confirmReleaseTrap) { confirmReleaseTrap(); confirmReleaseTrap = null; }
      if (confirmTriggerEl) { confirmTriggerEl.focus(); confirmTriggerEl = null; }
      $('confirm-ok').removeEventListener('click', onOk);
      $('confirm-cancel').removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { finish(true); }
    function onCancel() { finish(false); }
    $('confirm-ok').addEventListener('click', onOk);
    $('confirm-cancel').addEventListener('click', onCancel);
  });
}

$('confirm-cancel').addEventListener('click', () => {}); // prevent bubbling setup duplication
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('confirm-modal').classList.contains('open'))
    $('confirm-modal').classList.remove('open');
});
$('confirm-modal').addEventListener('click', e => {
  if (e.target === $('confirm-modal')) $('confirm-modal').classList.remove('open');
});

$('btn-clear-sel').addEventListener('click', clearSelection);

$('btn-apply').addEventListener('click', async () => {
  const action = $('action-select').value;
  if (!action || selectedPaths.size === 0) return;

  const paths = [...selectedPaths];
  const names = paths.map(p => basename(p));

  let title, desc;
  if (action === 'accept') {
    title = 'Accept ' + paths.length + ' image' + (paths.length === 1 ? '' : 's') + '?';
    desc = 'These images will be hidden from all future scan results.';
  } else {
    title = 'Move ' + paths.length + ' image' + (paths.length === 1 ? '' : 's') + ' to Recycle Bin?';
    desc = 'These files will be physically moved to the recycle bin directory.';
  }

  const confirmed = await showConfirm(title, desc, names);
  if (!confirmed) return;

  const endpoint = action === 'accept' ? '/api/accept' : '/api/trash';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) {
      const text = await res.text();
      alert('Action failed: ' + text);
      return;
    }
    if (action === 'trash') {
      const data = await res.json();
      if (data.failed && data.failed.length > 0) {
        const msgs = data.failed.map(f => basename(f.path) + ': ' + f.error).join('\n');
        alert('Some files could not be moved:\n' + msgs);
      }
      removePathsFromResults(data.moved || []);
    } else {
      removePathsFromResults(paths);
    }
    clearSelection();
    $('action-select').value = '';
  } catch (err) {
    alert('Request failed: ' + err.message);
  }
});

// ---- View 3: Results ----
async function loadResults() {
  try {
    const res = await fetch('/api/results');
    if (!res.ok) { showView('setup'); return; }
    allGroups = await res.json() || [];
    renderResults();
    showView('results');
  } catch (err) {
    console.error('loadResults failed:', err);
    showView('results');
    return;
  }
  updateActionBar();
}

function groupTotalSize(g) {
  return g.files.reduce((s, f) => s + f.size, 0);
}

function groupWasted(g) {
  if (!g.files.length) return 0;
  const smallest = Math.min(...g.files.map(f => f.size));
  return groupTotalSize(g) - smallest;
}

function isExactGroup(g) {
  const h = g.files[0]?.contentHash;
  return !!h && g.files.every(f => f.contentHash === h);
}

function renderResults() {
  const filter = ($('filter-input').value || '').toLowerCase();

  let groups = allGroups.filter(g => {
    if (exactOnly && !isExactGroup(g)) return false;
    return !filter || g.files.some(f => f.path.toLowerCase().includes(filter));
  });

  groups.sort((a, b) => {
    let va, vb;
    if (sortCol === 'name') {
      va = basename(a.files[0]?.path || '');
      vb = basename(b.files[0]?.path || '');
    } else if (sortCol === 'count') {
      va = a.files.length; vb = b.files.length;
    } else {
      va = groupTotalSize(a); vb = groupTotalSize(b);
    }
    if (va < vb) return sortAsc ? -1 : 1;
    if (va > vb) return sortAsc ? 1 : -1;
    return 0;
  });

  // Stats
  const totalWasted = allGroups.reduce((s, g) => s + groupWasted(g), 0);
  $('stats').textContent =
    allGroups.length + ' groups · ' + fmt(totalWasted) + ' wasted';

  const tbody = $('results-body');
  tbody.innerHTML = '';
  expandedRow = null;

  $('action-bar').style.display = allGroups.length === 0 ? 'none' : '';
  if (groups.length === 0) {
    $('no-results').style.display = 'block';
    return;
  }
  $('no-results').style.display = 'none';
  currentFilteredGroups = groups;

  groups.forEach((g, idx) => {
    const rep = g.files[0];
    const totalSize = groupTotalSize(g);

    const tr = document.createElement('tr');
    tr.dataset.idx = idx;
    tr.innerHTML = `
      <td class="filename">${escHtml(basename(rep.path))}</td>
      <td><span class="count-badge">${g.files.length}</span></td>
      <td class="size-cell">${fmt(totalSize)}</td>
    `;
    tr.addEventListener('click', () => toggleDetail(tr, g, idx));
    tbody.appendChild(tr);
  });
}

function makeResultsCheckCallback() {
  return (p, checked) => {
    if (checked) selectedPaths.add(p); else selectedPaths.delete(p);
    const mainCb = [...document.querySelectorAll('.fc-check')].find(c => c.dataset.path === p);
    if (mainCb) mainCb.checked = checked;
    updateActionBar();
  };
}

function toggleDetail(tr, g, groupIdx) {
  // Collapse previous
  if (expandedRow && expandedRow !== tr) {
    const prev = tbody.querySelector('tr.detail-row');
    if (prev) prev.remove();
    expandedRow.classList.remove('expanded');
  }

  if (expandedRow === tr) {
    const detail = tbody.querySelector('tr.detail-row');
    if (detail) detail.remove();
    tr.classList.remove('expanded');
    expandedRow = null;
    return;
  }

  tr.classList.add('expanded');
  expandedRow = tr;

  const detail = document.createElement('tr');
  detail.className = 'detail-row';
  const td = document.createElement('td');
  td.colSpan = 3;
  const inner = document.createElement('div');
  inner.className = 'detail-inner';

  // Group-level select-all row
  const selAllLabel = document.createElement('label');
  selAllLabel.className = 'group-sel-all';
  const selAllCb = document.createElement('input');
  selAllCb.type = 'checkbox';
  selAllCb.addEventListener('change', () => {
    inner.querySelectorAll('.fc-check').forEach(cb => {
      cb.checked = selAllCb.checked;
      if (selAllCb.checked) selectedPaths.add(cb.dataset.path);
      else selectedPaths.delete(cb.dataset.path);
    });
    updateActionBar();
  });
  selAllLabel.append(selAllCb, ' Select all in group');
  inner.appendChild(selAllLabel);

  g.files.forEach((f, idx) => {
    const card = document.createElement('div');
    card.className = 'file-card';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'fc-check';
    cb.dataset.path = f.path;
    cb.checked = selectedPaths.has(f.path);
    cb.addEventListener('change', e => {
      e.stopPropagation();
      onFileCheckChange(e);
    });

    let thumb;
    if (isVideo(f.path)) {
      thumb = document.createElement('video');
      thumb.src = '/api/image?path=' + encodeURIComponent(f.path);
      thumb.muted = true;
      thumb.preload = 'metadata';
    } else {
      thumb = document.createElement('img');
      thumb.src = '/api/image?path=' + encodeURIComponent(f.path);
      thumb.alt = basename(f.path);
      thumb.loading = 'lazy';
    }
    thumb.addEventListener('click', ev => {
      ev.stopPropagation();
      openModal(f.path, g.files, idx,
        makeResultsCheckCallback(),
        p => selectedPaths.has(p),
        currentFilteredGroups,
        groupIdx
      );
    });

    const nameEl = document.createElement('div');
    nameEl.className = 'fc-name';
    nameEl.textContent = basename(f.path);
    nameEl.title = f.path;

    const folderEl = document.createElement('div');
    folderEl.className = 'fc-folder';
    folderEl.textContent = dirname(f.path);
    folderEl.title = dirname(f.path);

    const sizeEl = document.createElement('div');
    sizeEl.className = 'fc-size';
    sizeEl.textContent = fmt(f.size);

    const modEl = document.createElement('div');
    modEl.className = 'fc-mod';
    modEl.textContent = fmtDate(f.modTime);

    card.append(cb, thumb, nameEl, folderEl, sizeEl, modEl);
    inner.appendChild(card);
  });

  td.appendChild(inner);
  detail.appendChild(td);
  tr.after(detail);
}

// tbody reference for toggleDetail
const tbody = document.getElementById('results-body');

// ---- Modal ----
let modalFiles = [];
let modalFileIndex = 0;
let modalCurrentPath = '';
let modalCheckCallback = null;
let modalGetChecked = null;
let modalTriggerEl = null;
let modalReleaseTrap = null;
let modalGroupList = null;
let modalGroupIndex = -1;

function stopModalVideo() {
  const v = $('modal-video');
  v.pause();
  v.src = '';
}

async function openModal(path, files = null, index = 0, checkCallback = null, getChecked = null, groupList = null, groupIndex = -1) {
  stopModalVideo();
  modalFiles = files || [];
  modalFileIndex = index;
  modalCurrentPath = path;
  modalCheckCallback = checkCallback || null;
  modalGetChecked = getChecked || null;
  modalGroupList = groupList;
  modalGroupIndex = groupIndex;

  const url = '/api/image?path=' + encodeURIComponent(path);
  if (isVideo(path)) {
    $('modal-img').style.display = 'none';
    $('modal-video').style.display = '';
    $('modal-video').src = url;
  } else {
    $('modal-img').style.display = '';
    $('modal-video').style.display = 'none';
    $('modal-img').src = url;
  }

  const hasNav = modalFiles.length > 1;
  const hasCheck = !!checkCallback;
  $('modal-nav').style.display = (hasNav || hasCheck) ? '' : 'none';
  $('modal-nav-btns').style.display = hasNav ? '' : 'none';
  if (hasNav) {
    $('modal-prev').disabled = modalFileIndex === 0;
    $('modal-next').disabled = modalFileIndex === modalFiles.length - 1;
    $('modal-nav-count').textContent = (modalFileIndex + 1) + ' / ' + modalFiles.length;
  }
  $('modal-check-wrap').style.display = hasCheck ? '' : 'none';
  if (hasCheck) $('modal-check').checked = getChecked ? getChecked(path) : false;

  $('modal-info').innerHTML = '<div class="mi-loading">Loading…</div>';
  modalTriggerEl = document.activeElement;
  $('modal').classList.add('open');
  if (modalReleaseTrap) modalReleaseTrap();
  modalReleaseTrap = trapFocus($('modal-content'));
  requestAnimationFrame(() => {
    const firstFocusable = $('modal-content').querySelector('button:not(:disabled), input:not(:disabled)');
    if (firstFocusable) firstFocusable.focus();
  });

  try {
    const res = await fetch('/api/fileinfo?path=' + encodeURIComponent(path));
    if (res.ok) renderModalInfo(await res.json());
    else $('modal-info').innerHTML = '<div class="mi-loading">No info available.</div>';
  } catch (_) {
    $('modal-info').innerHTML = '<div class="mi-loading">Could not load info.</div>';
  }
}

function renderModalInfo(info) {
  const rows = [
    ['Filename', escHtml(info.name)],
    ['Folder',   escHtml(info.folder)],
    ['Size',     fmt(info.size)],
    ['Modified', fmtDate(info.modTime)],
  ];

  if (info.width && info.height) {
    rows.push(['Resolution', info.width + ' × ' + info.height + ' px']);
  }

  if (info.exif) {
    const taken = info.exif['DateTimeOriginal'] || info.exif['DateTime'];
    if (taken) rows.push(['Taken', fmtExifDate(taken)]);
    const camera = [info.exif['Make'], info.exif['Model']].filter(Boolean).join(' ');
    if (camera) rows.push(['Camera', escHtml(camera)]);
    const lens = info.exif['LensModel'];
    if (lens) rows.push(['Lens', escHtml(lens)]);
    const iso = info.exif['ISOSpeedRatings'];
    if (iso) rows.push(['ISO', escHtml(iso)]);
    const exp = info.exif['ExposureTime'];
    if (exp) rows.push(['Exposure', escHtml(exp) + ' s']);
    const fNumber = info.exif['FNumber'];
    if (fNumber) rows.push(['Aperture', 'f/' + escHtml(fNumber)]);
    const fl = info.exif['FocalLength'];
    if (fl) rows.push(['Focal length', escHtml(fl)]);
  }

  if (info.hasGPS) {
    const lat = info.lat.toFixed(6);
    const lon = info.lon.toFixed(6);
    const url = 'https://www.google.com/maps?q=' + lat + ',' + lon;
    rows.push(['Location', '<a href="' + url + '" target="_blank" rel="noopener" class="maps-link">📍 ' + lat + ', ' + lon + '</a>']);
  }

  let html = '<div class="mi-table">';
  for (const [k, v] of rows) {
    html += '<div class="mi-row"><div class="mi-key">' + k + '</div><div class="mi-val">' + v + '</div></div>';
  }
  html += '</div>';

  const exifEntries = info.exif ? Object.entries(info.exif).sort((a, b) => a[0].localeCompare(b[0])) : [];
  if (exifEntries.length > 0) {
    html += '<div class="mi-section-hd">All EXIF data</div>';
    html += '<div class="exif-table">';
    for (const [k, v] of exifEntries) {
      html += '<div class="exif-row"><div class="exif-key">' + escHtml(k) + '</div><div class="exif-val">' + escHtml(v) + '</div></div>';
    }
    html += '</div>';
  }

  $('modal-info').innerHTML = html;
}

function closeModal() {
  resetZoom();
  sliderSet('', false);
  if (modalReleaseTrap) { modalReleaseTrap(); modalReleaseTrap = null; }
  if (modalTriggerEl) { modalTriggerEl.focus(); modalTriggerEl = null; }
  $('modal').classList.remove('open');
  stopModalVideo();
}
$('modal-close').addEventListener('click', closeModal);
$('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
$('modal-prev').addEventListener('click', () => {
  if (modalFileIndex > 0) { resetZoom(); openModal(modalFiles[--modalFileIndex].path, modalFiles, modalFileIndex, modalCheckCallback, modalGetChecked, modalGroupList, modalGroupIndex); }
});
$('modal-next').addEventListener('click', () => {
  if (modalFileIndex < modalFiles.length - 1) { resetZoom(); openModal(modalFiles[++modalFileIndex].path, modalFiles, modalFileIndex, modalCheckCallback, modalGetChecked, modalGroupList, modalGroupIndex); }
});
$('modal-check').addEventListener('change', e => {
  if (modalCheckCallback) modalCheckCallback(modalCurrentPath, e.target.checked);
});
document.addEventListener('keydown', e => {
  if (!$('modal').classList.contains('open')) return;
  if (e.key === 'Escape') closeModal();
  else if (e.key === 'ArrowLeft' && modalFileIndex > 0)
    { resetZoom(); openModal(modalFiles[--modalFileIndex].path, modalFiles, modalFileIndex, modalCheckCallback, modalGetChecked, modalGroupList, modalGroupIndex); }
  else if (e.key === 'ArrowRight' && modalFileIndex < modalFiles.length - 1)
    { resetZoom(); openModal(modalFiles[++modalFileIndex].path, modalFiles, modalFileIndex, modalCheckCallback, modalGetChecked, modalGroupList, modalGroupIndex); }
});

// ---- Modal touch: swipe navigation + pinch zoom ----
let zoomScale = 1, zoomTx = 0, zoomTy = 0;
const mediaSlider = $('modal-media-slider');
const zoomWrap = $('modal-zoom-wrap');
const imgWrapEl = $('modal-content').querySelector('.modal-img-wrap');

function applyZoom() {
  zoomWrap.style.transform = (zoomScale === 1 && !zoomTx && !zoomTy)
    ? '' : `translate(${zoomTx}px, ${zoomTy}px) scale(${zoomScale})`;
}

function resetZoom(animated = false) {
  zoomScale = 1; zoomTx = 0; zoomTy = 0;
  if (animated) {
    zoomWrap.style.transition = 'transform 0.25s ease';
    applyZoom();
    setTimeout(() => { zoomWrap.style.transition = ''; }, 260);
  } else {
    zoomWrap.style.transition = '';
    applyZoom();
  }
}

function sliderSet(transform, animated) {
  if (animated) mediaSlider.classList.remove('no-transition');
  else mediaSlider.classList.add('no-transition');
  mediaSlider.style.transform = transform;
}

function commitSwipe(outTransform, inTransform, action) {
  sliderSet(outTransform, true);
  mediaSlider.addEventListener('transitionend', function once() {
    sliderSet(inTransform, false);
    action();
    requestAnimationFrame(() => requestAnimationFrame(() => sliderSet('', true)));
  }, { once: true });
}

// Gesture state
let touchMode = null; // 'swipe' | 'pan' | 'pinch'
let swipeTouchStart = null, swipeAxis = null;
let pinchStart = null; // { dist, scale, tx, ty, cx, cy }
let panStart = null;   // { x, y, tx, ty }
let lastTapTime = 0, lastTapX = 0, lastTapY = 0;

$('modal-content').addEventListener('touchstart', e => {
  if (e.target.closest('.modal-info, button, input')) { swipeTouchStart = null; return; }

  if (e.touches.length >= 2) {
    touchMode = 'pinch';
    swipeTouchStart = null;
    const t0 = e.touches[0], t1 = e.touches[1];
    const rect = imgWrapEl.getBoundingClientRect();
    pinchStart = {
      dist:  Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY),
      scale: zoomScale, tx: zoomTx, ty: zoomTy,
      cx: (t0.clientX + t1.clientX) / 2 - rect.left,
      cy: (t0.clientY + t1.clientY) / 2 - rect.top,
    };
    return;
  }

  const t = e.touches[0];

  if (zoomScale > 1) {
    touchMode = 'pan';
    panStart = { x: t.clientX, y: t.clientY, tx: zoomTx, ty: zoomTy };
    return;
  }

  // Double-tap to zoom
  const now = Date.now();
  if (now - lastTapTime < 300 && Math.hypot(t.clientX - lastTapX, t.clientY - lastTapY) < 30) {
    lastTapTime = 0;
    if (zoomScale === 1) {
      const rect = imgWrapEl.getBoundingClientRect();
      const cx = t.clientX - rect.left, cy = t.clientY - rect.top;
      zoomScale = 2.5; zoomTx = cx * (1 - 2.5); zoomTy = cy * (1 - 2.5);
      zoomWrap.style.transition = 'transform 0.25s ease';
      applyZoom();
      setTimeout(() => { zoomWrap.style.transition = ''; }, 260);
    } else {
      resetZoom(true);
    }
    touchMode = null;
    return;
  }
  lastTapTime = now; lastTapX = t.clientX; lastTapY = t.clientY;

  touchMode = 'swipe';
  swipeAxis = null;
  swipeTouchStart = { x: t.clientX, y: t.clientY };
}, { passive: true });

$('modal-content').addEventListener('touchmove', e => {
  if (touchMode === 'pinch' && e.touches.length >= 2) {
    const t0 = e.touches[0], t1 = e.touches[1];
    const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
    const newScale = Math.min(5, Math.max(1, pinchStart.scale * dist / pinchStart.dist));
    const ratio = newScale / pinchStart.scale;
    zoomScale = newScale;
    zoomTx = pinchStart.cx - (pinchStart.cx - pinchStart.tx) * ratio;
    zoomTy = pinchStart.cy - (pinchStart.cy - pinchStart.ty) * ratio;
    applyZoom();
    return;
  }

  if (touchMode === 'pan') {
    const t = e.touches[0];
    zoomTx = panStart.tx + (t.clientX - panStart.x);
    zoomTy = panStart.ty + (t.clientY - panStart.y);
    applyZoom();
    return;
  }

  if (touchMode === 'swipe' && swipeTouchStart) {
    const t = e.changedTouches[0];
    const dx = t.clientX - swipeTouchStart.x, dy = t.clientY - swipeTouchStart.y;
    const absDx = Math.abs(dx), absDy = Math.abs(dy);
    if (!swipeAxis && (absDx > 8 || absDy > 8)) swipeAxis = absDx >= absDy ? 'h' : 'v';
    if (!swipeAxis) return;
    if (swipeAxis === 'h') sliderSet(`translateX(${dx}px)`, false);
    else sliderSet(`translateY(${dy}px)`, false);
  }
}, { passive: true });

$('modal-content').addEventListener('touchend', e => {
  if (touchMode === 'pinch') {
    if (zoomScale < 1.08) resetZoom(true);
    touchMode = null;
    return;
  }

  if (touchMode === 'pan') {
    const t = e.changedTouches[0];
    if (Math.abs(t.clientX - panStart.x) < 6 && Math.abs(t.clientY - panStart.y) < 6) resetZoom(true);
    touchMode = null;
    return;
  }

  if (touchMode !== 'swipe' || !swipeTouchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipeTouchStart.x, dy = t.clientY - swipeTouchStart.y;
  swipeTouchStart = null; touchMode = null;
  if (!swipeAxis) return;
  const threshold = 40;

  if (swipeAxis === 'h') {
    if (dx < -threshold && modalFileIndex < modalFiles.length - 1)
      commitSwipe('translateX(-110%)', 'translateX(110%)', () =>
        { resetZoom(); openModal(modalFiles[++modalFileIndex].path, modalFiles, modalFileIndex, modalCheckCallback, modalGetChecked, modalGroupList, modalGroupIndex); });
    else if (dx > threshold && modalFileIndex > 0)
      commitSwipe('translateX(110%)', 'translateX(-110%)', () =>
        { resetZoom(); openModal(modalFiles[--modalFileIndex].path, modalFiles, modalFileIndex, modalCheckCallback, modalGetChecked, modalGroupList, modalGroupIndex); });
    else sliderSet('', true);
  } else {
    if (dy < -threshold && modalGroupList && modalGroupIndex < modalGroupList.length - 1) {
      const g = modalGroupList[modalGroupIndex + 1];
      commitSwipe('translateY(-110%)', 'translateY(110%)', () =>
        { resetZoom(); openModal(g.files[0].path, g.files, 0, makeResultsCheckCallback(), p => selectedPaths.has(p), modalGroupList, modalGroupIndex + 1); });
    } else if (dy > threshold && modalGroupList && modalGroupIndex > 0) {
      const g = modalGroupList[modalGroupIndex - 1];
      commitSwipe('translateY(110%)', 'translateY(-110%)', () =>
        { resetZoom(); openModal(g.files[0].path, g.files, 0, makeResultsCheckCallback(), p => selectedPaths.has(p), modalGroupList, modalGroupIndex - 1); });
    } else sliderSet('', true);
  }
}, { passive: true });

$('modal-content').addEventListener('touchcancel', () => {
  touchMode = null; swipeTouchStart = null;
  sliderSet('', true);
}, { passive: true });

// ---- Sorting ----
document.querySelectorAll('thead th[data-col]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (sortCol === col) sortAsc = !sortAsc;
    else { sortCol = col; sortAsc = true; }
    document.querySelectorAll('thead th').forEach(t => t.classList.remove('sorted'));
    th.classList.add('sorted');
    th.querySelector('.sort-icon').textContent = sortAsc ? '↑' : '↓';
    renderResults();
  });
});

// ---- Filter ----
$('filter-input').addEventListener('input', renderResults);
$('exact-only').addEventListener('change', e => { exactOnly = e.target.checked; renderResults(); });

// ---- Threshold slider (results page) ----
let rematchTimeout = null;

$('threshold').addEventListener('input', () => {
  $('threshold-val').textContent = $('threshold').value;
  clearTimeout(rematchTimeout);
  rematchTimeout = setTimeout(async () => {
    const threshold = parseInt($('threshold').value, 10);
    try {
      const res = await fetch('/api/rematch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold }),
      });
      if (res.ok) await loadResults();
    } catch (err) {
      console.error('rematch failed:', err);
    }
  }, 300);
});

// ---- Start scan ----
$('btn-scan').addEventListener('click', async () => {
  if (selectedDirs.size === 0) return;
  localStorage.removeItem('hashStartTime');

  const ignoreRaw = $('ignore-patterns').value;
  const ignoreRegexes = ignoreRaw.split('\n').map(s => s.trim()).filter(Boolean);
  const threshold = parseInt($('threshold').value, 10);

  const res = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dirs: [...selectedDirs],
      ignoreRegexes,
      threshold,
    }),
  });

  if (res.status === 202) {
    startProgress();
  } else {
    const text = await res.text();
    alert('Scan error: ' + text);
  }
});

// ---- New scan (results view + progress abort button) ----
async function goToSetup() {
  if (ws) {
    ws.onclose = null; // suppress reconnect logic
    ws.close();
    ws = null;
  }
  selectedDirs.clear();
  clearSelection();
  $('btn-scan').disabled = true;
  showView('setup');
  await loadTree('', $('folder-tree'));
}

$('btn-go-scan').addEventListener('click', () => {
  if (ws) showView('progress');
  else goToSetup();
});
$('btn-go-results').addEventListener('click', () => showView('results'));
document.querySelector('header h1').addEventListener('click', () => showView('results'));
$('btn-abort').addEventListener('click', async () => {
  try { await fetch('/api/cancel', { method: 'POST' }); } catch (_) {}
  goToSetup();
});

// ---- Accepted View ----

const acceptedPreview = document.createElement('div');
acceptedPreview.className = 'bin-preview';
const acceptedPreviewImg = document.createElement('img');
acceptedPreview.appendChild(acceptedPreviewImg);
document.body.appendChild(acceptedPreview);

document.addEventListener('mousemove', e => {
  if (!acceptedPreview.classList.contains('visible')) return;
  let x = e.clientX + 16;
  let y = e.clientY - 16;
  if (x + 296 > window.innerWidth)  x = e.clientX - 312;
  if (y + 296 > window.innerHeight) y = window.innerHeight - 300;
  if (y < 8) y = 8;
  acceptedPreview.style.left = x + 'px';
  acceptedPreview.style.top  = y + 'px';
});

function updateAcceptedActionBar() {
  const n = selectedAcceptedPaths.size;
  $('accepted-sel-count').textContent = n > 0
    ? n + ' item' + (n === 1 ? '' : 's') + ' selected'
    : 'No items selected';
  $('btn-unaccept').disabled = n === 0;
}

function clearAcceptedSelection() {
  selectedAcceptedPaths.clear();
  $('accepted-tree').querySelectorAll('.ac-check, .dir-cb').forEach(cb => { cb.checked = false; cb.indeterminate = false; });
  updateAcceptedActionBar();
}

function renderAcceptedFileRow(item, depth) {
  const row = document.createElement('div');
  row.className = 'bin-file-row' + (item.missing ? ' af-missing' : '');
  row.style.paddingLeft = (depth * 1.2 + 0.4) + 'rem';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'ac-check';
  cb.dataset.path = item.path;
  cb.addEventListener('change', e => {
    e.stopPropagation();
    if (e.target.checked) selectedAcceptedPaths.add(item.path);
    else selectedAcceptedPaths.delete(item.path);
    updateAcceptedActionBar();
    updateAncestorDirCheckboxes(cb);
  });

  const nameEl = document.createElement('span');
  nameEl.className = 'bf-name';
  nameEl.textContent = item.name;
  nameEl.title = item.path;
  if (!item.missing) nameEl.addEventListener('click', () => {
    const navigable = acceptedItems.filter(i => !i.missing);
    const idx = navigable.findIndex(i => i.path === item.path);
    openModal(item.path, navigable, idx,
      (p, checked) => {
        if (checked) selectedAcceptedPaths.add(p); else selectedAcceptedPaths.delete(p);
        const mainCb = [...document.querySelectorAll('.ac-check')].find(c => c.dataset.path === p);
        if (mainCb) { mainCb.checked = checked; updateAncestorDirCheckboxes(mainCb); }
        updateAcceptedActionBar();
      },
      p => selectedAcceptedPaths.has(p)
    );
  });

  const sizeEl = document.createElement('span');
  sizeEl.className = 'bf-size';
  sizeEl.textContent = item.missing ? 'missing' : fmt(item.size);

  const dateEl = document.createElement('span');
  dateEl.className = 'bf-date';
  dateEl.textContent = item.missing ? '' : fmtDate(item.modTime);

  const revertBtn = document.createElement('button');
  revertBtn.className = 'bf-restore';
  revertBtn.textContent = 'Revert';
  revertBtn.addEventListener('click', async e => {
    e.stopPropagation();
    await doUnaccept([item.path]);
  });

  row.append(cb, nameEl, sizeEl, dateEl, revertBtn);

  if (!item.missing && !isVideo(item.path) && window.matchMedia('(hover: hover)').matches) {
    row.addEventListener('mouseenter', () => {
      acceptedPreviewImg.src = '/api/image?path=' + encodeURIComponent(item.path);
      acceptedPreview.classList.add('visible');
    });
    row.addEventListener('mouseleave', () => {
      acceptedPreview.classList.remove('visible');
      acceptedPreviewImg.src = '';
    });
  }

  return row;
}

function renderAccepted() {
  const treeEl = $('accepted-tree');
  treeEl.innerHTML = '';
  $('accepted-loading').style.display = 'none';
  $('accepted-stats').textContent = acceptedItems.length + ' item' + (acceptedItems.length === 1 ? '' : 's');

  if (acceptedItems.length === 0) {
    $('accepted-empty').style.display = 'block';
    return;
  }
  $('accepted-empty').style.display = 'none';
  treeEl.appendChild(renderTreeNode(buildTree(acceptedItems), 0, renderAcceptedFileRow, cascadeAccepted));
}

async function doUnaccept(paths) {
  const names = paths.map(p => basename(p));
  const confirmed = await showConfirm(
    'Revert ' + paths.length + ' item' + (paths.length === 1 ? '' : 's') + '?',
    'These files will appear in scan results again.',
    names
  );
  if (!confirmed) return;

  try {
    const res = await fetch('/api/unaccept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) {
      alert('Revert failed: ' + await res.text());
      return;
    }
    const reverted = new Set(paths);
    acceptedItems = acceptedItems.filter(item => !reverted.has(item.path));
    selectedAcceptedPaths = new Set([...selectedAcceptedPaths].filter(p => !reverted.has(p)));
    renderAccepted();
    updateAcceptedActionBar();
  } catch (err) {
    alert('Request failed: ' + err.message);
  }
}

async function openAcceptedView() {
  showView('accepted');
  $('accepted-loading').style.display = 'block';
  $('accepted-empty').style.display = 'none';
  $('accepted-tree').innerHTML = '';
  clearAcceptedSelection();

  try {
    const res = await fetch('/api/accepted');
    acceptedItems = res.ok ? (await res.json() || []) : [];
  } catch (_) {
    acceptedItems = [];
  }
  renderAccepted();
}

$('btn-open-accepted').addEventListener('click', openAcceptedView);

$('btn-accepted-clear-sel').addEventListener('click', clearAcceptedSelection);

$('btn-unaccept').addEventListener('click', async () => {
  if (selectedAcceptedPaths.size === 0) return;
  await doUnaccept([...selectedAcceptedPaths]);
});

// ---- Helpers ----
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ---- Recycle Bin View ----

// Hover preview overlay — created once, positioned on mousemove.
const binPreview = document.createElement('div');
binPreview.className = 'bin-preview';
const binPreviewImg = document.createElement('img');
binPreview.appendChild(binPreviewImg);
document.body.appendChild(binPreview);

document.addEventListener('mousemove', e => {
  if (!binPreview.classList.contains('visible')) return;
  let x = e.clientX + 16;
  let y = e.clientY - 16;
  if (x + 296 > window.innerWidth)  x = e.clientX - 312;
  if (y + 296 > window.innerHeight) y = window.innerHeight - 300;
  if (y < 8) y = 8;
  binPreview.style.left = x + 'px';
  binPreview.style.top  = y + 'px';
});

function updateBinActionBar() {
  const n = selectedBinPaths.size;
  $('bin-sel-count').textContent = n > 0
    ? n + ' item' + (n === 1 ? '' : 's') + ' selected'
    : 'No items selected';
  $('btn-restore').disabled = n === 0;
}

function clearBinSelection() {
  selectedBinPaths.clear();
  $('bin-tree').querySelectorAll('.bc-check, .dir-cb').forEach(cb => { cb.checked = false; cb.indeterminate = false; });
  updateBinActionBar();
}

// Build a nested tree from flat items using their relPath.
function buildTree(items) {
  const root = { children: {}, files: [] };
  for (const item of items) {
    const parts = item.relPath.split('/');
    parts.pop(); // filename is already in item.name
    let node = root;
    for (const part of parts) {
      if (!node.children[part]) {
        node.children[part] = { name: part, children: {}, files: [] };
      }
      node = node.children[part];
    }
    node.files.push(item);
  }
  return root;
}

// Render a tree node recursively. renderFileFn(item, depth) produces each file row.
// onCascade(body, checked) is called when a dir checkbox changes.
function renderTreeNode(node, depth, renderFileFn, onCascade) {
  const frag = document.createDocumentFragment();
  const indent = depth * 1.2;

  for (const [name, child] of Object.entries(node.children).sort((a, b) => a[0].localeCompare(b[0]))) {
    const wrap = document.createElement('div');
    wrap.className = 'bin-dir';

    const hd = document.createElement('div');
    hd.className = 'bin-dir-hd';
    hd.style.paddingLeft = indent + 'rem';

    const exp = document.createElement('span');
    exp.className = 'expander';
    exp.textContent = '▼';

    const dirCb = document.createElement('input');
    dirCb.type = 'checkbox';
    dirCb.className = 'dir-cb';
    dirCb.dataset.name = name;
    let _preInd = false;
    dirCb.addEventListener('mousedown', () => { _preInd = dirCb.indeterminate; });
    dirCb.addEventListener('keydown', e => { if (e.key === ' ') _preInd = dirCb.indeterminate; });
    dirCb.addEventListener('click', e => e.stopPropagation());
    dirCb.addEventListener('change', () => {
      if (_preInd) dirCb.checked = false;
      dirCb.indeterminate = false;
      onCascade(body, dirCb.checked);
      updateAncestorDirCheckboxes(body);
    });

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '📁';

    const label = document.createElement('span');
    label.textContent = name;

    hd.append(exp, dirCb, icon, label);

    const body = document.createElement('div');
    body.className = 'bin-dir-body';
    body.appendChild(renderTreeNode(child, depth + 1, renderFileFn, onCascade));

    hd.addEventListener('click', () => {
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? '' : 'none';
      exp.textContent = collapsed ? '▼' : '▶';
    });

    wrap.append(hd, body);
    frag.appendChild(wrap);
  }

  for (const item of node.files) {
    frag.appendChild(renderFileFn(item, depth));
  }

  return frag;
}

function cascadeBin(body, checked) {
  body.querySelectorAll('.bc-check').forEach(cb => {
    cb.checked = checked;
    if (checked) selectedBinPaths.add(cb.dataset.path);
    else selectedBinPaths.delete(cb.dataset.path);
  });
  body.querySelectorAll('.dir-cb').forEach(cb => { cb.checked = checked; cb.indeterminate = false; });
  updateBinActionBar();
  updateAncestorDirCheckboxes(body);
}

function cascadeAccepted(body, checked) {
  body.querySelectorAll('.ac-check').forEach(cb => {
    cb.checked = checked;
    if (checked) selectedAcceptedPaths.add(cb.dataset.path);
    else selectedAcceptedPaths.delete(cb.dataset.path);
  });
  body.querySelectorAll('.dir-cb').forEach(cb => { cb.checked = checked; cb.indeterminate = false; });
  updateAcceptedActionBar();
  updateAncestorDirCheckboxes(body);
}

function renderBinFileRow(item, depth) {
  const row = document.createElement('div');
  row.className = 'bin-file-row';
  row.style.paddingLeft = (depth * 1.2 + 0.4) + 'rem';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'bc-check';
  cb.dataset.path = item.path;
  cb.addEventListener('change', e => {
    e.stopPropagation();
    if (e.target.checked) selectedBinPaths.add(item.path);
    else selectedBinPaths.delete(item.path);
    updateBinActionBar();
    updateAncestorDirCheckboxes(cb);
  });

  const nameEl = document.createElement('span');
  nameEl.className = 'bf-name';
  nameEl.textContent = item.name;
  nameEl.title = item.path;
  nameEl.addEventListener('click', () => {
    const idx = binItems.findIndex(i => i.path === item.path);
    openModal(item.path, binItems, idx,
      (p, checked) => {
        if (checked) selectedBinPaths.add(p); else selectedBinPaths.delete(p);
        const mainCb = [...document.querySelectorAll('.bc-check')].find(c => c.dataset.path === p);
        if (mainCb) { mainCb.checked = checked; updateAncestorDirCheckboxes(mainCb); }
        updateBinActionBar();
      },
      p => selectedBinPaths.has(p)
    );
  });

  const sizeEl = document.createElement('span');
  sizeEl.className = 'bf-size';
  sizeEl.textContent = fmt(item.size);

  const dateEl = document.createElement('span');
  dateEl.className = 'bf-date';
  dateEl.textContent = fmtDate(item.modTime);

  const restoreBtn = document.createElement('button');
  restoreBtn.className = 'bf-restore';
  restoreBtn.textContent = 'Restore';
  restoreBtn.addEventListener('click', async e => {
    e.stopPropagation();
    await doRestore([item.path]);
  });

  row.append(cb, nameEl, sizeEl, dateEl, restoreBtn);

  if (!isVideo(item.path) && window.matchMedia('(hover: hover)').matches) {
    row.addEventListener('mouseenter', () => {
      binPreviewImg.src = '/api/image?path=' + encodeURIComponent(item.path);
      binPreview.classList.add('visible');
    });
    row.addEventListener('mouseleave', () => {
      binPreview.classList.remove('visible');
      binPreviewImg.src = '';
    });
  }

  return row;
}

function renderBin() {
  const treeEl = $('bin-tree');
  treeEl.innerHTML = '';
  $('bin-loading').style.display = 'none';
  $('bin-stats').textContent = binItems.length + ' item' + (binItems.length === 1 ? '' : 's');

  if (binItems.length === 0) {
    $('bin-empty').style.display = 'block';
    return;
  }
  $('bin-empty').style.display = 'none';
  treeEl.appendChild(renderTreeNode(buildTree(binItems), 0, renderBinFileRow, cascadeBin));
}

async function doRestore(paths) {
  const names = paths.map(p => basename(p));
  const confirmed = await showConfirm(
    'Restore ' + paths.length + ' item' + (paths.length === 1 ? '' : 's') + '?',
    'The file' + (paths.length === 1 ? '' : 's') + ' will be moved back to ' + (paths.length === 1 ? 'its' : 'their') + ' original location.',
    names
  );
  if (!confirmed) return;

  try {
    const res = await fetch('/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) {
      alert('Restore failed: ' + await res.text());
      return;
    }
    const data = await res.json();
    if (data.failed && data.failed.length > 0) {
      alert('Some files could not be restored:\n' +
        data.failed.map(f => basename(f.path) + ': ' + f.error).join('\n'));
    }
    const restoredSet = new Set(data.restored || []);
    binItems = binItems.filter(item => !restoredSet.has(item.path));
    selectedBinPaths = new Set([...selectedBinPaths].filter(p => !restoredSet.has(p)));
    renderBin();
    updateBinActionBar();
  } catch (err) {
    alert('Request failed: ' + err.message);
  }
}

async function openBinView() {
  showView('bin');
  $('bin-loading').style.display = 'block';
  $('bin-empty').style.display = 'none';
  $('bin-tree').innerHTML = '';
  clearBinSelection();

  try {
    const res = await fetch('/api/bin');
    binItems = res.ok ? (await res.json() || []) : [];
  } catch (_) {
    binItems = [];
  }
  renderBin();
}

$('btn-open-bin').addEventListener('click', openBinView);

$('btn-bin-clear-sel').addEventListener('click', clearBinSelection);

$('btn-restore').addEventListener('click', async () => {
  if (selectedBinPaths.size === 0) return;
  await doRestore([...selectedBinPaths]);
});

// ---- Init ----
(async () => {
  // Load version badge.
  try {
    const res = await fetch('/api/version');
    if (res.ok) {
      const { version } = await res.json();
      $('version-badge').textContent = 'v' + version;
    }
  } catch (_) {}

  // Load app config.
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const cfg = await res.json();
      recycleBinEnabled = cfg.recycleBinEnabled;
      if (recycleBinEnabled) {
        $('opt-trash').style.display = '';
        $('btn-open-bin').style.display = '';
      }
    }
  } catch (_) {}

  try {
    const res = await fetch('/api/status');
    const status = await res.json();

    if (status.phase === 'scanning' || status.phase === 'matching' || status.phase === 'walking') {
      startProgress();
      return;
    }
    if (status.phase === 'done') {
      await loadResults();
      return;
    }
  } catch (err) {
    console.error('init status check failed:', err);
  }

  // Default: show results page (empty state until first scan)
  showView('results');
  renderResults();
})();
