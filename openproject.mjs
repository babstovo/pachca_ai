import { spawnSync } from 'node:child_process';
import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { configuredBoard, parseBoardAddress, preferredBoardProfile, saveBoardAddress } from './workspace-settings.mjs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { clientDataDir, openSession } from './session.mjs';
import { callWatcher } from './watch-pipe.mjs';
import { urlTask } from './task-links.mjs';
import { publicTaskFile, readLimitedBytes } from './link-preview.mjs';

function requireBoard() {
  const board = configuredBoard();
  if (!board) throw Error('Укажите ссылку на доску OpenProject в настройках «Доска задач».');
  return board;
}
const boardId = board => Number(board.pathname.split('/').at(-1));
const siteId = board => createHash('sha256').update(board.origin).digest('hex').slice(0, 32);
const siteDir = board => join(clientDataDir(), 'openproject', siteId(board));
const sessionFile = board => join(siteDir(board), 'session.dpapi');
const keyFile = (profile, board) => {
  if (!Number.isSafeInteger(Number(profile)) || Number(profile) < 1 || !/^\d+$/.test(String(profile))) throw new Error('Не удалось определить профиль Пачки.');
  return join(siteDir(board), `openproject-key-${profile}.dpapi`);
};

function cryptSession(operation, bytes) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd())',
    `$result = [Security.Cryptography.ProtectedData]::${operation}($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($result))',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    input: bytes.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('Не удалось открыть защищённое хранилище OpenProject в текущем аккаунте Windows.');
  return Buffer.from(result.stdout, 'base64');
}

async function restoreSession(session, board) {
  let bytes;
  try { bytes = await readFile(sessionFile(board)); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const cookies = JSON.parse(cryptSession('Unprotect', bytes).toString('utf8'));
  await session.addCookies(cookies);
}

async function saveSession(session, board) {
  const cookies = await session.cookies(board.origin);
  const filename = sessionFile(board);
  await mkdir(siteDir(board), {recursive:true});
  await writeFile(`${filename}.tmp`, cryptSession('Protect', Buffer.from(JSON.stringify(cookies))));
  await rename(`${filename}.tmp`, filename);
}

class OpenProjectError extends Error {
  constructor(status, path) {
    super(status === 401 ? 'Войдите в OpenProject через openproject-login.' :
      `OpenProject вернул HTTP ${status} для ${path}. Проверьте доступ к доске.`);
    this.status = status;
  }
}

export function openProjectApi(key, fetcher = fetch, board = requireBoard()) {
  const {origin} = board;
  const authorization = 'Basic ' + Buffer.from('apikey:' + key).toString('base64');
  const get = async (path, query = {}, { method = 'GET', body, fileLimit } = {}) => {
    const url = new URL(path, origin);
    if (url.origin !== origin || url.username || url.password || !url.pathname.startsWith('/api/v3/'))
      throw new Error('Адрес OpenProject вне подключённого сервера.');
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    let response;
    try {
      response = await fetcher(url, { method, redirect: fileLimit ? 'manual' : 'error', signal: AbortSignal.timeout(15_000),
        headers: { authorization, accept: fileLimit ? '*/*' : 'application/hal+json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    } catch (cause) {
      if (method === 'POST' && url.pathname.endsWith('/activities'))
        throw new Error('Отправка комментария не подтверждена. Обновите обсуждение перед повтором.');
      throw Object.assign(new Error(method === 'PATCH' ? 'OpenProject не подтвердил обновление. Проверьте задачу перед повтором.' : 'API OpenProject недоступен.', {cause}), {networkError:true});
    }
    if (fileLimit && [301,302,303,307,308].includes(response.status) && response.headers.get('location')) {
      await response.body?.cancel();
      // Object storage URLs carry their own signature. Download without the OpenProject key.
      return publicTaskFile(new URL(response.headers.get('location'),url).href,fileLimit,AbortSignal.timeout(20000));
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new Error('OpenProject не принял API-ключ. Проверьте его в настройках «Доска задач».');
      if (response.status === 403) throw Object.assign(new Error('В OpenProject у этого аккаунта недостаточно прав.'), {status:403});
      if (response.status === 409) throw new Error('Задачу изменили. Обновите карточку и проверьте правки.');
      if (response.status === 422) throw Object.assign(new Error('OpenProject отклонил запрос. Проверьте поля и доступные переходы статуса.'), {status:422});
      throw Object.assign(new Error(`API OpenProject вернул HTTP ${response.status}.`), {status:response.status});
    }
    if (fileLimit) {
      if (/text\/html/i.test(response.headers.get('content-type') || '') && !response.headers.has('content-disposition')) {
        await response.body?.cancel();
        throw Error('Вместо вложения OpenProject вернул веб-страницу.');
      }
      return readLimitedBytes(response.body,fileLimit);
    }
    return response.json().catch(cause => {
      if (cause instanceof SyntaxError) throw new Error('API OpenProject вернул данные другого формата.');
      throw Object.assign(new Error('Не удалось дочитать ответ OpenProject.', {cause}), {networkError:true});
    });
  };
  return Object.assign(get, {board});
}

export function hasOpenProjectKey(profile, board = configuredBoard()) {
  if (!board) return Promise.resolve(false);
  return access(keyFile(profile, board)).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

export async function configuredTaskProfile(profiles) {
  const board = configuredBoard();
  if (!board) return null;
  const configured = [];
  for (const profile of new Set(profiles)) {
    if (Number.isSafeInteger(profile) && profile > 0 && await hasOpenProjectKey(profile, board)) configured.push(profile);
  }
  const preferred = preferredBoardProfile();
  return configured.includes(preferred) ? preferred : configured.length === 1 ? configured[0] : null;
}

export async function saveOpenProjectKey(profile, key, address) {
  const board = address === undefined ? requireBoard() : parseBoardAddress(address);
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(key)) throw new Error('Вставьте API-ключ из настроек аккаунта OpenProject.');
  const get = openProjectApi(key, fetch, board);
  const user = identity(await get('/api/v3/users/me'));
  const grid = await get('/api/v3/grids/' + boardId(board));
  if (grid.id !== boardId(board) || !Array.isArray(grid.widgets)) throw Error('OpenProject не подтвердил доступ к выбранной доске.');
  const filename = keyFile(profile, board);
  await mkdir(siteDir(board), {recursive:true});
  const temp = filename + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, cryptSession('Protect', Buffer.from(key)), { mode: 0o600 });
    await rename(temp, filename);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  saveBoardAddress(board, profile);
  return { configured: true, account: user.name, boardUrl: board.href };
}

export async function removeOpenProjectKey(profile) {
  const board = requireBoard();
  try { await unlink(keyFile(profile, board)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { configured: false };
}

async function defaultKeyProfile(board) {
  let files;
  try { files = await readdir(siteDir(board)); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  const profiles = files.flatMap(file => /^openproject-key-([1-9]\d*)\.dpapi$/.exec(file)?.[1] ?? []);
  if (profiles.length === 0) return undefined;
  const active = (await callWatcher({ command: 'watch-status' }))?.data?.profile_id;
  if (active !== undefined) return active;
  if (profiles.length === 1) return profiles[0];
  throw new Error('Сохранено несколько ключей OpenProject. Откройте Пачка AI с нужным профилем.');
}

async function savedApi(profile) {
  const board = configuredBoard();
  if (!board) return;
  const keyProfile = profile ?? await defaultKeyProfile(board);
  if (keyProfile === undefined) return undefined;
  const encoded = await readFile(keyFile(keyProfile, board)).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (encoded) return openProjectApi(cryptSession('Unprotect', encoded).toString('utf8'), fetch, board);
}

async function readWithProfile(profile, action) {
  const api = await savedApi(profile);
  return api ? action(api) : withOpenProject(false, (_tab, get) => action(get));
}

export function requestedWorkPackages(text) {
  const value = String(text ?? '');
  const explicit = [...value.matchAll(/(?:[#№]\s*|\/work_packages\/|(?:\b(?:tasks?|wp)|задач[а-яё]*|карточк[а-яё]*)\s*[#№]?\s*)(\d{1,12})(?!\d)/giu)]
    .map(match => match[1]);
  const lists = [...value.matchAll(/(?:задач[а-яё]*|карточк[а-яё]*|\btasks)\s+([#№]?\s*\d{1,12}(?!\d)(?:\s*(?:,|и|and)\s*[#№]?\s*\d{1,12}(?!\d))+)/giu)];
  const ids = [...explicit, ...lists.flatMap(match => match[1].match(/\d+/g))].map(Number);
  return [...new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0))];
}

export function requestedWorkPackage(text) {
  const matches = requestedWorkPackages(text);
  return matches.length === 1 ? matches[0] : undefined;
}

function taskPath(id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Укажите номер задачи OpenProject.');
  return `/api/v3/work_packages/${id}`;
}

export function readOpenProjectTask(id, profile) {
  return readWithProfile(profile, async get => {
    const card = await get(taskPath(id));
    if (card.id !== id) throw new Error('OpenProject не вернул задачу с указанным номером.');
    return { id, subject: card.subject, status: card._links?.status?.title,
      assignee: card._links?.assignee?.title, due_date: card.dueDate ?? card.date, url: `${get.board.origin}/work_packages/${id}` };
  });
}

export async function taskAcceptanceEvidence(get, id, signal) {
  const path = taskPath(id);
  const card = await get(path);
  if (card.id !== id) throw Error('Не удалось сверить номер карточки.');
  const status = await get(card._links.status.href);
  const description = card.description?.raw || '';
  const evidence = { id, subject:card.subject, status:status.name, closed:status.isClosed === true,
    version:card.lockVersion, requirements:description.slice(0,16000), comments:[], partial:description.length > 16000 };
  if (evidence.closed) return evidence;
  let remaining = 24000;
  for (let offset = 1; ; offset++) {
    signal.throwIfAborted();
    const page = await get(path+'/activities', { offset, pageSize:100 });
    if (!Array.isArray(page._embedded?.elements)) throw Error('Не удалось прочитать обсуждение карточки.');
    for (const entry of page._embedded.elements) {
      const note = entry.comment?.raw?.trim();
      if (entry.internal || !note) continue;
      if (note.length > remaining) evidence.partial = true;
      if (remaining) evidence.comments.push(note.slice(0,remaining));
      remaining = Math.max(0, remaining - note.length);
    }
    if (!page._links?.nextByOffset?.href) break;
    if (!remaining || offset >= 20) { evidence.partial = true; break; }
  }
  return evidence;
}

export function readTaskAcceptance(profile, id, signal) {
  return readWithProfile(profile, get => taskAcceptanceEvidence(get, id, signal));
}

export async function closeAcceptedTask(profile, evidence, beforeWrite) {
  const api = await taskEditor(profile);
  const statuses = await api('/api/v3/statuses');
  const names = /^(?:закрыт[аоы]?|заверш[её]н(?:а|о|ы|ная|ные)?|готово|closed|done|completed)$/iu;
  const terminal = statuses._embedded?.elements?.filter(item => item.isClosed && names.test(item.name));
  if (terminal?.length !== 1) throw Error('Не удалось однозначно выбрать статус завершения.');
  const plan = await planOpenProjectStatus(api, evidence.id, terminal[0].name, statuses);
  if (plan.unchanged) return {already:true, status:plan.next};
  if (plan.body.lockVersion !== evidence.version) throw Error('Карточка изменилась после проверки требований.');
  await beforeWrite();
  return applyOpenProjectStatus(api, plan);
}

export async function findTaskSubjects(profile,terms) {
  const api = await savedApi(profile);
  if (!api) throw Error('Для поиска задачи по описанию привяжи ключ OpenProject или укажи её номер.');
  const tasks = new Map();
  const pages = await Promise.all(terms.map(term => api('/api/v3/work_packages',{
    filters:JSON.stringify([{subject:{operator:'~',values:[term]}}]),pageSize:100,
  })));
  for (const page of pages) {
    const items = page._embedded?.elements;
    if (!Array.isArray(items) || items.length < page.total)
      throw Error('По этому описанию не удалось однозначно найти задачу. Укажи номер OpenProject.');
    for (const row of items) if (Number.isSafeInteger(row.id) && row.subject)
      tasks.set(row.id,{id:row.id,subject:row.subject,status:row._links.status?.title});
  }
  return [...tasks.values()];
}

export async function planOpenProjectStatus(api, id, name, statusesRequest, assigneeId) {
  const path = taskPath(id);
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Укажите название нового статуса.');
  const [card, statuses] = await Promise.all([api(path), statusesRequest ?? api('/api/v3/statuses')]);
  if (card.id !== id || !Number.isSafeInteger(card.lockVersion) || (!card._links?.update && !card._links?.updateImmediately))
    throw new Error('У этого аккаунта нет права редактировать задачу.');
  if (assigneeId && card._links?.assignee?.href !== `/api/v3/users/${assigneeId}`)
    throw new Error('Исполнитель задачи изменился после просмотра списка.');
  const clean = value => String(value ?? '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
  const choices = statuses._embedded?.elements;
  if (!Array.isArray(choices)) throw new Error('OpenProject не вернул список статусов.');
  const normalized = clean(name);
  const aliases = [
    ['в работе', 'in progress'], ['новая', 'новый', 'new'],
    ['готово', 'завершено', 'завершенные', 'завершенной', 'завершенным', 'завершен', 'done', 'completed'],
    ['закрыта', 'закрыто', 'closed'], ['на паузе', 'приостановлена', 'on hold'],
  ];
  const valid = choices.filter(item => Number.isSafeInteger(item.id) && item.id > 0);
  const exact = valid.filter(item => clean(item.name) === normalized);
  const group = aliases.find(items => items.includes(normalized));
  let found = exact.length || !group ? exact : valid.filter(item => group.includes(clean(item.name)));
  if (!found.length && group?.includes('completed'))
    found = valid.filter(item => item.isClosed === true && clean(item.name) === 'closed');
  if (found.length !== 1) throw new Error(`Укажите статус точнее. В OpenProject есть: ${choices.slice(0, 18).map(item => item.name).filter(Boolean).join(', ')}.`);
  const statusHref = `/api/v3/statuses/${found[0].id}`;
  const next = found[0].name;
  const current = card._links?.status?.title;
  if (card._links?.status?.href === statusHref) return { current, next, unchanged: true };
  const body = { lockVersion: card.lockVersion, _links: { status: { href: statusHref } } };
  const form = await api(`${path}/form`, {}, { method: 'POST', body });
  if (Object.keys(form._embedded?.validationErrors ?? {}).length > 0)
    throw new Error('Workflow OpenProject не позволяет выбрать этот статус для задачи.');
  return { id, subject: card.subject, current, next, body };
}

export async function prepareOpenProjectStatus(profile, id, name) {
  const api = await savedApi(profile);
  if (!api) throw new Error('Для смены статуса добавьте API-ключ OpenProject в настройках «Доска задач».');
  return planOpenProjectStatus(api, id, name);
}

export async function prepareOpenProjectStatuses(profile, ids, name, assigneeId) {
  const api = await savedApi(profile);
  if (!api) throw new Error('Для смены статуса добавьте API-ключ OpenProject в настройках «Доска задач».');
  const statuses = await api('/api/v3/statuses');
  const changes = [], blocked = [];
  for (const id of ids) {
    try {
      changes.push({ id, ...await planOpenProjectStatus(api, id, name, statuses, assigneeId) });
    } catch (error) { blocked.push({ id, error: error.message }); }
  }
  return { changes, blocked };
}

export async function applyOpenProjectStatus(api, plan) {
  const updated = await api(taskPath(plan.id), {}, { method: 'PATCH', body: plan.body });
  if (updated.id !== plan.id || updated._links?.status?.href !== plan.body._links.status.href)
    throw new Error('OpenProject не подтвердил новый статус. Проверьте карточку перед повтором.');
  return { id: updated.id, status: updated._links.status.title || plan.next };
}

export async function changeOpenProjectStatus(profile, plan) {
  const api = await savedApi(profile);
  if (!api) throw new Error('API-ключ больше не подключён.');
  return applyOpenProjectStatus(api, plan);
}

export async function changeOpenProjectStatuses(profile, plans, beforeWrite) {
  const api = await savedApi(profile);
  if (!api) throw new Error('API-ключ больше не подключён.');
  const updated = [], failed = [];
  beforeWrite?.();
  for (const plan of plans) {
    try { updated.push(await applyOpenProjectStatus(api, plan)); }
    catch (error) { failed.push({ id: plan.id, error: error.message }); }
  }
  return { updated, failed };
}

function reader(tab, board) {
  const {origin} = board;
  const get = async (path, query = {}) => {
    const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/api/v3/')) {
      throw new Error('OpenProject вернул ссылку вне API подключённой доски.');
    }
    const pathname = new URL(tab.url()).pathname;
    if (new URL(tab.url()).origin !== origin || pathname === '/login') throw new OpenProjectError(401, url.pathname);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const { status, text } = await tab.evaluate(async url => {
      const headers = {
        accept: 'application/hal+json',
        'x-authentication-scheme': 'Session',
        'x-requested-with': 'XMLHttpRequest',
      };
      const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
      if (csrf) headers['x-csrf-token'] = csrf;
      const response = await fetch(url, {
        headers, credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      return { status: response.status, text: await response.text() };
    }, url.href);
    if (status < 200 || status >= 300) throw new OpenProjectError(status, url.pathname);
    try { return JSON.parse(text); } catch { throw new Error('OpenProject вернул ответ другого формата.'); }
  };
  return Object.assign(get, {board});
}

async function withOpenProject(interactive, action) {
  const board = requireBoard();
  const session = await openSession(interactive, 'openproject-profile-' + siteId(board));
  try {
    if (!interactive) await restoreSession(session, board);
    const tab = session.pages()[0] ?? await session.newPage();
    await tab.goto(board.href, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    const result = await action(tab, reader(tab, board));
    await saveSession(session, board);
    return result;
  } finally {
    await session.close();
  }
}

function identity(user) {
  if (!Number.isSafeInteger(user?.id) || user.id < 1) throw new Error('OpenProject не вернул ID вошедшего пользователя.');
  return { id: user.id, name: user.name };
}

export function myAssignedTasks(limit = 50, profile) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Ожидается количество задач от 1 до 100.');
  return readWithProfile(profile, get => assignedPage(get, limit, 1, false));
}

async function boardStatuses(api) {
  const entries = (await api('/api/v3/statuses'))._embedded?.elements;
  if (!Array.isArray(entries) || entries.some(s => !Number.isSafeInteger(s.id) || typeof s.isClosed !== 'boolean'))
    throw Error('OpenProject не вернул список статусов.');
  return entries.map(({id, name, isClosed}) => ({id, name, closed:isClosed}));
}

function boardReader(api) {
  const read = async (path, params) => {
    try { return await api(path, params); }
    catch (error) {
      if (!error.networkError && ![408, 502, 503, 504].includes(error.status)) throw error;
      await delay(400);
      return api(path, params);
    }
  };
  return Object.assign(read, {board:api.board});
}

function overlayFile(board, profile) {
  if (!Number.isSafeInteger(profile) || profile < 1) throw Error('Выберите пространство Пачки.');
  return join(siteDir(board), `overlay-${boardId(board)}-${profile}.json`);
}

async function overlaySelection(board, profile) {
  try { return JSON.parse(await readFile(overlayFile(board, profile), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function overlayStatusSettings(profile, input) {
  if (input.reset && !configuredBoard()) return {};
  const board = requireBoard(), file = overlayFile(board, profile);
  if ('statusIds' in input) {
    if (!(input.reset === true && input.statusIds === null) && input.boardUrl !== board.href)
      throw Error('Доска изменилась. Откройте выбор статусов заново.');
    if (input.statusIds === null) {
      await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } else {
      if (!Array.isArray(input.statusIds) || input.statusIds.some(id => !Number.isSafeInteger(id) || id < 1))
        throw Error('Выберите статусы из списка.');
      const temp = file + '.' + randomUUID();
      try {
        await writeFile(temp, JSON.stringify([...new Set(input.statusIds)]), {mode:0o600});
        await rename(temp, file);
      } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    return {};
  }
  const api = await taskEditor(profile);
  return {boardUrl:board.href, statuses:await boardStatuses(boardReader(api)), selected:await overlaySelection(board, profile)};
}

export async function overlayTaskBoard(profile) {
  const api = await savedApi(profile);
  if (!api) return {configured:false};
  const [{user, tasks}, selected] = await Promise.all([assignedBoardTasks(api), overlaySelection(api.board, profile)]);
  return {configured:true, boardUrl:api.board.href, user, selected,
    tasks:tasks.map(({id, subject, project, status, status_id, closed, due_date, url}) =>
      ({id, subject, project, status, status_id, closed, due_date, url}))};
}

export async function assignedTaskBoard(profile, { offset, closed, account_id, overlay }) {
  const api = await savedApi(profile);
  if (!api) return { configured: false };
  const selected = overlay ? await overlaySelection(api.board, profile) : null;
  return {configured:true, ...await assignedPage(api, 50, offset, closed, account_id, selected)};
}

export async function assignedPage(api, limit, offset, closed, accountId, selected = null) {
  if (!Number.isSafeInteger(offset) || offset < 1 || typeof closed !== 'boolean') throw Error('Укажите страницу доски.');
  const {user, tasks} = await assignedBoardTasks(api, accountId);
  const matches = tasks.filter(task => selected === null ? task.closed === closed : selected.includes(task.status_id));
  return {user, total:matches.length, more:offset * limit < matches.length, tasks:matches.slice((offset - 1) * limit, offset * limit)};
}

async function assignedBoardTasks(api, accountId) {
  const read = boardReader(api);
  const [{user, tasks}, statuses] = await Promise.all([readBoardTasks(read, accountId), boardStatuses(read)]);
  const byStatus = new Map(statuses.map(s => [s.id, s.closed]));
  return {user, tasks:tasks.filter(task => byStatus.has(task.status_id)).sort((a,b) => b.id - a.id)
    .map(task => ({...task, assignee:user.name, closed:byStatus.get(task.status_id)}))};
}

async function taskEditor(profile) {
  const api = await savedApi(profile);
  if (!api) throw new Error('Привяжите API-ключ OpenProject и обновите доску.');
  return api;
}

async function assignedCard(api, { id, account_id }) {
  const path = taskPath(id);
  const [me, card] = await Promise.all([api('/api/v3/users/me'), api(path)]);
  if (identity(me).id !== account_id || card.id !== id || card._links?.assignee?.href !== `/api/v3/users/${account_id}`)
    throw new Error('Аккаунт или исполнитель задачи изменился. Обновите доску.');
  return card;
}

function taskUrl(api, id) {
  const board = api.board ?? configuredBoard();
  return board && new URL('/work_packages/' + id, board).href;
}

function cardDetails(card, api) {
  const links = card._links;
  return {id:card.id,url:taskUrl(api, card.id),subject:card.subject,description:card.description?.raw || '',descriptionHtml:card.description?.html || '',version:card.lockVersion,
    project:(links.project || links.workspace)?.title,status:links.status?.title,type:links.type?.title,
    assignee:links.assignee?.title,priority:links.priority?.title,due:card.dueDate || card.date,
    editable:Number.isSafeInteger(card.lockVersion) && Boolean(links.update || links.updateImmediately),
    commentable:Boolean(links.addComment?.href)};
}

export async function assignedDevelopmentTask(api, values, requireOpen = false, includeDiscussion = false) {
  const card = await assignedCard(api, values);
  if (requireOpen) {
    const status = await api(card._links.status.href);
    if (status.isClosed !== false) throw Error('Для запуска нужна открытая задача OpenProject.');
  }
  const task = {...cardDetails(card, api), updated_at:card.updatedAt};
  if (!includeDiscussion) return task;
  const comments = new Map();
  const activities = new Map();
  const seen = new Set();
  const path = taskPath(card.id)+'/activities';
  for (let offset = 1; ; offset++) {
    const page = await api(path, {offset,pageSize:100});
    const entries = page._embedded?.elements;
    if (!Array.isArray(entries)) throw Error('OpenProject не вернул обсуждение задачи.');
    const previousSize = seen.size;
    for (const entry of entries) {
      if (!Number.isSafeInteger(entry.id) || entry.id < 1) throw Error('OpenProject не вернул ID события задачи.');
      seen.add(entry.id);
      if (entry.internal) activities.delete(entry.id);
      else if (entry._links?.attachments?.href || entry._embedded?.attachments)
        activities.set(entry.id,entry);
      if (entry.internal || !entry.comment?.raw?.trim()) {
        comments.delete(entry.id);
        continue;
      }
      const {id,author,text} = commentDetails(entry);
      comments.set(id,`#${id} ${author}: ${text.trim()}`);
    }
    const more = page._links?.nextByOffset?.href || offset * (page.pageSize || 100) < page.total;
    if (!more) break;
    if (seen.size === previousSize) throw Error('OpenProject не вернул следующую страницу обсуждения.');
  }
  task.comments = [...comments].sort(([a],[b]) => a-b).map(([,text]) => text);
  const attachments = new Map();
  async function collect(resource,path,commentId) {
    const embedded = resource._embedded?.attachments;
    let items = embedded?._embedded?.elements ?? embedded;
    if (!Array.isArray(items) || (embedded.total ?? 0) > items.length)
      items = (await api(path))._embedded?.elements;
    if (!Array.isArray(items)) throw Error('OpenProject не вернул список вложений.');
    for (const file of items) {
      if (!Number.isSafeInteger(file.id) || file.id < 1) continue;
      attachments.set(file.id,{id:file.id,name:file.fileName || file.title || 'Файл',size:file.fileSize ?? file.filesize,
        ...(commentId ? {commentId} : {})});
    }
  }
  await collect(card,taskPath(card.id)+'/attachments');
  for (const [id,activity] of activities) await collect(activity,'/api/v3/activities/'+id+'/attachments',id);
  task.attachments = [...attachments.values()].sort((a,b)=>a.id-b.id);
  task.readAttachment = (id,fileLimit) => {
    if (!attachments.has(id)) throw Error('Файл отсутствует в материалах задачи.');
    return api('/api/v3/attachments/'+id+'/content',{}, {fileLimit});
  };
  return task;
}

