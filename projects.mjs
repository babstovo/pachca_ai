import { execFile } from 'node:child_process';
import { readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { myAssignedTasks, readOpenProjectTask } from './openproject.mjs';
import { reasoningEfforts } from './codex.mjs';

const git = promisify(execFile);

const sourceFile = /\.(?:[cm]?[jt]sx?|vue|svelte|jsonc?|ya?ml|toml|ini|xml|csv|tsv|sql|md|txt|cs|rs|go|py|php|java|kt|swift|c|cpp|h|gd|tscn|tres|lua|html|css|scss|properties)$/i;
const excludedDirectory = /^(?:node_modules|vendor|dist|build|coverage|target|bin|obj|__pycache__|Pods)$/i;
const excludedFile = /(?:^\.|\.min\.|^package-lock\.json$|secret|credential|\.pem$)/i;

// The planner can select only files discovered inside the configured project.
export async function projectFileSearch(folder, keywords, signal) {
  const root = await realpath(folder);
  const files = new Map();
  const hits = [];
  let bytes = 0, partial = false;
  const terms = [...new Set(keywords.filter(word => typeof word === 'string')
    .map(word => word.trim().toLowerCase()).filter(word => word.length >= 2 && word.length <= 80))].slice(0, 16);
  async function linesOf(path) {
    const target = await realpath(join(root, path));
    const local = relative(root, target);
    if (local.startsWith('..' + sep) || local === '..' || isAbsolute(local)) return [];
    const info = await stat(target);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return [];
    const text = await readFile(target, {encoding:'utf8', signal});
    if (text.includes('\0')) return [];
    return text.split(/\r?\n/);
  }
  const pending = [''];
  while (pending.length && !partial) {
    signal.throwIfAborted();
    const dir = pending.shift();
    const entries = await readdir(join(root,dir), {withFileTypes:true}).catch(error => { if (!dir) throw error; return []; });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = dir ? dir + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (!excludedDirectory.test(entry.name)) pending.push(path);
        continue;
      }
      if (!entry.isFile() || !sourceFile.test(entry.name) || excludedFile.test(entry.name)) continue;
      if (files.size >= 20000 || bytes >= 160 * 1024 * 1024) { partial = true; break; }
      const lines = await linesOf(path).catch(error => { signal.throwIfAborted(); return []; });
      if (!lines.length) continue;
      files.set(path, lines.length);
      const name = path.toLowerCase();
      const pathScore = terms.filter(word => name.includes(word)).length;
      let best = 0, start = 0;
      for (let i = 0; i < lines.length; i += 24) {
        const block = lines.slice(i,i+24).join('\n').toLowerCase();
        bytes += block.length * 2;
        const score = terms.filter(word => block.includes(word)).length;
        if (score > best) { best = score; start = i; }
      }
      const score = best * 3 + pathScore;
      if (!score) continue;
      hits.push({path, score, start:start+1, lines:lines.length, excerpt:lines.slice(start,start+24).join('\n').slice(0,2200)});
      hits.sort((a,b) => b.score-a.score || a.path.localeCompare(b.path));
      if (hits.length > 22) hits.pop();
    }
  }
  return {
    matches: hits.map(({score, ...hit}) => hit), partial,
    async read(selections) {
      const excerpts = [];
      for (const selection of selections.slice(0,6)) {
        signal.throwIfAborted();
        if (!files.has(selection?.path)) continue;
        const start = Math.max(1, Number.isSafeInteger(selection.start) ? selection.start : 1);
        const lines = await linesOf(selection.path);
        excerpts.push({path:selection.path, start, lines:lines.length,
          excerpt:lines.slice(start-1,start+159).map(line => line.slice(0,3000)).join('\n').slice(0,14000)});
      }
      return excerpts;
    },
  };
}

export async function readProjects(file) {
  const stored = await readFile(file, 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return {};
    throw error;
  });
  const folders = Array.isArray(stored.folders) ? stored.folders.filter(folder => typeof folder === 'string' && isAbsolute(folder)).slice(0, 12) : [];
  return {
    openproject: stored.openproject === true,
    folders,
    folderProjects: projectBindings(folders, folders, stored.folderProjects),
    folderDescriptions: Object.fromEntries(folders.filter(path => typeof stored.folderDescriptions?.[path] === 'string')
      .map(path => [path, stored.folderDescriptions[path].trim().slice(0, 500)])),
    folderAgents: Object.fromEntries(folders.filter(path => stored.folderAgents?.[path])
      .map(path => [path, folderAgent(stored.folderAgents[path])])),
    autoTaskWork: stored.autoTaskWork === true,
    model: typeof stored.model === 'string' ? stored.model : '',
    effort: reasoningEfforts.includes(stored.effort) ? stored.effort : '',
    confirmSend: stored.confirmSend !== false,
  };
}

