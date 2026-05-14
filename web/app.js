'use strict';

// ---- State ----
let selectedDirs = new Set();
let allGroups = [];
let sortCol = 'size';
let sortAsc = false;
let expandedRow = null;

// ---- Utilities ----
const $ = id => document.getElementById(id);

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

// ---- View 1: Folder Tree ----
async function loadTree(path, container, depth = 0) {
  const res = await fetch('/api/browse?path=' + encodeURIComponent(path));
  if (!res.ok) return;
  const entries = await res.json();

  container.innerHTML = '';
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
    cb.addEventListener('change', () => {
      if (cb.checked) selectedDirs.add(e.path);
      else selectedDirs.delete(e.path);
      $('btn-scan').disabled = selectedDirs.size === 0;
    });

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '📁';

    const label = document.createElement('span');
    label.textContent = e.name;

    item.append(expander, cb, icon, label);

    const children = document.createElement('div');
    children.className = 'tree-children';
    children.style.display = 'none';
    let loaded = false;

    async function toggleExpand() {
      if (children.style.display === 'none') {
        if (!loaded) {
          expander.textContent = '⋯';
          await loadTree(e.path, children, 0);
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

// ---- View 2: Progress ----
let ws = null;

function startProgress() {
  showView('progress');

  const bar = $('progress-bar');
  const counter = $('counter');
  const phaseLabel = $('phase-label');

  bar.value = 0;
  bar.max = 100;
  counter.textContent = '';

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = e => {
    const p = JSON.parse(e.data);

    if (p.phase === 'scanning') {
      phaseLabel.textContent = 'Scanning files…';
      if (p.total > 0) {
        bar.value = p.scanned;
        bar.max = p.total;
        counter.textContent = p.scanned.toLocaleString() + ' / ' + p.total.toLocaleString() + ' files';
      }
    } else if (p.phase === 'matching') {
      phaseLabel.textContent = 'Finding duplicates…';
      bar.value = bar.max = 1;
      counter.textContent = p.total.toLocaleString() + ' files hashed';
    } else if (p.phase === 'done') {
      ws.close();
      loadResults();
    } else if (p.phase === 'error') {
      phaseLabel.textContent = 'Error: ' + (p.error || 'unknown');
      counter.textContent = '';
    }
  };

  ws.onerror = () => {
    phaseLabel.textContent = 'Connection error. Please reload.';
  };
}

// ---- View 3: Results ----
async function loadResults() {
  const res = await fetch('/api/results');
  if (!res.ok) { showView('setup'); return; }
  allGroups = await res.json() || [];
  renderResults();
  showView('results');
}

function groupTotalSize(g) {
  return g.files.reduce((s, f) => s + f.size, 0);
}

function groupWasted(g) {
  if (!g.files.length) return 0;
  const smallest = Math.min(...g.files.map(f => f.size));
  return groupTotalSize(g) - smallest;
}

function renderResults() {
  const filter = ($('filter-input').value || '').toLowerCase();

  let groups = allGroups.filter(g =>
    !filter || g.files.some(f => f.path.toLowerCase().includes(filter))
  );

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

  if (groups.length === 0) {
    $('no-results').style.display = 'block';
    return;
  }
  $('no-results').style.display = 'none';

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
    tr.addEventListener('click', () => toggleDetail(tr, g));
    tbody.appendChild(tr);
  });
}

function toggleDetail(tr, g) {
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

  g.files.forEach(f => {
    const card = document.createElement('div');
    card.className = 'file-card';

    const img = document.createElement('img');
    img.src = '/api/image?path=' + encodeURIComponent(f.path);
    img.alt = basename(f.path);
    img.loading = 'lazy';
    img.addEventListener('click', ev => {
      ev.stopPropagation();
      openModal(f.path);
    });

    const nameEl = document.createElement('div');
    nameEl.className = 'fc-name';
    nameEl.textContent = f.path;
    nameEl.title = f.path;

    const sizeEl = document.createElement('div');
    sizeEl.className = 'fc-size';
    sizeEl.textContent = fmt(f.size);

    card.append(img, nameEl, sizeEl);
    inner.appendChild(card);
  });

  td.appendChild(inner);
  detail.appendChild(td);
  tr.after(detail);
}

// tbody reference for toggleDetail
const tbody = document.getElementById('results-body');

// ---- Modal ----
function openModal(path) {
  $('modal-img').src = '/api/image?path=' + encodeURIComponent(path);
  $('modal').classList.add('open');
}

$('modal-close').addEventListener('click', () => $('modal').classList.remove('open'));
$('modal').addEventListener('click', e => {
  if (e.target === $('modal')) $('modal').classList.remove('open');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') $('modal').classList.remove('open');
});

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

// ---- Threshold slider ----
$('threshold').addEventListener('input', () => {
  $('threshold-val').textContent = $('threshold').value;
});

// ---- Start scan ----
$('btn-scan').addEventListener('click', async () => {
  if (selectedDirs.size === 0) return;

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

// ---- New scan ----
$('btn-new-scan').addEventListener('click', async () => {
  selectedDirs.clear();
  $('btn-scan').disabled = true;
  showView('setup');
  await loadTree('', $('folder-tree'));
});

// ---- Helpers ----
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ---- Init ----
(async () => {
  const res = await fetch('/api/status');
  const status = await res.json();

  // If a scan is already running or done, jump to the right view
  if (status.phase === 'scanning' || status.phase === 'matching') {
    startProgress();
    return;
  }
  if (status.phase === 'done') {
    await loadResults();
    return;
  }

  // Load folder tree for setup view
  await loadTree('', $('folder-tree'));
})();
