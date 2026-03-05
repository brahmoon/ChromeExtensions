// FocusFlow popup.js - Main application logic
import {
  openDB, generateId,
  getProjects, getAllProjects, saveProject, deleteProject,
  getTasks, getTaskById, saveTask, deleteTask,
  getActivityByTask, addActivity, deleteActivitiesByTask,
  exportData, importData
} from './db.js';

// ============================================================
// CONSTANTS
// ============================================================

const STATUS_CONFIG = {
  Pending:    { label: 'Pending',    color: '#737d8c', desc: '未着手' },
  InProgress: { label: 'InProgress', color: '#5B8FE0', desc: '作業中' },
  Waiting:    { label: 'Waiting',    color: '#E8A838', desc: '他者・外部待ち' },
  Blocked:    { label: 'Blocked',    color: '#E05C5C', desc: '障害により停止' },
  Suspended:  { label: 'Suspended',  color: '#9B72E0', desc: '意図的に停止' },
  Skipped:    { label: 'Skipped',    color: '#4a5260', desc: '不要と判断' },
  Completed:  { label: 'Completed',  color: '#4CAF82', desc: '完了' }
};

const PROJECT_COLORS = [
  '#5B8FE0', '#E8A838', '#4CAF82', '#E05C5C',
  '#9B72E0', '#E07844', '#4ABFBF', '#B0B878'
];

// ============================================================
// STATE
// ============================================================

let state = {
  tasks: [],
  projects: [],
  currentView: 'today',
  currentProjectId: null,
  currentTaskId: null,
  editingProjectId: null,
  selectedProjectColor: PROJECT_COLORS[0],
};

// ============================================================
// INIT
// ============================================================

async function init() {
  await openDB();
  await loadData();
  setupEventListeners();
  renderAll();
  checkPendingTask();
  updateTodayDate();

  // Listen for context menu task added
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'PENDING_TASK_ADDED') {
      processPendingTask(msg.task);
    }
  });
}

async function loadData() {
  [state.tasks, state.projects] = await Promise.all([getTasks(), getProjects()]);
}

// ============================================================
// PENDING TASK (from context menu)
// ============================================================

async function checkPendingTask() {
  return new Promise(resolve => {
    chrome.storage.local.get(['pendingTask'], async (result) => {
      if (result.pendingTask) {
        await processPendingTask(result.pendingTask);
        chrome.storage.local.remove('pendingTask');
      }
      resolve();
    });
  });
}

async function processPendingTask(pending) {
  const task = createTask({
    title: pending.title,
    sourceUrl: pending.sourceUrl,
    sourceTitle: pending.sourceTitle,
    projectId: null
  });
  await saveTask(task);
  const entry = createActivity(task.id, 'created', null, null, 'Pending');
  if (pending.sourceUrl) {
    const urlEntry = createActivity(task.id, 'url_added', `URL登録: ${pending.sourceTitle || pending.sourceUrl}`);
    await addActivity(urlEntry);
  }
  await addActivity(entry);
  state.tasks.push(task);
  renderAll();
  showToast(`✚ Inboxに追加: ${task.title.slice(0, 30)}...`);
}

// ============================================================
// DATA FACTORIES
// ============================================================

