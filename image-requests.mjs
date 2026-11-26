import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isConversationMessage } from './auto-reply.mjs';
import { messageLinks } from './link-preview.mjs';

const unavailableMessage = 'Не могу сделать такую картинку.';

// Only the sender's own request can start an unsolicited image job.
export function requestsImage(text) {
  const words = String(text ?? '').toLowerCase().replace(/https?:\/\/\S+|«[^»]*»|"[^"]*"|“[^”]*”/gu,' ');
  if (/(?:^|[^\p{L}])(?:не\s+(?:надо|нужно|стоит|хочу|рисуй|генерируй|делай|создавай)|do not|don't)(?!\p{L})/iu.test(words)) return false;
  return words.split(/[.!?\n]+/u).some(sentence => {
    if (/(?:^|[^\p{L}])(?:не|нельзя|зачем|попросил[аи]?|просил[аи]?|сказал[аи]?|написал[аи]?)\s/iu.test(sentence)) return false;
    return /(?:^|[^\p{L}])(?:нарисуй(?:те)?|нарисуешь|мож(?:ешь|ете)\s+нарисовать|draw\s+(?:me\s+)?(?:a|an|the)|illustrate)\s+\S/iu.test(sentence) ||
      /(?:^|[^\p{L}])(?:сделай(?:те)?|создай(?:те)?|сгенерируй(?:те)?|подготовь(?:те)?|мож(?:ешь|ете)\s+(?:сделать|создать|сгенерировать)|generate|create|make)\s+(?:[\p{L}-]+\s+){0,4}(?:картинк|изображени|иллюстраци|баннер|постер|рисунок|image\b|picture\b|poster\b|illustration\b)/iu.test(sentence);
  });
}

export function imageApproval(text) {
  const words = text.trim().toLowerCase().replace(/[.,!]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (/^(?:нет|отмена|отмени|не надо|не разрешаю|не делай)$/u.test(words)) return 'cancelled';
  if (/^(?:да|разрешаю|согласен|подтверждаю|генерируй|сгенерируй|делай|можно|давай|👍)(?: (?:да|разрешаю|генерируй|сгенерируй|делай|картинку|и|отправь|отправляй|скинь|ей|ему|туда|в чат))*$/u.test(words)) return 'queued';
}

export function imageRequests(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS image_jobs (
    id TEXT PRIMARY KEY, chat INTEGER NOT NULL, peer INTEGER NOT NULL,
    cursor INTEGER NOT NULL, source INTEGER UNIQUE, brief TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL, label TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', receipt INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS waiting_peer ON image_jobs(chat,peer) WHERE state='waiting';
  UPDATE image_jobs SET state='queued' WHERE state='generating';
  UPDATE image_jobs SET state='uncertain', error='Проверь историю чата: отправка прервалась.' WHERE state='sending';`);
  if (!db.prepare("PRAGMA table_info(image_jobs)").all().some(column => column.name === 'incoming'))
    db.exec('ALTER TABLE image_jobs ADD COLUMN incoming TEXT');
  const get = id => db.prepare('SELECT * FROM image_jobs WHERE id=?').get(id);
  const list = state => db.prepare('SELECT * FROM image_jobs WHERE state=? ORDER BY rowid').all(state);
  function change(id, from, to, error = '') {
    return db.prepare('UPDATE image_jobs SET state=?, error=? WHERE id=? AND state=?').run(to,error,id,from).changes === 1;
  }
  return {
    get, list, change, close: () => db.close(),
    waiting: (chat, peer) => db.prepare("SELECT * FROM image_jobs WHERE chat=? AND peer=? AND state='waiting'").get(chat,peer),
    seen: source => Boolean(db.prepare('SELECT 1 FROM image_jobs WHERE source=?').get(source)),
    offer(chat, peer, cursor, label) {
      if (![chat,peer].every(id => Number.isSafeInteger(id) && id > 0) || !Number.isSafeInteger(cursor) || cursor < 0) throw Error('Нет подтверждённого адресата или сообщения с предложением.');
      db.prepare("INSERT INTO image_jobs(id,chat,peer,cursor,label,state) VALUES(?,?,?,?,?,'waiting') ON CONFLICT DO NOTHING")
        .run(randomUUID(),chat,peer,cursor,label);
    },
    ask(chat, peer, source, brief, label, incoming = null) {
      db.prepare("INSERT INTO image_jobs(id,chat,peer,cursor,source,brief,label,incoming,state) VALUES(?,?,?,?,?,?,?,?,'approval') ON CONFLICT(source) DO NOTHING")
        .run(randomUUID(),chat,peer,source,source,brief,label,incoming);
    },
    async checkOffer(job, read, classify) {
      const page = await read(job.chat, job.cursor);
      const rows = page.filter(r => r.chat_id === job.chat && Number.isSafeInteger(r.id) && r.id > job.cursor).sort((a,b) => a.id-b.id);
      const incoming = rows.filter(r => r.user_id === job.peer && isConversationMessage(r) && r.text?.trim());
      if (!rows.length) return;
      if (incoming.length) {
        const decision = await classify(incoming.map(r => ({id:r.id, text:r.text.slice(0,3000), ...(messageLinks(r).length ? {shared_link:true} : {})})));
        const source = incoming.find(r => r.id === decision.source);
        if (decision.action === 'cancel' && source) { change(job.id,'waiting','cancelled'); return; }
        if (decision.action === 'generate' && source && messageLinks(source).length && !requestsImage(source.text)) decision.action = 'wait';
        if (decision.action === 'generate' && source && typeof decision.brief === 'string' && decision.brief.trim()) {
          db.prepare("UPDATE image_jobs SET state='queued', source=?, brief=?, incoming=? WHERE id=? AND state='waiting'")
            .run(source.id,decision.brief.trim().slice(0,3000),source.text.slice(0,16000),job.id);
          return;
        }
        if (decision.action !== 'wait') throw Error('Не удалось разобрать ответ на предложение картинки.');
      }
      db.prepare("UPDATE image_jobs SET cursor=? WHERE id=? AND state='waiting' AND cursor=?").run(rows.at(-1).id,job.id,job.cursor);
    },
    async deliver(job, generate, send, signal) {
      let image;
      let state = 'notice_pending';
      if (change(job.id,'queued','generating')) {
        try {
          signal.throwIfAborted();
          image = await generate(job.brief, signal);
          state = 'generating';
        } catch (error) {
          if (signal.aborted) {
            change(job.id,'generating','queued');
            throw error;
          }
          if (!change(job.id,'generating','notice_pending',error.message)) return;
        }
      } else if (get(job.id)?.state !== 'notice_pending') return;

      const notice = state === 'notice_pending';
      let sending = false;
      try {
        signal.throwIfAborted();
        const receipt = await send(job, image, () => {
          signal.throwIfAborted();
          if (!change(job.id,state,'sending')) throw Error('Поручение больше не активно.');
          sending = true;
        }, notice ? unavailableMessage : '');
        if (!sending || !Number.isSafeInteger(receipt.message_id)) throw Error('Пачка не вернула номер сообщения.');
        db.prepare("UPDATE image_jobs SET state=?, receipt=? WHERE id=? AND state='sending'")
          .run(notice ? 'notified' : 'done',receipt.message_id,job.id);
        return receipt.message_id;
      } catch (error) {
        if (sending) change(job.id,'sending','uncertain',error.message);
        else if (!notice) change(job.id,'generating',signal.aborted ? 'queued' : 'approval',error.message);
        throw error;
      }
    },
  };
}