export async function readAssignedDevelopmentTask(profile, values, requireOpen = false, includeDiscussion = false) {
  return assignedDevelopmentTask(await taskEditor(profile), values, requireOpen, includeDiscussion);
}

function commentDetails(entry) {
  return {id:entry.id,author:entry._links?.user?.title || entry._embedded?.user?.name || 'Участник',
    at:entry.createdAt,text:entry.comment?.raw || '',html:entry.comment?.html || '',internal:entry.internal === true};
}

export async function taskCardAction(api, command, values) {
  const card = await assignedCard(api,values);
  const path = taskPath(card.id), detail = cardDetails(card, api);
  if (command === 'task-detail') return detail;
  if (command === 'task-comments') {
    const offset = values.offset ?? 1;
    if (!Number.isSafeInteger(offset) || offset < 1) throw Error('Неверная страница обсуждения.');
    const page = await api(path+'/activities',{offset,pageSize:100});
    const entries = page._embedded?.elements;
    if (!Array.isArray(entries)) throw Error('OpenProject не вернул обсуждение.');
    return {items:entries.filter(entry => entry.comment?.raw?.trim()).map(commentDetails),
      more:Boolean(page._links?.nextByOffset?.href)};
  }
  if (command === 'task-comment') {
    if (!detail.commentable) throw Error('У этого аккаунта нет права добавлять комментарии.');
    if (typeof values.text !== 'string' || !values.text.trim()) throw Error('Введите комментарий.');
    const saved = await api(path+'/activities',{}, {method:'POST',body:{comment:{raw:values.text.trim()}}});
    if (!Number.isSafeInteger(saved.id) || !saved.comment?.raw) throw Error('Обновите обсуждение, чтобы проверить отправку комментария.');
    return commentDetails(saved);
  }
  if (!detail.editable) throw Error('У этого аккаунта нет права редактировать задачу.');
  if (command === 'task-fields') {
    const form = await api(path+'/form',{}, {method:'POST',body:{lockVersion:card.lockVersion}});
    const schema = form._embedded?.schema;
    return {...detail,fields:['subject','description'].filter(key => schema?.[key]?.writable === true)};
  }
  if (command !== 'task-edit') throw Error('Неизвестное действие с задачей.');
  if (values.version !== card.lockVersion) throw Error('Задачу изменили. Обновите карточку и проверьте правки.');
  const body = {lockVersion:card.lockVersion};
  if ('subject' in values) {
    if (typeof values.subject !== 'string' || !values.subject.trim()) throw Error('Введите название задачи.');
    body.subject = values.subject.trim();
  }
  if ('description' in values) {
    if (typeof values.description !== 'string') throw Error('Проверьте описание задачи.');
    body.description = {raw:values.description};
  }
  if (Object.keys(body).length === 1) return detail;
  const saved = await api(path,{}, {method:'PATCH',body});
  if (saved.id !== card.id || !Number.isSafeInteger(saved.lockVersion)) throw Error('Обновите карточку, чтобы проверить изменения.');
  return cardDetails(saved, api);
}

