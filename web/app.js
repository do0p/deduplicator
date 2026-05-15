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

function dirname(path) {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.substring(0, i) : path;
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
      cb.addEventListener('change', () => {
        // Cascade checked state to all visible children in the tree.
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

    // If the parent is already checked, start this node checked too.
    if (parentCb && parentCb.checked) {
      cb.checked = true;
      selectedDirs.add(e.path);
      $('btn-scan').disabled = false;
    }

    const children = document.createElement('div');
    children.className = 'tree-children';
    children.style.display = 'none';

    cb.addEventListener('change', () => {
      if (cb.checked) selectedDirs.add(e.path);
      else selectedDirs.delete(e.path);
      // Cascade to all currently visible descendants.
      setSubtreeChecked(children, cb.checked);
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

// ---- View 2: Progress ----
let ws = null;

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return '~' + s + 's';
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return '~' + m + 'm ' + rem + 's';
  return '> 1h';
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
      title.textContent = 'Hashing images…';
      phaseLabel.textContent = 'Computing perceptual hashes…';
      if (p.total > 0) {
        bar.value = p.scanned;
        bar.max = p.total;

        if (p.scanned > 0 && !hashStartTime) hashStartTime = Date.now();

        let eta = '';
        if (hashStartTime && p.scanned > 0) {
          const elapsed = Date.now() - hashStartTime;
          // Only show ETA after 5 s of data to avoid wild early estimates.
          if (elapsed >= 5000) {
            const msPerFile = elapsed / p.scanned;
            const remaining = (p.total - p.scanned) * msPerFile;
            eta = ' · ' + fmtDuration(remaining) + ' remaining';
          }
        }

        counter.textContent = p.scanned.toLocaleString() + ' / ' + p.total.toLocaleString() + ' files' + eta;
      }
    } else if (p.phase === 'matching') {
      title.textContent = 'Matching duplicates…';
      phaseLabel.textContent = 'Comparing hashes…';
      bar.value = bar.max = 1;
      counter.textContent = p.total.toLocaleString() + ' files hashed';
    } else if (p.phase === 'done') {
      closedIntentionally = true;
      ws.close();
      loadResults();
    } else if (p.phase === 'cancelled') {
      closedIntentionally = true;
      ws.close();
      // goToSetup() will be called by the cancel button click handler.
    } else if (p.phase === 'error') {
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
    showView('setup');
  }
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

    card.append(img, nameEl, folderEl, sizeEl, modEl);
    inner.appendChild(card);
  });

  td.appendChild(inner);
  detail.appendChild(td);
  tr.after(detail);
}

// tbody reference for toggleDetail
const tbody = document.getElementById('results-body');

// ---- Modal ----
async function openModal(path) {
  $('modal-img').src = '/api/image?path=' + encodeURIComponent(path);
  $('modal-info').innerHTML = '<div class="mi-loading">Loading…</div>';
  $('modal').classList.add('open');

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

// ---- New scan (results view + progress abort button) ----
async function goToSetup() {
  if (ws) {
    ws.onclose = null; // suppress reconnect logic
    ws.close();
    ws = null;
  }
  selectedDirs.clear();
  $('btn-scan').disabled = true;
  showView('setup');
  await loadTree('', $('folder-tree'));
}

$('btn-new-scan').addEventListener('click', goToSetup);
$('btn-abort').addEventListener('click', async () => {
  try { await fetch('/api/cancel', { method: 'POST' }); } catch (_) {}
  goToSetup();
});

// ---- Helpers ----
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ---- Init ----
(async () => {
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

  // Default: load folder tree for setup view
  await loadTree('', $('folder-tree'));
})();