function projectBindings(folders, inputFolders, bindings = {}) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings))
    throw Error('Проверьте список выбранных проектов Codex.');
  const result = new Map();
  for (const [index,path] of folders.entries()) {
    const value = Object.hasOwn(bindings,inputFolders[index]) ? bindings[inputFolders[index]] : bindings[path];
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![value.id,value.name].every(text => typeof text === 'string' && text.trim() && text.length <= 512 && !/[\x00-\x1f\x7f]/.test(text)))
      throw Error('Для выбранного проекта Codex нужны ID и название.');
    const id = value.id.trim(), name = value.name.trim();
    if (result.has(path) && result.get(path).id !== id)
      throw Error('Для одной папки можно выбрать только один проект Codex.');
    result.set(path,{id,name});
  }
  return Object.fromEntries(result);
}

function folderAgent(value = {}) {
  const {model = '', effort = ''} = value;
  if (typeof model !== 'string' || model.length > 160 || /[\x00-\x1f]/.test(model) || (effort !== '' && !reasoningEfforts.includes(effort)))
    throw Error('Проверьте модель и уровень мышления в настройках проекта.');
  return {model, effort};
}

export function taskModelSettings(settings, folder, models) {
  const override = settings.folderAgents?.[folder] || {};
  const model = override.model || settings.model || '';
  const target = models?.find(row => model ? row.id === model : row.is_default);
  if (models && !target) throw Error('Модель проекта больше недоступна. Проверьте настройки проектов.');
  if (target && override.effort && !target.efforts.includes(override.effort))
    throw Error('Модель больше не поддерживает выбранный уровень рассуждения.');
  const inherited = !target || target.efforts.includes(settings.effort) ? settings.effort : '';
  return {model, effort:override.effort || inherited || ''};
}

export async function saveProjects(file, current, changes) {
  const next = { ...current };
  if (changes.autoTaskWork !== undefined) {
    if (typeof changes.autoTaskWork !== 'boolean') throw Error('Выберите, запускать ли задачи автоматически.');
    next.autoTaskWork = changes.autoTaskWork;
  }
  if (Object.hasOwn(changes, 'openproject')) {
    if (typeof changes.openproject !== 'boolean') throw new Error('Укажите, подключать ли доску OpenProject.');
    next.openproject = changes.openproject;
  }
  if (Object.hasOwn(changes, 'folders') || Object.hasOwn(changes, 'folderProjects')) {
    const inputFolders = Object.hasOwn(changes, 'folders') ? changes.folders : current.folders;
    if (!Array.isArray(inputFolders) || inputFolders.length > 12 ||
        inputFolders.some(folder => typeof folder !== 'string' || !isAbsolute(folder) || folder.length > 2048)) {
      throw new Error('Выберите до 12 локальных папок.');
    }
    const folders = await Promise.all(inputFolders.map(async folder => {
      // Already configured folders may be temporarily unavailable.
      if (current.folders.includes(folder)) return folder;
      const path = await realpath(folder).catch(() => undefined);
      if (!path || !(await stat(path)).isDirectory()) throw new Error(`Не удалось открыть папку «${basename(folder)}».`);
      return path;
    }));
    next.folders = [...new Set(folders)];
    next.folderProjects = projectBindings(folders,inputFolders,
      changes.folderProjects === undefined ? current.folderProjects : changes.folderProjects);
    function previousPath(path) {
      const id = next.folderProjects[path]?.id;
      if (!id || current.folders.includes(path) || Object.values(next.folderProjects).filter(project => project.id === id).length !== 1)
        return path;
      // Transfer settings when a single-root project moves to a new source folder.
      const previous = Object.entries(current.folderProjects ?? {}).filter(([,project]) => project.id === id);
      return previous.length === 1 ? previous[0][0] : path;
    }
    const descriptions = changes.folderDescriptions;
    if (descriptions !== undefined && (!descriptions || typeof descriptions !== 'object' || Array.isArray(descriptions))) {
      throw new Error('Не удалось прочитать описания папок.');
    }
    const saved = new Map();
    for (const [index, path] of folders.entries()) {
      const prior = previousPath(path);
      const value = descriptions === undefined ? current.folderDescriptions?.[prior] ?? '' : descriptions[inputFolders[index]] ?? descriptions[path] ?? '';
      if (typeof value !== 'string' || value.length > 500) throw new Error('Описание папки должно быть не длиннее 500 символов.');
      if (value.trim()) saved.set(path, value.trim());
    }
    next.folderDescriptions = Object.fromEntries(saved);
    const agents = changes.folderAgents ?? current.folderAgents ?? {};
    if (!agents || typeof agents !== 'object' || Array.isArray(agents)) throw Error('Проверьте настройки агентов для папок.');
    const overrides = [];
    for (const [index,path] of folders.entries()) {
      const prior = previousPath(path);
      const agent = folderAgent(changes.folderAgents === undefined ? agents[prior] : agents[inputFolders[index]] ?? agents[path]);
      if (agent.model || agent.effort) overrides.push([path,agent]);
    }
    next.folderAgents = Object.fromEntries(overrides);
  }
  if (Object.hasOwn(changes, 'model')) next.model = changes.model;
  if (Object.hasOwn(changes, 'effort')) next.effort = changes.effort;
  if (Object.hasOwn(changes, 'confirmSend')) next.confirmSend = changes.confirmSend;
  await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  return next;
}

