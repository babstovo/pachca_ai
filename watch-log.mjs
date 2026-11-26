import { randomUUID } from 'node:crypto';

const clock = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function printWatchEntry({ at, title, text }) {
  const body = text?.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '').trim();
  console.log(`[${clock.format(new Date(at))}] ${title}${body ? `\n  ${body.replace(/\n/g, '\n  ')}` : ''}`);
}

export function watchLog(print = true) {
  const instance = randomUUID();
  const entries = [];
  let sequence = 0;
  return {
    add(title, text, preview) {
      const body = text?.length > 4000 ? `${text.slice(0, 4000)}\n[Текст сокращён]` : text;
      const entry = { id: ++sequence, at: Date.now(), title, text: body, preview };
      entries.push(entry);
      if (entries.length > 250) entries.shift();
      if (print) printWatchEntry(entry);
    },
    read(cursor) {
      const after = cursor?.instance === instance ? cursor.after : 0;
      return { instance, last: sequence, entries: entries.filter(entry => entry.id > after) };
    },
  };
}
