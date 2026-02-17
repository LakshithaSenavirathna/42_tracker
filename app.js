/* ═══════════════════════════════════════════════
   42-DAY MASTER TRACKER — app.js
   - PIN lock (sync only after unlock)
   - Task ticking per day
   - Notes per day
   - Google Sheets sync
   ═══════════════════════════════════════════════ */

// ── PIN LOCK ─────────────────────────────────────
const CORRECT_PIN = '1122';
const SESSION_KEY = 'tracker42_unlocked';
let pinBuffer = '';

function setupLock() {
  // Already unlocked this session → go straight to app
  if (sessionStorage.getItem(SESSION_KEY) === 'yes') {
    unlock(false);
    bootTracker(); // sync happens here, after unlock confirmed
    return;
  }

  // Wire up numpad
  document.querySelectorAll('.num-btn[data-n]').forEach(btn => {
    btn.addEventListener('click', () => pressDigit(btn.dataset.n));
  });
  document.getElementById('clearPin').addEventListener('click', backspacePin);
  document.getElementById('enterPin').addEventListener('click', submitPin);

  // Keyboard support (only active while lock screen is visible)
  document.addEventListener('keydown', e => {
    if (document.getElementById('lockScreen').classList.contains('hidden')) return;
    if (e.key >= '0' && e.key <= '9') pressDigit(e.key);
    else if (e.key === 'Backspace') backspacePin();
    else if (e.key === 'Enter')     submitPin();
  });

  // Lock button inside the app
  document.getElementById('lockBtn').addEventListener('click', lockApp);
}

function pressDigit(d) {
  if (pinBuffer.length >= 4) return;
  pinBuffer += d;
  updateDots();
  if (pinBuffer.length === 4) setTimeout(submitPin, 120);
}

function backspacePin() {
  pinBuffer = pinBuffer.slice(0, -1);
  updateDots();
  clearPinError();
}

function updateDots() {
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById('dot' + i);
    dot.classList.toggle('filled', i < pinBuffer.length);
    dot.classList.remove('error');
  }
}

function submitPin() {
  if (pinBuffer === CORRECT_PIN) {
    sessionStorage.setItem(SESSION_KEY, 'yes');
    unlock(true);
    bootTracker(); // ← sync starts HERE, only after correct PIN
  } else {
    const box = document.querySelector('.lock-box');
    box.classList.remove('shake');
    void box.offsetWidth;
    box.classList.add('shake');
    for (let i = 0; i < 4; i++) {
      document.getElementById('dot' + i).classList.add('error');
    }
    document.getElementById('pinError').textContent = 'Incorrect PIN — try again';
    setTimeout(() => { pinBuffer = ''; updateDots(); clearPinError(); }, 900);
  }
}

function clearPinError() {
  document.getElementById('pinError').textContent = '';
}

function unlock(animate) {
  document.getElementById('lockScreen').classList.add('hidden');
  const app = document.getElementById('mainApp');
  app.classList.remove('locked');
  app.classList.add('unlocked');
}

function lockApp() {
  sessionStorage.removeItem(SESSION_KEY);
  pinBuffer = '';
  updateDots();
  clearPinError();
  document.getElementById('lockScreen').classList.remove('hidden');
  const app = document.getElementById('mainApp');
  app.classList.add('locked');
  app.classList.remove('unlocked');
}

// ── GOOGLE SHEETS CONFIG ─────────────────────────
const SHEET_URL = 'https://script.google.com/macros/s/AKfycby6Hk_tHEifuaYcA_-dcybjCisMBKi_0bg3rritM__02UGvkKtloIjk6cDrsR16J8F4nA/exec';

// ── APP CONFIG ───────────────────────────────────
const START_DATE = new Date(2025, 1, 18); // Feb 18 2025
const TOTAL_DAYS = 42;                    // Feb 18 → Mar 31 2025 inclusive

const TASKS = [
  { id: 'pushup',   name: '50 Pushups',            sub: 'Daily non-negotiable',        color: '#00ff88', emoji: '💪' },
  { id: 'journal',  name: 'Journaling',             sub: 'Reflect & plan',              color: '#ff6b35', emoji: '📓' },
  { id: 'english',  name: 'English (FreeCodeCamp)', sub: 'A2→B2 track',                 color: '#4d9fff', emoji: '🌍' },
  { id: 'linkedin', name: 'LinkedIn Post',          sub: 'GeoAI forecasting, 3h study', color: '#c77dff', emoji: '📡' },
  { id: 'thesis',   name: 'Thesis / Research',      sub: 'Writing or analysis',         color: '#ffd166', emoji: '📖' },
  { id: 'ml',       name: 'ML / DL / PyTorch',      sub: 'Coursera + practice',         color: '#ff4d8d', emoji: '🤖' },
  { id: 'ts',       name: 'Time Series',            sub: 'R + Python + models',         color: '#00e5ff', emoji: '📈' },
];