async function gitStatus(folder, signal) {
  const name = basename(folder) || 'Локальный проект';
  const run = async (...args) => (await git('git', ['--no-optional-locks', '--literal-pathspecs', '-C', folder,
    '-c', 'core.fsmonitor=false', ...args], { windowsHide: true, signal, timeout: 7000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  try {
    const [headline, ...records] = (await run('status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all',
      '--ignore-submodules=all')).split('\0');
    const info = headline.replace(/^## /, '');
    const branch = info.startsWith('HEAD (') ? null : info.replace(/^(?:No commits yet on |Initial commit on )/, '').split('...')[0];
    const changes = [];
    for (let i = 0; i < records.length && records[i]; i++) {
      const status = records[i].slice(0, 2);
      const path = records[i].slice(3);
      const from = /[RC]/.test(status) ? records[++i] : undefined;
      changes.push({ status, path, from });
    }
    const tracked = changes.filter(change => change.status !== '??');
    const [recent, ...topics] = await Promise.all([
      run('log', '-4', '--no-merges', '-z', '--format=%h%x00%cI%x00%s', 'HEAD', '--').then(async text => {
        const fields = text.split('\0');
        const commits = [];
        for (let i = 0; i + 2 < fields.length && fields[i]; i += 3)
          commits.push({ id: fields[i], date: fields[i + 1], subject: fields[i + 2].slice(0, 250) });
        if (commits.length > 0 && /^[0-9a-f]+$/.test(commits[0].id)) {
          commits[0].files = (await run('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commits[0].id, '--')
            .catch(() => '')).split('\0').filter(Boolean).slice(0, 40);
        }
        return commits;
      }).catch(() => []),
      ...[['скидки', '[Dd]iscount|скидк'], ['акции', '[Pp]romotion|[Ss]pecialOffer|акци'],
        ['товары и каталог', '[Pp]roduct|[Cc]atalog|товар']].map(async ([topic, expression]) => {
          if (tracked.length === 0) return undefined;
          const files = await run('diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '-G', expression,
            'HEAD', '--', ...tracked.slice(0, 45).map(change => change.path)).catch(() => '');
          if (files) return { topic, files: files.split('\0').filter(Boolean).slice(0, 8) };
      }),
    ]);
    return { name, branch, detached: branch === null, changed_tracked: tracked.length, changed_total: changes.length,
      changed_files: changes.slice(0, 65), recent_commits: recent, topics: topics.filter(Boolean) };
  } catch {
    return { name, error: 'Статус Git недоступен' };
  }
}

const tasksInFlight = new Map();
function projectTasks(profile) {
  if (!tasksInFlight.has(profile)) tasksInFlight.set(profile, myAssignedTasks(50, profile).finally(() => tasksInFlight.delete(profile)));
  return tasksInFlight.get(profile);
}

export async function projectSnapshot(settings, signal, scope = 'both', { profile, taskId, task } = {}) {
  const groups = scope !== 'tasks' ? settings.folders.map(async folder => ({
    ...await gitStatus(folder, signal), description: settings.folderDescriptions?.[folder] || undefined,
  })) : [];
  let board;
  if (settings.openproject && scope !== 'git') {
    if (taskId) board = task ? Promise.resolve({ task }) : readOpenProjectTask(taskId, profile).then(task => ({ task }),
      () => ({ error: 'Запрошенная задача OpenProject недоступна.' }));
    else board = projectTasks(profile).then(result => ({
      total: result.total, assignee: result.user, open_only: true,
      tasks: result.tasks,
    }), () => ({ error: 'Доска OpenProject недоступна. Проверьте вход и доступ.' }));
  }
  const [repositories, openproject] = await Promise.all([Promise.all(groups), board]);
  signal.throwIfAborted();
  return { repositories, openproject };
}
