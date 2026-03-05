// FocusFlow db.js - IndexedDB管理
// タスク・プロジェクト・ActivityLogの永続化

const DB_NAME = 'FocusFlowDB';
const DB_VERSION = 1;

let db = null;

export function openDB() {
  return new Promise((resolve, reject) => {
    if (db) { resolve(db); return; }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const database = e.target.result;

      // Projects store
      if (!database.objectStoreNames.contains('projects')) {
        const ps = database.createObjectStore('projects', { keyPath: 'id' });
        ps.createIndex('order', 'order', { unique: false });
      }

      // Tasks store
      if (!database.objectStoreNames.contains('tasks')) {
        const ts = database.createObjectStore('tasks', { keyPath: 'id' });
        ts.createIndex('projectId', 'projectId', { unique: false });
        ts.createIndex('status', 'status', { unique: false });
        ts.createIndex('isTodayTask', 'isTodayTask', { unique: false });
        ts.createIndex('dueDate', 'dueDate', { unique: false });
      }

      // ActivityLog store
      if (!database.objectStoreNames.contains('activityLog')) {
        const al = database.createObjectStore('activityLog', { keyPath: 'id' });
        al.createIndex('taskId', 'taskId', { unique: false });
        al.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };

    request.onerror = () => reject(request.error);
  });
}

// ---- Generic helpers ----

function txStore(storeName, mode = 'readonly') {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function promisify(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function getAll(storeName) {
  return openDB().then(() => promisify(txStore(storeName).getAll()));
}

function getById(storeName, id) {
  return openDB().then(() => promisify(txStore(storeName).get(id)));
}

function put(storeName, obj) {
  return openDB().then(() => promisify(txStore(storeName, 'readwrite').put(obj)));
}

function del(storeName, id) {
  return openDB().then(() => promisify(txStore(storeName, 'readwrite').delete(id)));
}

// ---- ID generator ----
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---- Projects ----

export async function getProjects() {
  const all = await getAll('projects');
  return all.filter(p => !p.isArchived).sort((a, b) => a.order - b.order);
}

export async function getAllProjects() {
  return getAll('projects');
}

export async function saveProject(project) {
  return put('projects', project);
}

export async function deleteProject(id) {
  return del('projects', id);
}

// ---- Tasks ----

export async function getTasks() {
  return getAll('tasks');
}

export async function getTaskById(id) {
  return getById('tasks', id);
}

export async function saveTask(task) {
  task.updatedAt = new Date().toISOString();
  return put('tasks', task);
}

export async function deleteTask(id) {
  return del('tasks', id);
}

// ---- ActivityLog ----

export async function getActivityByTask(taskId) {
  await openDB();
  const store = txStore('activityLog');
  const index = store.index('taskId');
  const entries = await promisify(index.getAll(taskId));
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function addActivity(entry) {
  return put('activityLog', entry);
}

export async function deleteActivitiesByTask(taskId) {
  await openDB();
  const entries = await getActivityByTask(taskId);
  const tx = db.transaction('activityLog', 'readwrite');
  const store = tx.objectStore('activityLog');
  entries.forEach(e => store.delete(e.id));
  return new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = rej;
  });
}

// ---- Export / Import ----

export async function exportData() {
  const [projects, tasks, activityLog] = await Promise.all([
    getAll('projects'),
    getAll('tasks'),
    getAll('activityLog')
  ]);
  return { projects, tasks, activityLog, exportedAt: new Date().toISOString() };
}

export async function importData(data) {
  await openDB();
  const stores = ['projects', 'tasks', 'activityLog'];
  for (const storeName of stores) {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.clear();
    (data[storeName] || []).forEach(item => store.put(item));
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  }
}