export async function assignedTaskAction(profile,command,values) {
  return taskCardAction(await taskEditor(profile),command,values);
}

export async function taskWorkflow(api, values) {
  const card = await assignedCard(api,values);
  const path = taskPath(card.id);
  if (!Number.isSafeInteger(card.lockVersion) || !(card._links.update || card._links.updateImmediately))
    throw new Error('У этого аккаунта нет права редактировать задачу.');
  const form = await api(`${path}/form`, {}, { method: 'POST', body: { lockVersion: card.lockVersion } });
  const field = form._embedded?.schema?.status;
  let options = field?._embedded?.allowedValues;
  if (field?.writable === false) options = [];
  if (!Array.isArray(options)) {
    const allowed = field?._links?.allowedValues;
    if (Array.isArray(allowed)) {
      const permitted = new Set(allowed.map(link => link.href));
      options = (await api('/api/v3/statuses'))._embedded?.elements?.filter(item => permitted.has(item._links?.self?.href));
    } else if (allowed?.href) options = (await api(allowed.href))._embedded?.elements;
  }
  if (!Array.isArray(options)) throw new Error('OpenProject не вернул доступные статусы.');
  return { version: card.lockVersion, current: card._links.status?.title, options: options
    .filter(item => Number.isSafeInteger(item.id) && item.id > 0 && `/api/v3/statuses/${item.id}` !== card._links.status?.href)
    .map(item => ({ id: item.id, name: item.name, closed: item.isClosed === true })) };
}