// ── STATE ─────────────────────────────────────────
// DATA shape: { "day1": { tasks: [...], note: "..." }, ... }
let DATA         = {};
let openDayIdx   = null;
let activeTab    = 'tasks';
let barChartInst = null;
let donutInst    = null;

// ── SYNC STATUS UI ────────────────────────────────
function setSyncStatus(state, msg) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const icons = { idle: '☁️', loading: '⏳', saving: '💾', ok: '✅', error: '❌' };
  el.textContent = `${icons[state] || '☁️'} ${msg}`;
  el.className   = 'sync-status sync-' + state;
}

// ── GOOGLE SHEETS — LOAD ALL ──────────────────────
async function loadFromSheets() {
  setSyncStatus('loading', 'Loading from Google Sheets…');
  try {
    const res  = await fetch(SHEET_URL);
    const json = await res.json();
    if (json.ok) {
      // Migrate: server may return old format {tasks:[]} or new {tasks:[], note:""}
      const raw = json.data || {};
      DATA = {};
      Object.keys(raw).forEach(k => {
        const v = raw[k];
        if (Array.isArray(v)) {
          DATA[k] = { tasks: v, note: '' };
        } else {
          DATA[k] = { tasks: v.tasks || [], note: v.note || '' };
        }
      });
      saveLocal();
      setSyncStatus('ok', 'Synced with Google Sheets');
    } else {
      throw new Error(json.error || 'Unknown error');
    }
  } catch (err) {
    console.warn('Sheets load failed, using localStorage:', err);
    DATA = loadLocal();
    setSyncStatus('error', 'Offline — using local data');
  }
}

// ── GOOGLE SHEETS — SAVE ONE DAY ─────────────────
async function saveDayToSheets(dayIdx) {
  const key  = dayKey(dayIdx);
  const payload = { day: key, tasks: getDayTasks(dayIdx), note: getDayNote(dayIdx) };
  setSyncStatus('saving', 'Saving…');
  try {
    const res  = await fetch(SHEET_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body:    JSON.stringify(payload),
    });
    const json = await res.json();
    if (json.ok) {
      setSyncStatus('ok', 'Saved to Google Sheets ✓');
    } else {
      throw new Error(json.error || 'Save failed');
    }
  } catch (err) {
    console.warn('Sheets save failed:', err);
    setSyncStatus('error', 'Save failed — kept locally');
  }
  saveLocal();
}

// ── LOCAL STORAGE ─────────────────────────────────
function saveLocal() {
  try { localStorage.setItem('tracker42', JSON.stringify(DATA)); } catch (e) {}
}

function loadLocal() {
  try {
    const raw = localStorage.getItem('tracker42');
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Migrate old flat format
    const out = {};
    Object.keys(parsed).forEach(k => {
      const v = parsed[k];
      if (Array.isArray(v)) out[k] = { tasks: v, note: '' };
      else                   out[k] = { tasks: v.tasks || [], note: v.note || '' };
    });
    return out;
  } catch (e) { return {}; }
}

// ── HELPERS ───────────────────────────────────────
function dayKey(i)       { return 'day' + (i + 1); }
function ensureDay(i)    { if (!DATA[dayKey(i)]) DATA[dayKey(i)] = { tasks: [], note: '' }; }
function getDayTasks(i)  { return DATA[dayKey(i)]?.tasks || []; }
function getDayNote(i)   { return DATA[dayKey(i)]?.note  || ''; }

function toggleTask(dayIdx, taskId) {
  ensureDay(dayIdx);
  const arr = DATA[dayKey(dayIdx)].tasks;
  const pos = arr.indexOf(taskId);
  if (pos >= 0) arr.splice(pos, 1);
  else arr.push(taskId);
  saveDayToSheets(dayIdx);
}

function clearDayData(dayIdx) {
  ensureDay(dayIdx);
  DATA[dayKey(dayIdx)].tasks = [];
  saveDayToSheets(dayIdx);
}