function createTask(overrides = {}) {
  return {
    id: generateId(),
    projectId: null,
    title: '新しいタスク',
    status: 'Pending',
    priority: 'medium',
    dueDate: null,
    isTodayTask: false,
    sourceUrl: null,
    sourceTitle: null,
    tags: [],
    checklist: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function createActivity(taskId, type, text = null, fromStatus = null, toStatus = null) {
  return {
    id: generateId(),
    taskId,
    type,
    text,
    fromStatus,
    toStatus,
    createdAt: new Date().toISOString()
  };
}

// ============================================================
// RENDER ALL
// ============================================================

function renderAll() {
  updateBadge();
  renderTodayView();
  renderInboxView();
  renderProjectsView();
  updateInboxAlert();
  renderWeekHeatmap();
  updateStreakDisplay();
}

// ============================================================
// BADGE & STREAK
// ============================================================

function updateBadge() {
  const inboxCount = state.tasks.filter(t => !t.projectId && t.status !== 'Completed' && t.status !== 'Skipped').length;
  const inboxBadge = document.getElementById('inbox-badge');
  if (inboxCount > 0) {
    inboxBadge.textContent = inboxCount;
    inboxBadge.classList.remove('hidden');
  } else {
    inboxBadge.classList.add('hidden');
  }
  // Update extension badge
  chrome.storage.local.set({ badgeCount: inboxCount });
}

function updateStreakDisplay() {
  const today = todayStr();
  const todayCompleted = state.tasks.filter(t =>
    t.status === 'Completed' &&
    t.updatedAt && t.updatedAt.startsWith(today)
  ).length;

  const el = document.getElementById('today-streak');
  if (todayCompleted > 0) {
    el.textContent = `✓ ${todayCompleted}件完了`;
  } else {
    el.textContent = '';
  }
}

function updateInboxAlert() {
  const inboxCount = state.tasks.filter(t => !t.projectId && t.status !== 'Completed' && t.status !== 'Skipped').length;
  const alert = document.getElementById('inbox-alert');
  if (inboxCount >= 10) {
    alert.classList.remove('hidden');
  } else {
    alert.classList.add('hidden');
  }
}

// ============================================================
// TODAY VIEW
// ============================================================

function renderTodayView() {
  const today = todayStr();
  const todayTasks = state.tasks.filter(t =>
    t.status !== 'Completed' && t.status !== 'Skipped' &&
    (t.isTodayTask || (t.dueDate && t.dueDate <= today))
  );

  const list = document.getElementById('today-list');
  const empty = document.getElementById('today-empty');

  if (todayTasks.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    list.innerHTML = todayTasks.map(t => renderTaskItem(t)).join('');
    attachTaskItemListeners(list);
  }
}

function renderWeekHeatmap() {
  const cells = document.getElementById('heatmap-cells');
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const today = new Date();
  const result = [];

  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const count = state.tasks.filter(t =>
      t.status === 'Completed' && t.updatedAt && t.updatedAt.startsWith(dateStr)
    ).length;
    const dayLabel = days[d.getDay()];
    const isToday = i === 0;

    result.push(`
      <div class="heatmap-cell">
        <span class="heatmap-day-label" style="${isToday ? 'color:var(--accent)' : ''}">${dayLabel}</span>
        <div class="heatmap-block ${count >= 3 ? 'many-completions' : count > 0 ? 'has-completions' : ''}"
             title="${dateStr}: ${count}件完了"></div>
        <span class="heatmap-count">${count || ''}</span>
      </div>
    `);
  }
  cells.innerHTML = result.join('');
}

// ============================================================
// INBOX VIEW
// ============================================================

function renderInboxView() {
  const inboxTasks = state.tasks.filter(t => !t.projectId);
  const list = document.getElementById('inbox-list');
  const empty = document.getElementById('inbox-empty');

  if (inboxTasks.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    list.innerHTML = inboxTasks.map(t => renderTaskItem(t)).join('');
    attachTaskItemListeners(list);
  }
}

// ============================================================
// PROJECTS VIEW
// ============================================================

function renderProjectsView() {
  const list = document.getElementById('project-list');

  if (state.projects.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⬡</div>
        <p>Projectがありません</p>
        <p class="empty-sub">「+ New Project」で作成してください</p>
      </div>`;
    return;
  }

  list.innerHTML = state.projects.map(p => {
    const tasks = state.tasks.filter(t => t.projectId === p.id);
    const completed = tasks.filter(t => t.status === 'Completed').length;
    const total = tasks.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    return `
      <div class="project-card" data-project-id="${p.id}">
        <div class="project-color-strip" style="background:${p.color || '#5B8FE0'}"></div>
        <div class="project-card-body">
          <div class="project-card-name">${esc(p.name)}</div>
          <div class="project-card-meta">
            <span class="project-task-count">${total}タスク · ${completed}完了</span>
            <div class="project-mini-progress">
              <div class="project-mini-fill" style="width:${pct}%;background:${p.color || '#5B8FE0'}"></div>
            </div>
          </div>
        </div>
        <div class="project-card-actions">
          <button class="project-action-btn edit-project" data-project-id="${p.id}" title="編集">✎</button>
          <button class="project-action-btn danger delete-project" data-project-id="${p.id}" title="削除">✕</button>
        </div>
      </div>`;
  }).join('');

  // Project click → detail
  list.querySelectorAll('.project-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.project-card-actions')) return;
      openProjectDetail(card.dataset.projectId);
    });
  });

  list.querySelectorAll('.edit-project').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openProjectModal(btn.dataset.projectId);
    });
  });

  list.querySelectorAll('.delete-project').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('このProjectを削除しますか？\nタスクはInboxに移動されます。')) return;
      const pid = btn.dataset.projectId;
      // Move tasks to inbox
      const affected = state.tasks.filter(t => t.projectId === pid);
      for (const t of affected) {
        t.projectId = null;
        await saveTask(t);
      }
      await deleteProject(pid);
      state.projects = state.projects.filter(p => p.id !== pid);
      renderAll();
      showToast('Projectを削除しました');
    });
  });
}

function openProjectDetail(projectId) {
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return;
  state.currentProjectId = projectId;

  document.getElementById('project-list').classList.add('hidden');
  document.getElementById('add-project-btn').closest('.view-header').querySelector('.view-title').textContent = 'Projects';

  const detail = document.getElementById('project-detail');
  detail.classList.remove('hidden');
  document.getElementById('project-detail-name').textContent = project.name;

  const tasks = state.tasks.filter(t => t.projectId === projectId);
  const completed = tasks.filter(t => t.status === 'Completed').length;
  const pct = tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0;

  document.querySelector('#project-progress-bar .progress-fill').style.width = pct + '%';
  document.getElementById('project-progress-text').textContent = `${completed}/${tasks.length} 完了`;

  const list = document.getElementById('project-task-list');
  const empty = document.getElementById('project-task-empty');

  if (tasks.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    list.innerHTML = tasks.map(t => renderTaskItem(t)).join('');
    attachTaskItemListeners(list);
  }
}

function closeProjectDetail() {
  document.getElementById('project-detail').classList.add('hidden');
  document.getElementById('project-list').classList.remove('hidden');
  state.currentProjectId = null;
}

// ============================================================
// TASK ITEM RENDERER
// ============================================================

function renderTaskItem(task) {
  const sc = STATUS_CONFIG[task.status] || STATUS_CONFIG.Pending;
  const priorityClass = `priority-${task.priority}`;
  const prioritySymbol = task.priority === 'high' ? '▲' : task.priority === 'medium' ? '◆' : '▽';
  const today = todayStr();

  let dueHtml = '';
  if (task.dueDate) {
    if (task.dueDate < today) {
      dueHtml = `<span class="task-due-overdue">⚠ ${task.dueDate}</span>`;
    } else if (task.dueDate === today) {
      dueHtml = `<span class="task-due-today">今日</span>`;
    } else {
      dueHtml = `<span class="task-due-normal">${task.dueDate}</span>`;
    }
  }

  const tagsHtml = task.tags.slice(0, 2).map(t =>
    `<span class="task-meta-tag">#${esc(t)}</span>`
  ).join('');

  return `
    <div class="task-item ${task.status === 'Completed' ? 'completed' : ''}"
         data-task-id="${task.id}"
         style="--status-color: ${sc.color}">
      <div class="task-status-dot"></div>
      <div class="task-item-body">
        <div class="task-item-title">${esc(task.title)}</div>
        <div class="task-item-meta">
          <span class="task-priority-dot ${priorityClass}">${prioritySymbol}</span>
          ${task.isTodayTask ? '<span class="task-today-flag">◎ 今日</span>' : ''}
          ${task.sourceUrl ? '<span class="task-has-url">🔗</span>' : ''}
          ${dueHtml}
          ${tagsHtml}
        </div>
      </div>
    </div>`;
}

function attachTaskItemListeners(container) {
  container.querySelectorAll('.task-item').forEach(el => {
    el.addEventListener('click', () => openTaskDetail(el.dataset.taskId));
  });
}

// ============================================================
// TASK DETAIL PANEL
// ============================================================

async function openTaskDetail(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  state.currentTaskId = taskId;

  const panel = document.getElementById('task-detail-panel');
  panel.classList.remove('hidden');

  // Title
  document.getElementById('task-detail-title').value = task.title;

  // Status
  renderStatusSelector(task.status);

  // Priority
  document.getElementById('task-priority').value = task.priority;

  // Due date
  document.getElementById('task-due-date').value = task.dueDate || '';

  // Today toggle
  const todayToggle = document.getElementById('today-toggle');
  todayToggle.classList.toggle('active', task.isTodayTask);

  // Project selector
  await renderProjectSelector(task.projectId);

  // Tags
  renderTags(task.tags);

  // URL
  renderSourceUrl(task.sourceUrl, task.sourceTitle);

  // Checklist
  renderChecklist(task.checklist);

  // Activity log
  await renderActivityLog(taskId);
}

function closeTaskDetail() {
  document.getElementById('task-detail-panel').classList.add('hidden');
  state.currentTaskId = null;
}

function renderStatusSelector(currentStatus) {
  const container = document.getElementById('status-selector');
  container.innerHTML = Object.entries(STATUS_CONFIG).map(([key, cfg]) => `
    <button class="status-btn ${currentStatus === key ? 'active' : ''}"
            data-status="${key}"
            style="--status-color: ${cfg.color}"
            title="${cfg.desc}">
      ${cfg.label}
    </button>
  `).join('');

  container.querySelectorAll('.status-btn').forEach(btn => {
    btn.addEventListener('click', () => changeTaskStatus(btn.dataset.status));
  });
}

async function changeTaskStatus(newStatus) {
  const task = state.tasks.find(t => t.id === state.currentTaskId);
  if (!task || task.status === newStatus) return;

  const oldStatus = task.status;
  task.status = newStatus;
  await saveTask(task);

  const entry = createActivity(task.id, 'status_change', null, oldStatus, newStatus);
  await addActivity(entry);

  renderStatusSelector(newStatus);
  await renderActivityLog(task.id);
  renderAll();

  // Complete animation
  if (newStatus === 'Completed') {
    showToast('🎉 完了！');
  }
}

async function renderProjectSelector(currentProjectId) {
  const sel = document.getElementById('task-project');
  const projects = await getAllProjects();

  sel.innerHTML = `<option value="">📥 Inbox</option>` +
    projects.filter(p => !p.isArchived).map(p =>
      `<option value="${p.id}" ${currentProjectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`
    ).join('');
}

function renderTags(tags) {
  const list = document.getElementById('tag-list');
  list.innerHTML = tags.map((tag, i) => `
    <span class="tag-chip">
      #${esc(tag)}
      <button class="tag-chip-remove" data-index="${i}">✕</button>
    </span>`
  ).join('');

  list.querySelectorAll('.tag-chip-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const task = state.tasks.find(t => t.id === state.currentTaskId);
      if (!task) return;
      task.tags.splice(parseInt(btn.dataset.index), 1);
      await saveTask(task);
      renderTags(task.tags);
    });
  });
}

