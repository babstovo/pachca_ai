import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { clientDataDir } from './session.mjs';

export const desktopChatVersion = 46;

const commands = new Set(['activity-list','activity-cancel','participants', 'participant', 'save-participant', 'index-participants', 'profiles', 'folders', 'chats', 'search', 'message', 'history', 'thread', 'send', 'questions', 'answer-question', 'draft-question', 'delegate-question', 'communication-profile', 'save-communication-profile', 'compose-prepare', 'compose-read', 'compose-send', 'logout', 'auto-reply-setting',
  'project-settings', 'save-project-settings', 'codex-projects','codex-models', 'save-codex-model',
  'send-confirmation', 'dismiss-question', 'review-incoming-draft', 'find-participants',
  'openproject-save-key', 'openproject-remove-key', 'openproject-confirm-status',
  'task-board','task-workflow','task-update','task-detail','task-fields','task-edit','task-comments','task-comment',
  'task-codex-info','task-codex-start','task-codex-open']);
const runsCodex = command => ['draft-question', 'delegate-question', 'answer-question', 'compose-send', 'compose-prepare', 'compose-read'].includes(command);
const takesLonger = command => runsCodex(command) || ['send', 'openproject-save-key', 'openproject-confirm-status'].includes(command);
const requestTimeout = command => command === 'compose-prepare' ? 840_000 : takesLonger(command) ? 240_000 : 75_000;
const pipeName = token => `\\\\.\\pipe\\pachca-${token}`;
const activeFile = () => join(clientDataDir(), 'watch.pipe');

async function receive(socket, maxBytes) {
  socket.setEncoding('utf8');
  let text = '';
  for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
    text += chunk;
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Сообщение локального процесса слишком велико.');
    const newline = text.indexOf('\n');
    if (newline >= 0) return JSON.parse(text.slice(0, newline));
  }
  throw new Error('Локальный процесс Пачки закрыл соединение.');
}

export async function callWatcher(call) {
  let token;
  try { token = await readFile(activeFile(), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!/^[\da-f]{48}$/.test(token)) throw new Error('Некорректный адрес локального процесса Пачки.');

  const socket = createConnection(pipeName(token));
  socket.setTimeout(requestTimeout(call.command), () => socket.destroy(new Error('Локальный процесс Пачки не ответил. Проверьте результат перед повтором.')));
  try {
    try { await once(socket, 'connect'); } catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return undefined;
      throw error;
    }
    socket.write(`${JSON.stringify(call)}\n`);
    const result = await receive(socket, 16 * 1024 * 1024);
    if (result.error) throw new Error(result.error);
    return result;
  } finally {
    socket.destroy();
  }
}

export async function serveWatcher(execute, status, stop, readLogs) {
  const token = randomBytes(24).toString('hex');
  const filename = activeFile();
  const pendingFile = `${filename}.${token}`;
  const sockets = new Set();
  const concurrent = new Set();
  let queue = Promise.resolve();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(75_000, () => socket.destroy());
    void (async () => {
      try {
        const call = await receive(socket, 17 * 1024 * 1024);
        if (call?.command === 'watch-status') {
          socket.end(`${JSON.stringify({ data: status() })}\n`);
          return;
        }
        if (call?.command === 'watch-logs') {
          socket.end(`${JSON.stringify({ data: readLogs(call.cursor) })}\n`);
          return;
        }
        if (call?.command === 'stop-watch') {
          socket.end(`${JSON.stringify({ data: { stopping: true } })}\n`, stop);
          return;
        }
        if (!commands.has(call?.command)) throw new Error('Неизвестная команда Пачки.');
        socket.setTimeout(requestTimeout(call.command));
        if (runsCodex(call.command) || ['activity-list','activity-cancel','questions'].includes(call.command)) {
          const task = execute(call);
          concurrent.add(task);
          try { socket.end(`${JSON.stringify({ data: await task })}\n`); }
          finally { concurrent.delete(task); }
          return;
        }
        const task = queue.then(() => {
          if (socket.destroyed) throw new Error('Запрос отменён.');
          return execute(call);
        });
        queue = task.catch(() => {});
        const data = await task;
        socket.end(`${JSON.stringify({ data })}\n`, call.command === 'logout' && data.signed_out ? stop : undefined);
      } catch (error) {
        if (!socket.destroyed) socket.end(`${JSON.stringify({ error: error.message })}\n`);
      }
    })();
  });
  try {
    server.listen(pipeName(token));
    await once(server, 'listening');
    await writeFile(pendingFile, token, { flag: 'wx', mode: 0o600 });
    await rename(pendingFile, filename);
  } catch (error) {
    server.close();
    await unlink(pendingFile).catch(() => {});
    throw error;
  }
  return async () => {
    await unlink(filename).catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await queue;
    await Promise.allSettled(concurrent);
  };
}