function saveNote(dayIdx, text) {
  ensureDay(dayIdx);
  DATA[dayKey(dayIdx)].note = text.trim();
  saveDayToSheets(dayIdx);
}

function getDate(dayIdx) {
  const d = new Date(START_DATE);
  d.setDate(d.getDate() + dayIdx);
  return d;
}

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── TOAST NOTIFICATION ────────────────────────────
function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 3000);
}

function refreshAll() {
  buildGrid();
  buildStats();
  buildBarChart();
  buildDonut();
  buildHeatmap();
  buildStreakBars();
}

// ── LEGEND ────────────────────────────────────────
function buildLegend() {
  const el = document.getElementById('legend');
  el.innerHTML = '';
  TASKS.forEach(t => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `
      <div class="legend-dot" style="background:${t.color}"></div>
      <span style="font-size:13px;font-weight:600;">${t.emoji} ${t.name}</span>
    `;
    el.appendChild(item);
  });
}

// ── 42-DAY GRID ───────────────────────────────────
function buildGrid() {
  const grid = document.getElementById('dayGrid');
  grid.innerHTML = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < TOTAL_DAYS; i++) {
    const d = getDate(i);
    d.setHours(0, 0, 0, 0);

    const done      = getDayTasks(i);
    const hasNote   = getDayNote(i).length > 0;
    const pct       = done.length / TASKS.length;
    const isFull    = pct === 1;
    const isPartial = pct > 0 && pct < 1;
    const isToday   = d.getTime() === today.getTime();

    const cell = document.createElement('div');
    cell.className = ['day-cell',
      isFull    ? 'full-day'    : '',
      isPartial ? 'partial-day' : '',
      isToday   ? 'today'       : '',
    ].join(' ').trim();

    // Yellow dot if note exists
    if (hasNote) {
      const noteDot = document.createElement('div');
      noteDot.className = 'note-indicator';
      noteDot.title = 'Has note';
      cell.appendChild(noteDot);
    }

    const num = document.createElement('div');
    num.className   = 'day-num';
    num.textContent = i + 1;

    const dateEl = document.createElement('div');
    dateEl.className   = 'day-date';
    dateEl.textContent = fmtDate(d);

    const dots = document.createElement('div');
    dots.className = 'task-dots';
    TASKS.forEach(t => {
      const dot    = document.createElement('div');
      const active = done.includes(t.id);
      dot.className         = 'tdot' + (active ? ' active' : '');
      dot.style.background  = active ? t.color : 'transparent';
      dot.style.borderColor = active ? t.color : '#2a2a3a';
      dots.appendChild(dot);
    });

    cell.appendChild(num);
    cell.appendChild(dateEl);
    cell.appendChild(dots);
    cell.addEventListener('click', () => openModal(i));
    grid.appendChild(cell);
  }

  updateGridProgress();
}

function updateGridProgress() {
  let complete = 0;
  for (let i = 0; i < TOTAL_DAYS; i++) {
    if (getDayTasks(i).length === TASKS.length) complete++;
  }
  document.getElementById('gridProgressText').textContent =
    `${complete} / ${TOTAL_DAYS} days complete`;
}

// ── MODAL ─────────────────────────────────────────
function openModal(dayIdx) {
  openDayIdx = dayIdx;
  const d = getDate(dayIdx);
  document.getElementById('modalTitle').textContent =
    `Day ${dayIdx + 1} · ${fmtDate(d)}`;

  switchTab('tasks');
  renderTaskList();
  loadNoteIntoEditor(dayIdx);
  document.getElementById('taskModal').classList.add('open');
}

function closeModal() {
  // Auto-save note when closing if there's unsaved content
  const textarea = document.getElementById('dayNotes');
  if (openDayIdx !== null && textarea) {
    const current = textarea.value;
    if (current !== getDayNote(openDayIdx)) {
      saveNote(openDayIdx, current);
      refreshAll();
    }
  }
  document.getElementById('taskModal').classList.remove('open');
  openDayIdx = null;
}

// ── TABS ──────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.modal-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.getElementById('paneTasks').classList.toggle('hidden', tab !== 'tasks');
  document.getElementById('paneNotes').classList.toggle('hidden', tab !== 'notes');
}