function renderSourceUrl(url, title) {
  const textEl = document.getElementById('source-url-text');
  const openBtn = document.getElementById('open-url-btn');
  const clearBtn = document.getElementById('clear-url-btn');

  if (url) {
    textEl.textContent = title || url;
    textEl.title = url;
    openBtn.classList.remove('hidden');
    clearBtn.classList.remove('hidden');
  } else {
    textEl.textContent = '未設定';
    textEl.title = '';
    openBtn.classList.add('hidden');
    clearBtn.classList.add('hidden');
  }
}

function renderChecklist(checklist) {
  const container = document.getElementById('checklist-items');
  container.innerHTML = (checklist || []).map((item, i) => `
    <div class="checklist-item" data-index="${i}">
      <div class="checklist-checkbox ${item.checked ? 'checked' : ''}" data-index="${i}">
        ${item.checked ? '✓' : ''}
      </div>
      <span class="checklist-text ${item.checked ? 'checked' : ''}">${esc(item.text)}</span>
      <button class="checklist-delete" data-index="${i}">✕</button>
    </div>`
  ).join('');

  container.querySelectorAll('.checklist-checkbox').forEach(cb => {
    cb.addEventListener('click', async () => {
      const task = state.tasks.find(t => t.id === state.currentTaskId);
      if (!task) return;
      const idx = parseInt(cb.dataset.index);
      task.checklist[idx].checked = !task.checklist[idx].checked;
      await saveTask(task);
      renderChecklist(task.checklist);
    });
  });

  container.querySelectorAll('.checklist-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const task = state.tasks.find(t => t.id === state.currentTaskId);
      if (!task) return;
      task.checklist.splice(parseInt(btn.dataset.index), 1);
      await saveTask(task);
      renderChecklist(task.checklist);
    });
  });
}

