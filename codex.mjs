import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./pachca.mjs', import.meta.url));
const serverKey = 'mcp_servers.pachca_local';
export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

let lastCodex;

function* desktopCliFiles(bin) {
  yield join(bin, 'codex.exe');
  let folders;
  try { folders = readdirSync(bin, {withFileTypes:true}); }
  catch { return; }
  const versions = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const path = join(bin, folder.name);
    try { versions.push({file:join(path, 'codex.exe'), updated:statSync(path).mtimeMs}); }
    catch { /* A Desktop update may have removed this version. */ }
  }
  versions.sort((a, b) => b.updated - a.updated);
  for (const version of versions) yield version.file;
}

export function findCodex() {
  if (lastCodex && existsSync(lastCodex)) return lastCodex;
  const seen = new Set();
  let failure;
  function runnable(file) {
    if (!file || !isAbsolute(file) || basename(file).toLowerCase() !== 'codex.exe' || seen.has(file.toLowerCase()) || !existsSync(file)) return false;
    seen.add(file.toLowerCase());
    const probe = spawnSync(file, ['--version'], {encoding:'utf8', windowsHide:true, timeout:15000});
    if (probe.status === 0 && /^codex-cli\s/im.test(probe.stdout)) return true;
    if (probe.error) failure = {file, code:probe.error.code};
    return false;
  }
  const runtime = process.env.CODEX_APP_RUNTIME_CLI_PATH;
  if (runnable(runtime)) return lastCodex = runtime;
  if (process.env.LOCALAPPDATA) {
    const bin = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    for (const file of desktopCliFiles(bin)) {
      if (runnable(file)) return lastCodex = file;
    }
  }
  for (const home of [process.env.CODEX_HOME, process.env.USERPROFILE && join(process.env.USERPROFILE, '.codex')]) {
    if (!home) continue;
    const file = join(home, 'bin', 'codex.exe');
    if (runnable(file)) return lastCodex = file;
  }
  const where = spawnSync('where.exe', ['codex'], { encoding:'utf8', windowsHide:true, timeout:5000 });
  for (const path of (where.stdout ?? '').trim().split(/\r?\n/).filter(Boolean)) {
    if (runnable(path)) return lastCodex = path;
    if (!/\.cmd$/i.test(path)) continue;
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const vendor = join('vendor', (arch === 'arm64' ? 'aarch64' : 'x86_64') + '-pc-windows-msvc');
    const pkg = join(dirname(path), 'node_modules', '@openai', 'codex');
    for (const root of [pkg, join(pkg, 'node_modules', '@openai', 'codex-win32-' + arch), join(dirname(pkg), 'codex-win32-' + arch)]) {
      for (const folder of ['bin', 'codex']) {
        const file = join(root, vendor, folder, 'codex.exe');
        if (runnable(file)) return lastCodex = file;
      }
    }
  }
  const app = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; " +
    "Get-Process -Name Codex -ErrorAction SilentlyContinue | Where-Object Path | ForEach-Object { Split-Path -Parent $_.Path } | Select-Object -Unique; " +
    "Get-AppxPackage -Name 'OpenAI.*' | Where-Object { $_.Name -like 'OpenAI.Codex*' -or $_.Name -like 'OpenAI.ChatGPT*' } | Select-Object -ExpandProperty InstallLocation",
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  for (const root of (app.stdout ?? '').trim().split(/\r?\n/).filter(Boolean)) {
    for (const folder of [join(root, 'app', 'resources'), join(root, 'resources'), ...(basename(root).toLowerCase() === 'resources' ? [root] : [])]) {
      const installed = join(folder, 'codex.exe');
      if (runnable(installed)) return lastCodex = installed;
    }
  }
  if (failure) {
    const error = new Error(`Windows не смогла запустить найденный Codex CLI (${failure.code}): ${failure.file}.`);
    error.code = 'CODEX_UNAVAILABLE';
    throw error;
  }
  if (app.error || app.status !== 0 || seen.size)
    throw new Error('Не удалось определить путь к Codex. Повторите проверку подключения.');
  const error = new Error('Не найден исполняемый файл Codex в PATH и установленных приложениях Windows.');
  error.code = 'CODEX_NOT_INSTALLED';
  throw error;
}

function runLogin(executable, args, timeout, capture = false) {
  return new Promise((resolve, reject) => {
    const proc = spawn(executable, args, {
      windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore'],
      signal: AbortSignal.timeout(timeout),
    });
    let output = '';
    if (capture === 'stdout') proc.stderr.resume();
    if (capture) for (const stream of capture === 'stdout' ? [proc.stdout] : [proc.stdout, proc.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => { output = (output + chunk).slice(-4096); });
    }
    proc.once('error', reject);
    proc.once('close', code => resolve({ code, output }));
  });
}