// ── TASK LIST ─────────────────────────────────────
function renderTaskList() {
  const list = document.getElementById('taskList');
  list.innerHTML = '';
  const done = getDayTasks(openDayIdx);

  TASKS.forEach(t => {
    const isDone = done.includes(t.id);
    const row    = document.createElement('div');
    row.className = 'task-row' + (isDone ? ' done' : '');
    row.innerHTML = `
      <div class="task-check"
           style="${isDone ? `background:${t.color};border-color:${t.color};` : ''}">
        ${isDone ? '✓' : ''}
      </div>
      <div>
        <div class="task-row-name">${t.emoji} ${t.name}</div>
        <div class="task-row-sub">${t.sub}</div>
      </div>
    `;
    row.addEventListener('click', () => {
      toggleTask(openDayIdx, t.id);
      renderTaskList();
      refreshAll();
    });
    list.appendChild(row);
  });
}

// ── NOTES ─────────────────────────────────────────
function loadNoteIntoEditor(dayIdx) {
  const textarea = document.getElementById('dayNotes');
  const text = getDayNote(dayIdx);
  textarea.value = text;
  updateCharCount(text);
  // Reset save button state
  const btn = document.getElementById('saveNotesBtn');
  btn.textContent = '💾 Save Note';
  btn.classList.remove('saved');
}

function updateCharCount(text) {
  document.getElementById('notesChars').textContent =
    text.length + ' char' + (text.length !== 1 ? 's' : '');
}

function handleSaveNote() {
  if (openDayIdx === null) return;
  const text = document.getElementById('dayNotes').value;
  saveNote(openDayIdx, text);
  refreshAll();
  // Visual feedback
  const btn = document.getElementById('saveNotesBtn');
  btn.textContent = '✅ Saved!';
  btn.classList.add('saved');
  setTimeout(() => {
    btn.textContent = '💾 Save Note';
    btn.classList.remove('saved');
  }, 2000);
}

// ── CLEAR DAY ─────────────────────────────────────
function handleClearDay() {
  if (openDayIdx === null) return;
  const label = `Day ${openDayIdx + 1} (${fmtDate(getDate(openDayIdx))})`;
  if (!window.confirm(`Clear all tasks for ${label}?\n(Notes will be kept)`)) return;
  clearDayData(openDayIdx);
  renderTaskList();
  refreshAll();
}

// ── SUMMARY STATS ─────────────────────────────────
function buildStats() {
  let pushups = 0, journal = 0, linkedin = 0, totalTasks = 0;
  const totalPossible = TOTAL_DAYS * TASKS.length;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < TOTAL_DAYS; i++) {
    const done = getDayTasks(i);
    if (done.includes('pushup'))   pushups  += 50;
    if (done.includes('journal'))  journal++;
    if (done.includes('linkedin')) linkedin++;
    totalTasks += done.length;
  }

  let streak = 0;
  for (let i = TOTAL_DAYS - 1; i >= 0; i--) {
    const d = getDate(i);
    d.setHours(0, 0, 0, 0);
    if (d > today) continue;
    if (getDayTasks(i).length === TASKS.length) streak++;
    else break;
  }

  document.getElementById('s-pushups').textContent  = pushups.toLocaleString();
  document.getElementById('s-journal').textContent  = journal;
  document.getElementById('s-linkedin').textContent = linkedin;
  document.getElementById('s-streak').textContent   = streak + ' 🔥';
  const pct = Math.round((totalTasks / totalPossible) * 100);
  document.getElementById('s-pct').textContent = pct + '%';
}