async function renderActivityLog(taskId) {
  const log = document.getElementById('activity-log');
  const entries = await getActivityByTask(taskId);

  if (entries.length === 0) {
    log.innerHTML = `<span style="font-size:11px;color:var(--text-3);font-family:var(--font-mono)">記録なし</span>`;
    return;
  }

  log.innerHTML = entries.map(entry => {
    const time = formatTime(entry.createdAt);
    let bodyHtml = '';

    if (entry.type === 'status_change') {
      const fromCfg = STATUS_CONFIG[entry.fromStatus] || {};
      const toCfg = STATUS_CONFIG[entry.toStatus] || {};
      bodyHtml = `<span class="activity-status-change">
        <span class="status-from">${entry.fromStatus || '—'}</span>
        <span class="status-arrow"> → </span>
        <span class="status-to" style="color:${toCfg.color || 'inherit'}">${entry.toStatus}</span>
      </span>`;
    } else if (entry.type === 'created') {
      bodyHtml = `<span class="activity-status-change" style="color:var(--text-3)">作成</span>`;
    } else if (entry.type === 'comment') {
      bodyHtml = `<span class="activity-comment">${esc(entry.text)}</span>`;
    } else if (entry.type === 'url_added') {
      bodyHtml = `<span class="activity-url">🔗 ${esc(entry.text || 'URL設定')}</span>`;
    }

    return `
      <div class="activity-entry">
        <span class="activity-time">${time}</span>
        <div class="activity-body">${bodyHtml}</div>
      </div>`;
  }).join('');

  // Scroll to bottom
  log.scrollTop = log.scrollHeight;
}