export async function localCodexState({ connect = false, locate = findCodex } = {}) {
  let executable;
  try { executable = locate(); }
  catch (error) {
    if (error.code === 'CODEX_NOT_INSTALLED') return { state: 'missing' };
    if (error.code === 'CODEX_UNAVAILABLE') return { state: 'missing', detail:error.message };
    throw error;
  }
  const status = async () => {
    const { code, output } = await runLogin(executable, ['login', 'status'], 30_000, true);
    if (code === 0) return { state: 'ready' };
    if (/not logged in|no (?:active )?(?:login|credentials)/i.test(output)) return { state: 'signed-out' };
    throw new Error('Не удалось проверить вход в Codex. Откройте Codex и проверьте аккаунт.');
  };
  const current = await status();
  if (!connect || current.state === 'ready') return current;
  try {
    const result = await runLogin(executable, ['login'], 5 * 60_000);
    if (result.code === 0) return await status();
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
    throw new Error('Время входа в Codex истекло. Попробуйте снова.');
  }
  const after = await status();
  if (after.state === 'ready') return after;
  throw new Error('Вход в Codex не завершён. Повторите подключение или войдите в приложении Codex.');
}

export function mcpCommand() {
  const portable = process.env.PACHCA_PORTABLE === '1';
  return {
    command: portable ? join(process.env.PACHCA_INSTALL_ROOT || join(dirname(process.execPath), '..'), 'pachca.exe') : process.execPath,
    args: portable ? ['mcp'] : [script, 'mcp'],
  };
}
function entry() {
  return {
    ...mcpCommand(),
    env_vars: ['LOCALAPPDATA', 'SYSTEMROOT', 'ProgramFiles', 'ProgramFiles(x86)'],
    tool_timeout_sec: 90,
    default_tools_approval_mode: 'writes',
  };
}

export function configSnippet() {
  const config = entry();
  return [`[${serverKey}]`, ...Object.entries(config).map(([key, value]) => `${key} = ${JSON.stringify(value)}`)].join('\n');
}

export function codexConnection(executable, args = ['app-server'], observer = {}) {
  const proc = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: proc.stdout });
  const pending = new Map();
  let lastId = 0;
  let stopped;

  function fail(error) {
    if (stopped) return;
    stopped = error;
    for (const { reject } of pending.values()) reject(stopped);
    observer.onClose?.(stopped);
  }
  proc.stderr.resume();
  proc.stdin.on('error', fail);
  proc.on('error', fail);
  proc.once('close', code => fail(new Error(`Соединение с Codex закрыто (код ${code ?? '—'}).`)));
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      proc.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'User interaction is unavailable in this client.' } })}\n`);
      observer.onServerRequest?.(message.method,message.params);
      return;
    }
    if (message.method) {
      observer.onNotification?.(message.method, message.params);
      return;
    }
    const call = pending.get(message.id);
    if (!call) return;
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  });

  const write = message => proc.stdin.write(`${JSON.stringify(message)}\n`);
  return {
    request(method, params) {
      if (stopped) return Promise.reject(stopped);
      const id = ++lastId;
      let timer;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`Codex не ответил на ${method}.`)), 20_000);
        write({ id, method, params });
      }).finally(() => {
        clearTimeout(timer);
        pending.delete(id);
      });
    },
    notify(method) { write({ method, params: {} }); },
    close() { proc.stdin.end(); lines.close(); },
  };
}

export async function connectCodex(enabled = true) {
  const connection = codexConnection(findCodex());
  try {
    await connection.request('initialize', { clientInfo: { name: 'pachca_local_setup', version: '0.2.1' } });
    connection.notify('initialized');
    await connection.request('config/batchWrite', {
      edits: Object.entries(enabled ? { ...entry(), enabled } : { enabled }).map(([key, value]) => ({ keyPath: `${serverKey}.${key}`, value, mergeStrategy: 'upsert' })),
    });
  } finally {
    connection.close();
  }
}

const linkFile = () => join(process.env.LOCALAPPDATA, 'PachcaWebClient', 'agent-link.json');
export async function readAgentLink() {
  try { return JSON.parse(await readFile(linkFile(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function saveAgentLink(value) {
  const file = linkFile(), temp = file + '.' + randomUUID();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, file);
}
export async function codexMcpEnabled() {
  const {code, output} = await runLogin(findCodex(), ['mcp','get','pachca_local','--json'], 10000, 'stdout');
  if (code) return false;
  const result = JSON.parse(output);
  const config = entry();
  return result.enabled === true && result.transport?.command?.toLowerCase() === config.command.toLowerCase()
    && JSON.stringify(result.transport.args) === JSON.stringify(config.args);
}

export async function listCodexModels() {
  const connection = codexConnection(findCodex());
  try {
    await connection.request('initialize', { clientInfo: { name: 'pachca_ai', version: '1.0.0' } });
    connection.notify('initialized');
    const models = [];
    let cursor;
    do {
      const page = await connection.request('model/list', { limit: 100, includeHidden: false, cursor });
      if (!Array.isArray(page.data)) throw new Error('Codex не вернул список моделей.');
      for (const entry of page.data) {
        if (!entry.hidden && /^[a-z0-9._-]+$/i.test(entry.model) && typeof entry.displayName === 'string') {
          const levels = entry.supportedReasoningEfforts?.map(item => item.reasoningEffort) ?? [];
          models.push({ id: entry.model, label: entry.displayName, is_default: entry.isDefault === true,
            efforts: reasoningEfforts.filter(effort => levels.includes(effort)), default_effort: entry.defaultReasoningEffort });
        }
      }
      if (page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    } while (cursor && models.length < 500);
    return models;
  } finally {
    connection.close();
  }
}