export async function assignedTaskWorkflow(profile, values) {
  return taskWorkflow(await taskEditor(profile), values);
}

export async function applyBoardTransition(api, values, beforeWrite) {
  const { version, options } = await taskWorkflow(api, values);
  if (values.version !== version) throw new Error('Задачу изменили. Обновите доску и выберите статус заново.');
  const option = options.find(item => item.id === values.status_id);
  if (!option) throw new Error('Переход в этот статус больше недоступен.');
  beforeWrite?.();
  return applyOpenProjectStatus(api, { id: values.id, next: option.name,
    body: { lockVersion: version, _links: { status: { href: `/api/v3/statuses/${option.id}` } } } });
}

export async function updateAssignedTaskStatus(profile, values, beforeWrite) {
  return applyBoardTransition(await taskEditor(profile), values, beforeWrite);
}

export function loginOpenProject() {
  return withOpenProject(true, async (tab, get) => {
    const deadline = Date.now() + 5 * 60_000;
    while (!tab.isClosed() && Date.now() < deadline) {
      try {
        const user = identity(await get('/api/v3/users/me'));
        await get(`/api/v3/grids/${boardId(get.board)}`);
        return { user, board: get.board.href };
      } catch (error) {
        if (tab.isClosed()) break;
        if (error.status !== 401 && !/navigation|context was destroyed/i.test(error.message)) throw error;
      }
      await delay(2000);
    }
    throw new Error('Окно входа OpenProject закрыто или истекло время ожидания.');
  });
}

