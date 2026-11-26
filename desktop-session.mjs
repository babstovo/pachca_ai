import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';

// The desktop process executes same-origin Pachca requests in its signed-in WebView.
// Only request data and API responses cross the inherited pipes.
export function desktopSession(profileId, input = process.stdin, output = process.stdout) {
  const events = new EventEmitter();
  const pending = new Map();
  const lines = createInterface({ input });
  let sequence = 0, closed = false, parser;
  function end() {
    if (closed) return;
    closed = true;
    for (const job of pending.values()) job.reject(new Error('Окно Пачки закрыто.'));
    events.emit('end');
  }
  lines.on('close', end);
  lines.on('line', line => {
    let value;
    try { value = JSON.parse(line); } catch { return; }
    if (value.event === 'activity') { events.emit('frame', value.payload); return; }
    if (value.event === 'activate') { events.emit('activate'); return; }
    if (value.event === 'stop') { end(); return; }
    const job = pending.get(value.id);
    if (job) job.resolve(value);
  });
  return {
    profileId, events, get closed() { return closed; },
    request: {
      async fetch(url, { method, headers, data, multipart, timeout }) {
        if (closed) throw new Error('Окно Пачки закрыто.');
        const id = ++sequence;
        let timer;
        const response = await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          timer = setTimeout(() => reject(new Error('Время запроса истекло.')), timeout);
          const file = multipart?.file;
          output.write(JSON.stringify({ id, url, method, version: headers['x-version'], profile: headers['user-id'],
            data, file: file && { name: file.name, mimeType:file.mimeType, bytes: file.buffer.toString('base64') } }) + '\n');
        }).finally(() => { clearTimeout(timer); pending.delete(id); });
        return { status: () => response.status, ok: () => response.status >= 200 && response.status < 300,
          text: async () => response.body, dispose: async () => {} };
      },
    },
    async newPage() {
      parser ??= chromium.launch({ channel: 'msedge', headless: true, chromiumSandbox: true });
      return (await parser).newPage();
    },
    async close() {
      lines.close();
      input.pause();
      if (parser) await (await parser).close();
    },
  };
}
