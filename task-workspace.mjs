import { projectBaseBranches } from './workspace-settings.mjs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const preparing = new Map();

function pathKey(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

const areas = [
  ['client', /^(?:клиент|frontend|front$|client)/u],
  ['server', /^(?:сервер|backend|server|бэкенд|бэкинд)/u],
  ['forum', /^(?:форум|forum)/u],
];

function words(text) {
  return String(text ?? '').toLowerCase().replaceAll('ё','е').match(/[\p{L}\d]+/gu) ?? [];
}

function mentionedAreas(text) {
  const tokens = words(text);
  return areas.filter(([,pattern]) => tokens.some(word => pattern.test(word))).map(([name]) => name);
}

// A distinct repository name can identify multiple custom components or resolve
// which of several repositories for the same component was explicitly requested.
function mentionsName(content, name) {
  const tokens = words(name);
  const generic = /^(?:клиент|сервер|форум|проект|папка|client|server|frontend|backend|forum|project)$/u;
  return tokens.some(word => word.length >= 3 && !generic.test(word)) &&
    (' ' + content.join(' ') + ' ').includes(' ' + tokens.join(' ') + ' ');
}

// Treat only an explicit instruction about a whole component as a scope
// exclusion. Bug reports such as «форум не открывается» remain requirements.
function taskScope(text, names) {
  const included = [], excluded = [];
  const exclusion = /(?:^|\s)(?:без\s+(?:изменений|правок)|не\s+(?:менять|изменять|трогать|затрагивать))(?=$|\s)/iu;
  const subjects = new Set(names.map(name => words(name).join(' ')).filter(Boolean));
  function componentList(fragment) {
    return fragment.trim().split(/\s+(?:и|and)\s+/iu).every(part => {
      const tokens = words(part).filter(token => !/^(?:в|на|для|проекте|проект|репозитории|репозиторий)$/u.test(token));
      return tokens.length && (subjects.has(tokens.join(' ')) || tokens.every(word =>
        areas.some(([,pattern]) => pattern.test(word))));
    });
  }
  for (const clause of text.split(/[.!?;,\n]+/u)) {
    const match = exclusion.exec(clause);
    if (match) {
      const before = clause.slice(0,match.index).trim(), after = clause.slice(match.index + match[0].length).trim();
      if (after && componentList(after)) { included.push(before); excluded.push(after); continue; }
      if (!after && componentList(before)) { excluded.push(before); continue; }
    }
    included.push(clause);
  }
  return {included:included.join('\n'),excluded:excluded.join('\n')};
}

// Repository ownership and the decision to do development work are independent.
// Only positive evidence from the requested work can enable an automatic start.
export function developmentScope(task, settings) {
  const text = [task.subject,task.description].join('\n').replace(/https?:\/\/[^\s<>]+/giu,' ');
  const clauses = text.split(/[.!?;\n]+|(?:,\s*|\s+и\s+)(?=(?:исправить|реализовать|добавить|сделать|обновить|поменять|опубликовать|согласовать)\s)/iu);
  const coordination = /(?:^|[^\p{L}])(?:организовать|согласовать|обсудить|договориться|созвониться|проверить доступ|узнать у|собрать отзывы|schedule a meeting)(?=\s|$)/iu;
  const editorial = /(?:опубликовать|подготовить|разместить|выпустить|написать|отредактировать|обновить)\s+(?:(?:свеж|нов)\S*\s+)*(?:новост|анонс|пост(?:ы|а|ов)?(?:\s|$)|стать|материал|отч[её]т)|публикация новостей|publish (?:a |the )?(?:post|news)/iu;
  const engineering = /(?:^|[^\p{L}])(?:отрефакторить|refactor|bug|баг|регресси[яю]|падает|вылетает|зависает)(?=$|[^\p{L}])|не (?:работает|открывается|загружается|сохраняется|отображается)/iu;
  const repair = /(?:исправить|починить|реализовать|доработать|fix|implement)/iu;
  const change = /(?:добав|обнов|измен|замен|поменя|показ|сдела|вывест|убра|удал|скры|перенес|созда|написа|настро|подключ|add|update|change|remove)/iu;
  const artifact = /(?:кнопк|интерфейс|настройк|экран|компонент|заголовок|страниц|отступ|форму|модул|обработчик|миграци|эндпоинт|локализаци|выбор языка|рендер|сборк|виджет|функци|скрипт|автотест|\b(?:api|ui|css|html|button|screen|endpoint|component)\b)/iu;
  const productRepair = /(?:исправить|починить|доработать|доработка|правки)\s+(?:ошибк|клиент|форум|сервер|модул|сервис)/iu;
  const requirements = [];
  let heading = '', excluded = false, hasRequirement = false;
  for (const clause of clauses.map(line => line.trim()).filter(Boolean)) {
    if (coordination.test(clause) || editorial.test(clause)) {
      heading = '';
      excluded = true;
    } else if (/^(?:[-*]\s*)?(?:без (?:изменений|правок)|не (?:нужно |надо |требуется )?(?:менять|изменять|добавлять|исправлять|дорабатывать|трогать))/iu.test(clause)) {
      if (taskScope(clause,(settings.folders ?? []).map(folder => basename(folder))).excluded) requirements.push(clause);
      heading = '';
    } else if (engineering.test(clause) || productRepair.test(clause) ||
        ((change.test(clause) || repair.test(clause)) && artifact.test(clause))) {
      requirements.push(heading,clause);
      hasRequirement = true;
      heading = '';
    } else if (/без (?:изменений|правок)|не (?:менять|трогать|затрагивать)/iu.test(clause)) {
      requirements.push(clause);
    } else {
      // A short component heading can supply the repository for the following requirement.
      heading = words(clause).length <= 4 ? clause : '';
    }
  }
  if (hasRequirement)
    return selectTaskFolders({...task,subject:'',description:requirements.join('\n')},settings);
  return {folders:[],candidates:[],excluded,reason:excluded
    ? 'В задаче указана организационная работа. Запуск в Codex не требуется.'
    : 'По карточке неясно, нужны ли изменения в репозитории. Для ручного запуска выберите проект.'};
}

export function selectTaskFolders(task, settings) {
  const folders = settings.folders ?? [];
  const text = [task.subject,task.description].join('\n').replace(/https?:\/\/[^\s<>]+/giu,' ');
  const names = folders.flatMap(folder => [basename(folder),settings.folderDescriptions?.[folder]]);
  const scope = taskScope(text,names);
  const content = words(scope.included), exclusions = words(scope.excluded);
  const excludedAreas = new Set(mentionedAreas(scope.excluded));
  const requestedAreas = mentionedAreas(scope.included).filter(area => !excludedAreas.has(area));
  const rows = folders.flatMap(folder => {
    const name = basename(folder), description = settings.folderDescriptions?.[folder] ?? '';
    const metadata = name + '\n' + description;
    const roles = mentionedAreas(metadata);
    if (mentionsName(exclusions,name) || mentionsName(exclusions,description) || (roles.length && roles.every(area => excludedAreas.has(area)))) return [];
    return [{folder,areas:roles,explicit:mentionsName(content,name) || mentionsName(content,description)}];
  });
  const available = rows.map(row => row.folder);
  if (exclusions.length && !content.length) return {folders:[],candidates:available,reason:'В задаче указаны только исключения.'};
  const selected = new Set(rows.filter(row => row.explicit).map(row => row.folder));
  let ambiguous = false;
  for (const area of requestedAreas) {
    const matches = rows.filter(row => row.areas.includes(area));
    if (!matches.length) return {folders:[],candidates:available,reason:'Для части задачи не удалось определить папку по настройкам проектов.'};
    if (matches.length === 1) selected.add(matches[0].folder);
    else if (!matches.some(row => row.explicit)) ambiguous = true;
  }
  if (ambiguous) {
    const candidates = rows.filter(row => row.explicit || row.areas.some(area => requestedAreas.includes(area))).map(row => row.folder);
    return {folders:[],candidates,reason:'Для одной части задачи подходят несколько репозиториев.'};
  }
  const resolved = folders.filter(folder => selected.has(folder));
  if (resolved.length) return {folders:resolved,candidates:resolved,reason:''};
  return {folders:[],candidates:available,reason:'По описанию задачи не удалось однозначно определить репозитории.'};
}

export function selectTaskFolder(task, settings, explicitFolder) {
  if (explicitFolder != null) {
    const folder = settings.folders?.find(path => typeof explicitFolder === 'string' && pathKey(path) === pathKey(explicitFolder));
    if (!folder) throw Error('Выбранная папка больше не указана в настройках проектов Пачки.');
    return {folder,candidates:[folder]};
  }
  const {folders,candidates} = selectTaskFolders(task,settings);
  return {folder:folders.length === 1 ? folders[0] : null,candidates};
}

export function taskBranchName(id) {
  if (!Number.isSafeInteger(id) || id < 1) throw Error('Нужен номер задачи OpenProject.');
  return `features/${id}_task`;
}

async function git(folder, args, signal) {
  const {stdout} = await exec('git', ['-C',folder,...args], {
    signal, timeout:90000, maxBuffer:4*1024*1024, windowsHide:true,
    env:{...process.env,LC_ALL:'C',GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'},
  });
  return stdout.trimEnd();
}

async function localBranches(run) {
  return new Set((await run('for-each-ref','--format=%(refname:lstrip=2)','refs/heads')).split('\n').filter(Boolean));
}

export async function taskBranchExists(folder,branch,signal) {
  return (await localBranches((...args) => git(folder,args,signal))).has(branch);
}

async function checkouts(run) {
  return (await run('worktree','list','--porcelain','-z')).split('\0\0').filter(Boolean).map(record => {
    const lines = record.split('\0');
    return {cwd:lines[0].slice('worktree '.length),branch:lines.find(line => line.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length)};
  });
}

async function remoteBranches(run,remote,branches) {
  const output = await run('ls-remote','--symref','--',remote,'HEAD',...branches.map(branch => 'refs/heads/'+branch));
  const heads = new Set(), prefix = 'refs/heads/';
  let defaultBranch;
  for (const line of output.split('\n')) {
    const [value,ref] = line.split('\t');
    if (ref === 'HEAD' && value.startsWith('ref: '+prefix)) defaultBranch = value.slice(5+prefix.length);
    if (ref?.startsWith(prefix)) heads.add(ref.slice(prefix.length));
  }
  return {remote,heads,defaultBranch};
}

const worktreeMarker = '# Managed by Pachca AI\n*\n';

async function optionalStat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function prepareProjectDirectory(projectRoot, parent, create, signal) {
  const managed = join(projectRoot,'.pachca-worktrees');
  // The selected Codex project may be outside Git, or inside a different repository.
  let gitRoot;
  try { gitRoot = await git(projectRoot,['rev-parse','--show-toplevel'],signal); }
  catch (error) { if (!/not a git repository/i.test(error.stderr || '')) throw error; }
  if (gitRoot && await git(gitRoot,['--literal-pathspecs','ls-files','--',relative(gitRoot,managed)],signal))
    throw Error('Служебная папка .pachca-worktrees содержит файлы, отслеживаемые Git.');
  let created = false;
  if (create) {
    try { await mkdir(managed); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const top = await optionalStat(managed);
  if (!top?.isDirectory() || top.isSymbolicLink()) throw Error('Недоступна служебная папка .pachca-worktrees.');
  const marker = join(managed,'.gitignore');
  if (created) await writeFile(marker,worktreeMarker,{flag:'wx'});
  else {
    // Another task may have just won mkdir and be writing the marker.
    let info = await optionalStat(marker);
    for (let i=0; create && (!info || (info.isFile() && info.size === 0)) && i<3; i++) {
      await delay(40,undefined,{signal});
      info = await optionalStat(marker);
    }
    if (!info?.isFile() || info.size !== Buffer.byteLength(worktreeMarker) || await readFile(marker,'utf8') !== worktreeMarker)
      throw Error('Папка .pachca-worktrees уже существует и не принадлежит Пачке.');
  }
  let current = managed;
  for (const part of relative(managed,parent).split(sep)) {
    current = join(current,part);
    if (create) {
      try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const entry = await optionalStat(current);
    if (!entry?.isDirectory() || entry.isSymbolicLink()) throw Error('Путь к рабочей копии содержит ссылку или недоступную папку.');
  }
}

async function prepare(folder, id, {directory,baseBranch,signal,projectRoot,existingOnly = false,newChat = Boolean(projectRoot),replacement = false}) {
  const preferred = taskBranchName(id), legacy = 'features/'+id;
  if (!isAbsolute(directory)) throw Error('Нужна абсолютная папка для рабочих копий.');
  if (newChat && !projectRoot) throw Error('Для нового чата задачи выберите локальный проект Codex.');
  const configured = await realpath(folder);
  const root = await realpath(await git(configured,['rev-parse','--show-toplevel'],signal));
  const run = (...args) => git(root,args,signal);
  const common = await realpath(await run('rev-parse','--path-format=absolute','--git-common-dir'));
  const hash = createHash('sha256').update(pathKey(common)).digest('hex').slice(0,20);
  const worktrees = await checkouts(run);
  const legacyDestination = join(directory,hash,String(id));
  const useLegacy = !replacement && newChat === false && worktrees.some(item => pathKey(item.cwd) === pathKey(legacyDestination) && [preferred,legacy].includes(item.branch));
  const allowed = [preferred,legacy];
  const replacementBranch = preferred+'-desktop';
  if (replacement) allowed.push(replacementBranch);
  let worktreeDirectory = directory, desktop, oldProjectCheckout, desktopSlot;
  if (projectRoot && !useLegacy) {
    const profile = basename(dirname(directory)), account = basename(directory);
    if (!isAbsolute(projectRoot) || !/^\d+$/.test(profile) || !/^\d+$/.test(account))
      throw Error('Проверьте папку проекта Codex и привязку аккаунта.');
    desktop = await realpath(projectRoot);
    if (pathKey(desktop) !== pathKey(projectRoot)) throw Error('Папка проекта Codex указывает на другой путь через ссылку.');
    const accountArea = join(desktop,'.pachca-worktrees',profile,account);
    const oldParent = join(accountArea,hash);
    oldProjectCheckout = worktrees.find(item => allowed.includes(item.branch) &&
      pathKey(dirname(item.cwd)) === pathKey(oldParent) && new RegExp('^'+id+'(?:-r[1-9][0-9]*)?$').test(basename(item.cwd)));
    const modern = join(accountArea,'.codex-workspaces','worktrees');
    const slotName = hash+'-'+id;
    const modernCheckout = worktrees.find(item => allowed.includes(item.branch) &&
      pathKey(dirname(dirname(item.cwd))) === pathKey(modern) &&
      basename(item.cwd) === basename(root) && new RegExp('^'+slotName+'(?:-r[1-9][0-9]*)?$').test(basename(dirname(item.cwd))));
    if (!newChat && oldProjectCheckout && !modernCheckout) worktreeDirectory = accountArea;
    else {
      // Desktop recognises linked checkouts here and groups them by their Git
      // origin/common directory. Its tie-breaker compares checkout root names.
      worktreeDirectory = modern;
      desktopSlot = modernCheckout ? basename(dirname(modernCheckout.cwd)) : slotName;
    }
  }
  let destination = join(worktreeDirectory,hash,String(id));
  // A deleted branch can leave its managed checkout detached, possibly with local edits.
  // Keep that checkout and use a sibling for the replacement and subsequent resumes.
  if (desktopSlot) {
    const checkoutName = basename(root);
    destination = join(worktreeDirectory,desktopSlot,checkoutName);
    for (let generation=1; worktrees.some(item => pathKey(item.cwd) === pathKey(destination) && !item.branch); generation++)
      destination = join(worktreeDirectory,desktopSlot+'-r'+generation,checkoutName);
  } else if (desktop) {
    destination = oldProjectCheckout.cwd;
  }
  const fromRoot = relative(root,destination);
  if (!desktop && !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith('..'+sep))
    throw Error('Папка рабочих копий должна находиться за пределами исходного репозитория.');
  const configuredSubdir = relative(root,configured);
  async function result(branch) {
    if (pathKey(await realpath(destination)) !== pathKey(destination))
      throw Error('Рабочая копия указывает на другой путь через ссылку.');
    const top = await git(destination,['rev-parse','--show-toplevel'],signal);
    if (pathKey(top) !== pathKey(destination)) throw Error('По пути задачи нет отдельной рабочей копии Git.');
    const currentCommon = await realpath(await git(destination,['rev-parse','--path-format=absolute','--git-common-dir'],signal));
    if (pathKey(currentCommon) !== pathKey(common)) throw Error('Рабочая копия задачи принадлежит другому репозиторию.');
    const actual = await git(destination,['symbolic-ref','--quiet','HEAD'],signal);
    if (actual !== 'refs/heads/'+branch) throw Error('В рабочей копии задачи изменилась ветка. Проверьте её перед продолжением.');
    const cwd = join(destination,configuredSubdir);
    if (!(await stat(cwd)).isDirectory() || pathKey(await realpath(cwd)) !== pathKey(cwd))
      throw Error('Папка проекта отсутствует в ветке задачи или указывает на другой путь.');
    return {folder,branch,cwd,worktreeDirectory};
  }
  const existing = worktrees.find(item => pathKey(item.cwd) === pathKey(destination));
  if (existing) {
    if (!allowed.includes(existing.branch)) throw Error('Рабочую копию задачи занимает другая ветка.');
    if (desktop) await prepareProjectDirectory(desktop,dirname(destination),false,signal);
    return result(existing.branch);
  }
  if (existingOnly) throw Error('Рабочая копия сохранённого чата не найдена.');
  const local = await localBranches(run);
  let branch = preferred, start, track = false;
  if (!local.has(preferred)) {
    const remoteNames = (await run('remote')).split('\n').filter(Boolean);
    const requestedBase = baseBranch || projectBaseBranches[basename(root).toLowerCase()];
    if (requestedBase) await run('check-ref-format','refs/heads/'+requestedBase);
    const remotes = await Promise.all(remoteNames.map(name =>
      remoteBranches(run,name,[preferred,legacy,requestedBase || 'main','master'])));
    const mainRemote = remotes.find(row => row.remote === 'origin') ?? remotes[0];
    function sourceFor(name) {
      const matches = remotes.filter(row => row.heads.has(name));
      if (matches.length > 1 && !matches.includes(mainRemote)) throw Error(`Ветка ${name} найдена на нескольких Git-серверах.`);
      return matches.includes(mainRemote) ? mainRemote : matches[0];
    }
    let source = sourceFor(preferred);
    if (!source && (local.has(legacy) || sourceFor(legacy))) {
      branch = legacy;
      source = sourceFor(legacy);
    }
    if (!local.has(branch)) {
      let from = branch;
      if (source) track = true;
      else {
        from = requestedBase || mainRemote?.defaultBranch || ['main','master'].find(name => local.has(name) || mainRemote?.heads.has(name));
        if (!from) throw Error('Не удалось определить основную ветку Git. Настройте HEAD в удалённом репозитории.');
        source = mainRemote?.heads.has(from) || mainRemote?.defaultBranch === from ? mainRemote : undefined;
      }
      if (source) {
        start = `refs/remotes/${source.remote}/${from}`;
        await run('fetch','--no-tags','--no-recurse-submodules','--',source.remote,`+refs/heads/${from}:${start}`);
      } else {
        if (!local.has(from)) throw Error(`Основная ветка ${from} не найдена.`);
        start = 'refs/heads/'+from;
      }
    }
  }
  if (replacement && desktop && (oldProjectCheckout?.branch === branch ||
      worktrees.some(item => item.branch === branch && pathKey(item.cwd) === pathKey(legacyDestination)))) {
    if (local.has(replacementBranch)) throw Error('Ветка '+replacementBranch+' уже существует вне рабочей копии выбранного проекта.');
    start = 'refs/heads/'+branch;
    branch = replacementBranch;
    track = false;
  }
  const occupied = worktrees.find(item => item.branch === branch);
  if (occupied)
    throw Error(`Ветка ${branch} уже открыта в другой рабочей папке Git: ${occupied.cwd}. Освободите её, чтобы продолжить в отдельной копии задачи.`);
  if (desktop) await prepareProjectDirectory(desktop,dirname(destination),true,signal);
  else await mkdir(dirname(destination),{recursive:true});
  if (await optionalStat(destination)) throw Error('Папка задачи уже занята. Пачка не может создать здесь рабочую копию.');
  try {
    if (start) await run('worktree','add',track?'--track':'--no-track','-b',branch,'--',destination,start);
    else await run('worktree','add','--',destination,branch);
  } catch (error) {
    const winner = (await checkouts(run)).find(item => pathKey(item.cwd) === pathKey(destination) && item.branch === branch);
    if (!winner) throw error;
  }
  return result(branch);
}

export async function ensureTaskWorktree(folder,id,options) {
  const key = pathKey(folder)+'\0'+taskBranchName(id);
  const prior = preparing.get(key) ?? Promise.resolve();
  const pending = prior.catch(() => {}).then(() => prepare(folder,id,options));
  preparing.set(key,pending);
  try { return await pending; }
  finally { if (preparing.get(key) === pending) preparing.delete(key); }
}