// filters replaces all saved conditions. Only refine a column when OpenProject
// supplies its complete filter list and it has no assignee condition of its own.
function columnAssigneeFilter(page, board, userId) {
  const href = page._links?.self?.href;
  if (!href || !URL.canParse(href, board)) return;
  const url = new URL(href, board);
  if (url.origin !== board.origin || url.searchParams.has('eprops')) return;
  let filters;
  try { filters = JSON.parse(url.searchParams.get('filters')); } catch { return; }
  if (!Array.isArray(filters) || filters.some(filter => !filter || typeof filter !== 'object' ||
    Object.keys(filter).some(key => /^(assignee|assigned_to|assignedTo)(Id|_id)?$/i.test(key)))) return;
  return JSON.stringify([...filters, {assignee:{operator:'=', values:[String(userId)]}}]);
}

async function readColumn(get, widget, userId) {
  const {origin} = get.board;
  const queryId = Number(widget.options?.queryId);
  if (!Number.isSafeInteger(queryId) || queryId < 1) throw new Error('У колонки доски отсутствует ID запроса.');
  const matches = [];
  let read = 0, offset = 1, filters, triedFilter = false;
  for (;;) {
    // OpenProject pins manually ordered queries to their first page.
    const params = {pageSize:filters ? 100 : 50, offset, sortBy:JSON.stringify([['id', 'asc']])};
    if (filters) params.filters = filters;
    let query;
    try { query = await get(`/api/v3/queries/${queryId}`, params); }
    catch (error) {
      if (!filters || ![400, 414, 422].includes(error.status)) throw error;
      filters = undefined; offset = 1; read = 0; matches.length = 0;
      continue;
    }
    const page = query._embedded?.results;
    const cards = page?._embedded?.elements;
    if (!Array.isArray(cards)) throw new Error('OpenProject не вернул карточки колонки.');
    if (page.offset != null && page.offset !== offset) throw Error('OpenProject вернул неверную страницу колонки.');
    if (offset === 1 && !triedFilter && cards.length > 0 && page.total > cards.length) {
      triedFilter = true;
      filters = columnAssigneeFilter(page, get.board, userId);
      if (filters) continue;
    }
    for (const card of cards) {
      if (card._links?.assignee?.href !== `/api/v3/users/${userId}`) continue;
      matches.push({
        id: card.id, subject: card.subject, status: card._links?.status?.title,
        status_id: Number(card._links.status?.href?.split('/').at(-1)),
        version:card.lockVersion, updated_at:card.updatedAt, assignee:card._links.assignee.title,
        project:(card._links.project ?? card._links.workspace)?.title, editable:Boolean(card._links.update || card._links.updateImmediately),
        priority: card._links?.priority?.title, due_date: card.dueDate ?? card.date ?? null,
        url: `${origin}/work_packages/${card.id}`, column: query.name,
      });
    }
    read += cards.length;
    if (!cards.length || read >= page.total) return matches;
    offset++;
  }
}