// ── BAR CHART ─────────────────────────────────────
function buildBarChart() {
  const labels = [], values = [], colors = [];
  for (let i = 0; i < TOTAL_DAYS; i++) {
    labels.push('D' + (i + 1));
    const n = getDayTasks(i).length;
    values.push(n);
    colors.push(n === TASKS.length ? '#00ff88' : n > 0 ? '#ffd166' : '#22223a');
  }
  const ctx = document.getElementById('barChart').getContext('2d');
  if (barChartInst) barChartInst.destroy();
  barChartInst = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 2, borderSkipped: false }] },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${c.raw} / ${TASKS.length} tasks` } },
      },
      scales: {
        x: { ticks: { color: '#52526a', font: { size: 8, family: 'IBM Plex Mono' }, maxTicksLimit: 14 }, grid: { color: '#22223a' } },
        y: { ticks: { color: '#52526a', font: { size: 9 }, stepSize: 1 }, grid: { color: '#22223a' }, max: TASKS.length, min: 0 },
      },
    },
  });
}

// ── DONUT CHART ───────────────────────────────────
function buildDonut() {
  const counts = {};
  TASKS.forEach(t => (counts[t.id] = 0));
  for (let i = 0; i < TOTAL_DAYS; i++) {
    getDayTasks(i).forEach(id => { if (counts[id] !== undefined) counts[id]++; });
  }
  const ctx = document.getElementById('donutChart').getContext('2d');
  if (donutInst) donutInst.destroy();
  donutInst = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels:   TASKS.map(t => t.emoji + ' ' + t.name),
      datasets: [{ data: TASKS.map(t => counts[t.id]), backgroundColor: TASKS.map(t => t.color), borderWidth: 2, borderColor: '#13131e' }],
    },
    options: {
      responsive: false,
      cutout: '65%',
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: '#9090aa', font: { size: 10, family: 'IBM Plex Mono' }, padding: 8, boxWidth: 10 } },
        tooltip: { callbacks: { label: c => `${c.label}: ${c.raw} days` } },
      },
    },
  });
}

// ── HEATMAP ───────────────────────────────────────
function buildHeatmap() {
  const body = document.getElementById('heatmapBody');
  body.innerHTML = '';
  TASKS.forEach(t => {
    const row = document.createElement('div');
    row.className = 'heatmap-row';
    const lbl = document.createElement('div');
    lbl.className   = 'heatmap-label';
    lbl.textContent = t.emoji + ' ' + t.name.split(' ')[0];
    row.appendChild(lbl);
    for (let i = 0; i < TOTAL_DAYS; i++) {
      const done = getDayTasks(i).includes(t.id);
      const cell = document.createElement('div');
      cell.className        = 'hm-cell';
      cell.style.background = done ? t.color : 'rgba(255,255,255,0.03)';
      cell.style.opacity    = done ? '0.85' : '1';
      cell.dataset.tip      = `Day ${i + 1}: ${done ? '✓ Done' : '✗ Missed'}`;
      row.appendChild(cell);
    }
    body.appendChild(row);
  });
}

// ── STREAK BARS ───────────────────────────────────
function buildStreakBars() {
  const barsEl = document.getElementById('streakBars');
  const lblsEl = document.getElementById('streakLabels');
  barsEl.innerHTML = '';
  lblsEl.innerHTML = '';
  const max = TASKS.length;
  let bestStreak = 0, cur = 0;

  for (let i = 0; i < TOTAL_DAYS; i++) {
    const n   = getDayTasks(i).length;
    const pct = n / max;
    const bar = document.createElement('div');
    bar.className        = 'sbar';
    bar.style.height     = Math.max(2, Math.round(pct * 80)) + 'px';
    bar.style.background = pct === 1 ? 'var(--accent)' : pct > 0.5 ? 'var(--accent5)' : pct > 0 ? 'var(--accent2)' : 'var(--border)';
    bar.dataset.tip      = `Day ${i + 1}: ${n}/${max}`;
    barsEl.appendChild(bar);

    const lbl = document.createElement('div');
    lbl.className   = 'streak-lbl-item';
    lbl.textContent = (i % 7 === 0) ? `D${i + 1}` : '';
    lblsEl.appendChild(lbl);

    if (n === max) { cur++; bestStreak = Math.max(bestStreak, cur); }
    else cur = 0;
  }
  document.getElementById('streakLabel').textContent =
    `Best full-day streak: ${bestStreak} days`;
}

// ── EVENTS ────────────────────────────────────────
function attachEvents() {
  document.getElementById('closeModalBtn').addEventListener('click', closeModal);
  document.getElementById('taskModal').addEventListener('click', function (e) {
    if (e.target === this) closeModal();
  });
  document.getElementById('clearDayBtn').addEventListener('click', handleClearDay);
  document.getElementById('saveNotesBtn').addEventListener('click', handleSaveNote);

  // Tab switching
  document.querySelectorAll('.modal-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Live char count on textarea
  document.getElementById('dayNotes').addEventListener('input', e => {
    updateCharCount(e.target.value);
  });

  // Lock button
  document.getElementById('lockBtn').addEventListener('click', lockApp);
}

// ── BOOT TRACKER (runs only after unlock) ─────────
async function bootTracker() {
  attachEvents();
  buildLegend();

  // Show local cache first so UI isn't blank
  DATA = loadLocal();
  refreshAll();

  // Then fetch latest from Google Sheets
  await loadFromSheets();
  refreshAll();
}

// ── INIT — entry point ────────────────────────────
function init() {
  setupLock();
  // Note: bootTracker() is called inside setupLock() only
  // after the correct PIN is entered (or session is already valid).
  // No Sheets network calls happen before unlock.
}

window.addEventListener('load', init);