// ============================================================
// EVENT LISTENERS
// ============================================================

function setupEventListeners() {
  // Nav tabs
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view;
      switchView(view);
    });
  });

  // Settings button
  document.getElementById('settings-btn').addEventListener('click', () => {
    switchView('settings');
  });

  // Quick add
  const quickInput = document.getElementById('quick-add-input');
  quickInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && quickInput.value.trim()) {
      const task = createTask({ title: quickInput.value.trim() });
      await saveTask(task);
      const entry = createActivity(task.id, 'created', null, null, 'Pending');
      await addActivity(entry);
      state.tasks.push(task);
      quickInput.value = '';
      renderAll();
      showToast('✚ Inboxに追加しました');
    }
  });

  // Inbox alert button
  document.getElementById('inbox-alert-btn').addEventListener('click', () => {
    switchView('inbox');
  });

  // Close task detail
  document.getElementById('close-task-detail').addEventListener('click', closeTaskDetail);

  // Task detail - title change
  document.getElementById('task-detail-title').addEventListener('blur', async (e) => {
    const task = state.tasks.find(t => t.id === state.currentTaskId);
    if (!task || !e.target.value.trim()) return;
    task.title = e.target.value.trim();
    await saveTask(task);
    renderAll();
  });

  // Task detail - priority
  document.getElementById('task-priority').addEventListener('change', async (e) => {
    const task = state.tasks.find(t => t.id === state.currentTaskId);
    if (!task) return;
    task.priority = e.target.value;
    await saveTask(task);
    renderAll();
  });

  // Task detail - due date
  document.getElementById('task-due-date').addEventListener('change', async (e) => {
    const task = state.tasks.find(t => t.id === state.currentTaskId);
    if (!task) return;
    task.dueDate = e.target.value || null;
    await saveTask(task);
    renderAll();
  });

  // Today toggle
  document.getElementById('today-toggle').addEventListener('click', async () => {
    const task = state.tasks.find(t => t.id === state.currentTaskId);
    if (!task) return;
    task.isTodayTask = !task.isTodayTask;
    await saveTask(task);
    document.getElementById('today-toggle').classList.toggle('active', task.isTodayTask);
    renderAll();
  });

  // Project change
  document.getElementById('task-project').addEventListener('change', async (e) => {
    const task = state.tasks.find(t => t.id === state.currentTaskId);
    if (!task) return;
    task.projectId = e.target.value || null;
    await saveTask(task);
    renderAll();
  });

  // Tag input
  document.getElementById('tag-input').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const val = e.target.value.trim().replace(/^#/, '');
      if (!val) return;
      const task = state.tasks.find(t => t.id === state.currentTaskId);
      if (!task) return;
      if (!task.tags.includes(val) && task.tags.length < 5) {
        task.tags.push(val);
        await saveTask(task);
        renderTags(task.tags);
      }
      e.target.value = '';
    }
  });

  // URL buttons
  document.getElementById('open-url-btn').addEventListener('click', () => {
    const task = state.tasks.find(t => t.id === state.currentTaskId);
    if (task?.sourceUrl) chrome.tabs.create({ url: task.sourceUrl });
  });

  document.getElementById('set-current-url-btn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const task = state.tasks.find(t => t.id === state.currentTaskId);
    if (!task) return;
    task.sourceUrl = tab.url;
    task.sourceTitle = tab.title;
    await saveTask(task);
    const entry = createActivity(task.id, 'url_added', `URL設定: ${tab.title || tab.url}`);
    await addActivity(entry);
    renderSourceUrl(task.sourceUrl, task.sourceTitle);
    await renderActivityLog(task.id);
    showToast('📌 現在のページを設定しました');
  });

  document.getElementById('clear-url-btn').addEventListener('click', async () => {
    const task = state.tasks.find(t => t.id === state.currentTaskId);
    if (!task) return;
    task.sourceUrl = null;
    task.sourceTitle = null;
    await saveTask(task);
    renderSourceUrl(null, null);
  });

  // Checklist add
  document.getElementById('checklist-add-input').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      const task = state.tasks.find(t => t.id === state.currentTaskId);
      if (!task) return;
      task.checklist = task.checklist || [];
      task.checklist.push({ id: generateId(), text: e.target.value.trim(), checked: false, order: task.checklist.length });
      await saveTask(task);
      renderChecklist(task.checklist);
      e.target.value = '';
    }
  });

  // Add comment
  document.getElementById('add-comment-btn').addEventListener('click', async () => {
    const input = document.getElementById('comment-input');
    const text = input.value.trim();
    if (!text || !state.currentTaskId) return;
    const entry = createActivity(state.currentTaskId, 'comment', text);
    await addActivity(entry);
    input.value = '';
    await renderActivityLog(state.currentTaskId);
  });

  // Delete task
  document.getElementById('delete-task-btn').addEventListener('click', async () => {
    if (!state.currentTaskId) return;
    if (!confirm('このタスクを削除しますか？')) return;
    await deleteTask(state.currentTaskId);
    await deleteActivitiesByTask(state.currentTaskId);
    state.tasks = state.tasks.filter(t => t.id !== state.currentTaskId);
    closeTaskDetail();
    if (state.currentProjectId) {
      openProjectDetail(state.currentProjectId);
    }
    renderAll();
    showToast('タスクを削除しました');
  });

  // Back to projects
  document.getElementById('back-to-projects').addEventListener('click', closeProjectDetail);

  // Add project button
  document.getElementById('add-project-btn').addEventListener('click', () => openProjectModal(null));

  // Add task in project
  document.getElementById('add-task-in-project').addEventListener('click', async () => {
    if (!state.currentProjectId) return;
    const task = createTask({ projectId: state.currentProjectId });
    await saveTask(task);
    const entry = createActivity(task.id, 'created', null, null, 'Pending');
    await addActivity(entry);
    state.tasks.push(task);
    renderAll();
    openProjectDetail(state.currentProjectId);
    openTaskDetail(task.id);
  });

  // Project modal
  document.getElementById('project-modal-cancel').addEventListener('click', () => {
    document.getElementById('project-modal').classList.add('hidden');
  });

  document.getElementById('project-modal-confirm').addEventListener('click', saveProjectModal);

  document.getElementById('project-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveProjectModal();
  });

  // Settings
  document.getElementById('export-btn').addEventListener('click', async () => {
    const data = await exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `focusflow-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('エクスポートしました');
  });

  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('現在のデータを上書きしてインポートしますか？')) return;
    const text = await file.text();
    const data = JSON.parse(text);
    await importData(data);
    await loadData();
    renderAll();
    showToast('インポートしました');
    e.target.value = '';
  });

  document.getElementById('clear-data-btn').addEventListener('click', async () => {
    if (!confirm('全データを削除しますか？この操作は取り消せません。')) return;
    await importData({ projects: [], tasks: [], activityLog: [] });
    state.tasks = [];
    state.projects = [];
    renderAll();
    showToast('データを削除しました');
  });

  // Color picker (initialize)
  initColorPicker();
}

// ============================================================
// PROJECT MODAL
// ============================================================

function openProjectModal(projectId) {
  state.editingProjectId = projectId;
  const modal = document.getElementById('project-modal');
  const input = document.getElementById('project-name-input');
  const title = document.getElementById('project-modal-title');

  if (projectId) {
    const project = state.projects.find(p => p.id === projectId);
    input.value = project ? project.name : '';
    state.selectedProjectColor = project?.color || PROJECT_COLORS[0];
    title.textContent = 'Projectを編集';
  } else {
    input.value = '';
    state.selectedProjectColor = PROJECT_COLORS[0];
    title.textContent = '新しいProject';
  }

  updateColorPicker();
  modal.classList.remove('hidden');
  setTimeout(() => input.focus(), 100);
}

async function saveProjectModal() {
  const name = document.getElementById('project-name-input').value.trim();
  if (!name) return;

  if (state.editingProjectId) {
    const project = state.projects.find(p => p.id === state.editingProjectId);
    if (project) {
      project.name = name;
      project.color = state.selectedProjectColor;
      await saveProject(project);
    }
  } else {
    const project = {
      id: generateId(),
      name,
      color: state.selectedProjectColor,
      order: state.projects.length,
      isArchived: false,
      createdAt: new Date().toISOString()
    };
    await saveProject(project);
    state.projects.push(project);
  }

  await loadData();
  document.getElementById('project-modal').classList.add('hidden');
  renderAll();
  showToast(state.editingProjectId ? 'Projectを更新しました' : 'Projectを作成しました');
}

function initColorPicker() {
  const picker = document.getElementById('color-picker');
  picker.innerHTML = PROJECT_COLORS.map(c =>
    `<div class="color-swatch ${c === state.selectedProjectColor ? 'selected' : ''}"
          data-color="${c}" style="background:${c}"></div>`
  ).join('');

  picker.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      state.selectedProjectColor = sw.dataset.color;
      updateColorPicker();
    });
  });
}

function updateColorPicker() {
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.classList.toggle('selected', sw.dataset.color === state.selectedProjectColor);
  });
}

// ============================================================
// VIEW SWITCHING
// ============================================================

function switchView(viewName) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));

  const view = document.getElementById(`view-${viewName}`);
  if (view) view.classList.add('active');

  const tab = document.querySelector(`.nav-tab[data-view="${viewName}"]`);
  if (tab) tab.classList.add('active');

  state.currentView = viewName;

  // Close project detail when switching away
  if (viewName !== 'projects') {
    closeProjectDetail();
  }
}

// ============================================================
// UTILITIES
// ============================================================

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function updateTodayDate() {
  const el = document.getElementById('today-date');
  const now = new Date();
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  el.textContent = `${now.getMonth() + 1}/${now.getDate()} (${days[now.getDay()]})`;
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  }
  return `${d.getMonth()+1}/${d.getDate()} ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2200);
}

// ============================================================
// START
// ============================================================

init().catch(console.error);