async function readBoardTasks(get, accountId) {
  const [current, grid] = await Promise.all([get('/api/v3/users/me'), get(`/api/v3/grids/${boardId(get.board)}`)]);
  const user = identity(current);
  if (accountId != null && user.id !== accountId) throw Error('Аккаунт OpenProject изменился. Обновите доску.');
  if (grid.id !== boardId(get.board) || !Array.isArray(grid.widgets)) throw new Error('OpenProject не вернул настройки выбранной доски.');
  const columns = grid.widgets.filter(widget => widget.identifier === 'work_package_query');
  const grouped = await Promise.all(columns.map(widget => readColumn(get, widget, user.id)));
  const byId = new Map();
  for (const card of grouped.flat()) {
    const { column, ...task } = card;
    if (byId.has(task.id)) byId.get(task.id).columns.push(column);
    else byId.set(task.id, { ...task, columns: [column] });
  }
  return { board:get.board.href, user, total:byId.size, tasks:[...byId.values()] };
}

export function myBoardTasks(limit = 50, profile) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Ожидается количество задач от 1 до 100.');
  return readWithProfile(profile, async get => {
    const result = await readBoardTasks(get);
    return {...result, tasks:result.tasks.slice(0, limit)};
  });
}

function assignmentReply(card, me) {
  const id = card.id;
  const assignee = card._links?.assignee?.href;
  if (!me || (assignee !== null && !/^\/api\/v3\/(?:users|groups)\/[1-9]\d*$/.test(assignee)))
    return `Задача #${id} есть, но проверить исполнителя сейчас не удалось.`;
  if (assignee === `/api/v3/users/${me.id}`) return `Задача #${id} назначена на меня.`;
  const who = assignee === null ? 'пока без исполнителя' : 'назначена на другого исполнителя';
  return `Задача #${id} ${who}.`;
}

export async function linkedTaskPreview(get, id) {
  let card;
  try { card = await get(taskPath(id)); }
  catch (error) {
    if (error.status === 404) return { error: `Не вижу задачу #${id} по этой ссылке. Проверь, пожалуйста, ссылку и доступ к карточке.` };
    if (error.status === 403) return { error: `У меня нет доступа к задаче #${id}. Проверь, пожалуйста, доступ к карточке.` };
    throw error;
  }
  if (card?.id !== id) throw new Error('OpenProject не вернул карточку по ссылке.');
  const me = await get('/api/v3/users/me').then(identity).catch(() => undefined);
  const title = `#${id} · ${String(card.subject ?? 'Задача').slice(0, 150)}`;
  const details = [
    card._links?.status?.title && `Статус: ${card._links.status.title}`,
    card._links?.assignee?.title && `Исполнитель: ${card._links.assignee.title}`,
    (card.dueDate ?? card.date) && `Срок: ${card.dueDate ?? card.date}`,
    card.description?.raw,
  ].filter(Boolean).join('\n\n');
  return { title, text: details.slice(0, 12000), assignment:assignmentReply(card, me) };
}

export function openProjectLink(url, profile, enabled = true) {
  const id = urlTask(url);
  if (!id) return undefined;
  const unavailable = { error: `Не удалось проверить задачу #${id} в OpenProject с моего аккаунта.` };
  if (!enabled) return Promise.resolve(unavailable);
  return savedApi(profile).then(get => get ? linkedTaskPreview(get, id) : unavailable).catch(() => unavailable);
}
