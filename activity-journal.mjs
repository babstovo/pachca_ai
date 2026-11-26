import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

const clip = value => String(value ?? '').slice(0, 16000);

export function activityPersonName(person) {
  if (!person) return '';
  const first = (person.first_name || person.name || '').trim();
  const last = (person.last_name || '').trim();
  if (last && first !== last && !first.endsWith(' ' + last)) return [first,last].filter(Boolean).join(' ');
  return first || last || person.nickname || '';
}

// Look up the peer of the DM, even when the owner authored the message.
export async function readActivityDestinations(ids, get, profile) {
  const chats = (await get('/chats',{ids})).records || [];
  const requested = new Set(ids);
  const rooms = chats.filter(chat => requested.has(chat.id));
  const peers = [...new Set(rooms.filter(chat => chat.personal && chat.personal_interlocutor_id !== profile)
    .map(chat => chat.personal_interlocutor_id).filter(Number.isSafeInteger))];
  const users = peers.length ? await get('/users',{ids:peers}).catch(() => ({})) : {};
  const names = new Map((users.data || []).map(user => [user.id, activityPersonName(user)]));
  const result = [];
  for (const chat of rooms) {
    const self = chat.personal && chat.personal_interlocutor_id === profile;
    const name = self ? 'Избранное' : chat.personal ? names.get(chat.personal_interlocutor_id) || chat.name || chat.title : chat.name || chat.title;
    if (name?.trim()) result.push({chat:chat.id, kind:self ? 'self' : chat.personal ? 'dm' : chat.channel ? 'channel' : 'chat', name:name.trim()});
  }
  return result;
}

export function activityJournal(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS activity (
    id TEXT PRIMARY KEY, title TEXT, recipient TEXT, chat INTEGER, source TEXT, body TEXT,
    state TEXT, at INTEGER, updated INTEGER, receipt INTEGER, active INTEGER
  );
  CREATE INDEX IF NOT EXISTS activity_source ON activity(source,state);
  CREATE TABLE IF NOT EXISTS cancelled_sources (source TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS activity_destinations (chat INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL);
  UPDATE activity SET active=0, state=CASE state WHEN 'sending' THEN 'uncertain' ELSE 'interrupted' END WHERE active=1;`);
  if (!db.prepare("PRAGMA table_info(activity)").all().some(column => column.name === 'incoming'))
    db.exec('ALTER TABLE activity ADD COLUMN incoming TEXT');
  if (!db.prepare("PRAGMA table_info(activity)").all().some(column => column.name === 'provenance'))
    db.exec('ALTER TABLE activity ADD COLUMN provenance TEXT');
  const live = new Map();
  const ready = new Map();
  const instance = randomUUID();
  const notices = [];
  let revision = 0;
  function begin({title, recipient = '', chat = null, source = '', body = '', incoming, state = 'thinking', cancellable = true, onCancel}) {
    const id = randomUUID();
    const controller = new AbortController();
    const now = Date.now();
    db.prepare('INSERT INTO activity(id,title,recipient,chat,source,body,state,at,updated,receipt,active,incoming) VALUES(?,?,?,?,?,?,?,?,?,?,1,?)')
      .run(id,title,recipient,chat,source,clip(body),state,now,now,null,incoming ? clip(incoming) : null);
    revision++;
    function update(next, content, result, active) {
      db.prepare('UPDATE activity SET state=?,body=COALESCE(?,body),chat=COALESCE(?,chat),receipt=?,updated=?,active=? WHERE id=?')
        .run(next, content == null ? null : clip(content), result?.chat_id ?? null, result?.message_id ?? null,Date.now(),active,id);
      state = next;
      revision++;
      if (next === 'ready') ready.set(id,{id,title:recipient || title,text:clip(content).slice(0,120)});
      else ready.delete(id);
    }
    const job = {
      id, signal:controller.signal,
      setProvenance(settings, instruction) {
        const details = {model:settings.model || '',effort:settings.effort || '',instruction:clip(instruction)};
        db.prepare('UPDATE activity SET provenance=? WHERE id=?').run(JSON.stringify(details),id);
        revision++;
      },
      get cancellable() { return cancellable && live.has(id) && state !== 'sending'; },
      setIncoming(text) {
        if (text && live.has(id) && db.prepare('UPDATE activity SET incoming=? WHERE id=? AND incoming IS NOT ?').run(clip(text),id,clip(text)).changes) revision++;
      },
      stage(next, content) {
        controller.signal.throwIfAborted();
        if (!live.has(id)) throw new Error('Действие уже завершено.');
        update(next,content,null,1);
      },
      finish(next, content, result) {
        if (!live.has(id)) return;
        update(next,content,result,0);
        live.delete(id);
        db.exec('DELETE FROM activity WHERE active=0 AND rowid NOT IN (SELECT rowid FROM activity WHERE active=0 ORDER BY updated DESC,rowid DESC LIMIT 250)');
        if (['sent','done','error','uncertain'].includes(next)) {
          notices.push({seq:revision, state:next, title:recipient || title, text:clip(content ?? body).slice(0,160)});
          if (notices.length > 32) notices.shift();
        }
      },
      fail(error) {
        if (!live.has(id)) return;
        const previous = db.prepare('SELECT body FROM activity WHERE id=?').get(id).body;
        job.finish(state === 'sending' ? 'uncertain' : 'error', [error.message,previous].filter(Boolean).join('\n\n'));
      },
      cancel() {
        if (!job.cancellable) throw new Error('Действие уже завершено или отправка началась.');
        onCancel?.();
        if (source) db.prepare('INSERT OR IGNORE INTO cancelled_sources VALUES(?)').run(source);
        job.finish('cancelled');
        controller.abort(new Error('Остановлено владельцем в журнале.'));
      }
    };
    live.set(id,job);
    return job;
  }
  return {
    begin,
    notifyChat({threadId,title}) {
      notices.push({seq:++revision,state:'codex-chat',threadId,title});
      if (notices.length > 32) notices.shift();
    },
    chatIds: () => db.prepare('SELECT DISTINCT chat FROM activity WHERE chat > 0').all().map(row => row.chat),
    rememberDestinations(destinations) {
      const save = db.prepare(`INSERT INTO activity_destinations VALUES(?,?,?) ON CONFLICT(chat) DO UPDATE
        SET kind=excluded.kind,name=excluded.name WHERE kind<>excluded.kind OR name<>excluded.name`);
      for (const {chat,kind,name} of destinations) {
        if (save.run(chat,kind,name).changes) revision++;
      }
    },
    restoreDestinations(roomFor, nameFor, profile) {
      const missing = db.prepare(`SELECT DISTINCT a.chat FROM activity a LEFT JOIN activity_destinations d ON a.chat=d.chat
        WHERE a.chat > 0 AND d.chat IS NULL`).all();
      const previous = db.prepare(`SELECT DISTINCT recipient FROM activity WHERE chat=? AND recipient<>'' ORDER BY updated DESC,rowid DESC`);
      const recovered = [];
      for (const {chat} of missing) {
        const room = roomFor(chat);
        const labels = previous.all(chat).map(row => row.recipient.trim());
        const known = labels.find(label => label.startsWith('Личные сообщения: '))?.slice('Личные сообщения: '.length);
        if (room?.kind === 'личка' && room.peer === profile) recovered.push({chat,kind:'self',name:'Избранное'});
        else if ((!room || room.kind === 'личка') && (known || room?.peer)) {
          const name = known || nameFor(room.peer);
          if (name && !/^\d+$/.test(name)) recovered.push({chat,kind:'dm',name});
        } else {
          const name = labels.find(label => !/^(?:(?:Личный чат|Чат|Тред|Участник|user|chat|thread)\s*№\s*)?\d+$/iu.test(label)
            && !label.startsWith('Личные сообщения: '));
          if (name) recovered.push({chat,kind:room?.kind === 'общий чат' ? 'chat' : 'conversation',name});
        }
      }
      this.rememberDestinations(recovered);
    },
    importReplies(rows,profile) {
      const imported = db.prepare("SELECT 1 FROM journal_meta WHERE key='inbox-import'").get();
      db.exec('BEGIN');
      try {
        const insert = db.prepare("INSERT OR IGNORE INTO activity(id,title,recipient,chat,source,body,state,at,updated,receipt,active) VALUES(?,?,?,?,?,?,'sent',?,?,?,0)");
        const backfill = db.prepare('UPDATE activity SET incoming=? WHERE chat=? AND (source=? OR receipt=?) AND incoming IS NULL');
        for (const row of rows) {
          const chat = row.messages?.[0]?.chat_id;
          const at = Date.parse(row.at);
          if (String(row.profile_id) !== String(profile) || !Number.isSafeInteger(chat) || !row.key) continue;
          if (!imported && row.status === 'accepted' && row.reply && Number.isFinite(at)) {
            insert.run('inbox-'+row.key,'Ответ агента',row.destination?.title || `Чат №${chat}`,chat,row.key,
              clip(row.reply),at,at,row.reply_id ?? null);
          }
          if (row.incoming_text && row.key === profile+':'+row.messages[0].id)
            backfill.run(clip(row.incoming_text),chat,row.key,row.reply_id ?? null);
        }
        db.exec("INSERT OR IGNORE INTO journal_meta VALUES('inbox-import'); COMMIT");
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    cancel(id) {
      const job = live.get(id);
      if (!job) throw new Error('Действие уже завершено. Проверьте результат в журнале.');
      job.cancel();
    },
    cancelled: source => !!db.prepare('SELECT 1 FROM cancelled_sources WHERE source=?').get(source),
    head: () => ({instance, revision, active:live.size, ready:Array.from(ready.values()), notices}),
    list(filter = 'all', limit = -1, offset = 0) {
      const conditions = {all:'1', active:'a.active=1', sent:"a.state='sent'"};
      if (!Object.hasOwn(conditions,filter) || !Number.isSafeInteger(limit) || limit < -1 ||
          !Number.isSafeInteger(offset) || offset < 0) throw Error('Некорректная страница журнала.');
      return db.prepare(`SELECT a.*,d.kind AS destination_kind,d.name AS destination_name FROM activity a
        LEFT JOIN activity_destinations d ON d.chat=a.chat WHERE ${conditions[filter]}
        ORDER BY a.active DESC,a.updated DESC,a.rowid DESC LIMIT ? OFFSET ?`).all(limit,offset)
        .map(row => ({...row, provenance:row.provenance ? JSON.parse(row.provenance) : null, cancellable:live.get(row.id)?.cancellable || false}));
    },
    close: () => db.close()
  };
}

// The transport invokes beforeSend synchronously immediately before POST /messages.
export async function sendWithJournal(job, text, send, {signal, beforeSend, recheck, delay = 10000} = {}) {
  const stop = signal ? AbortSignal.any([signal,job.signal]) : job.signal;
  const body = text || '[Изображение]';
  let posting = false;
  try {
    job.stage('ready',body);
    await sleep(delay, undefined, {signal:stop});
    await recheck?.();
    stop.throwIfAborted();
    const receipt = await send(() => {
      stop.throwIfAborted();
      beforeSend?.();
      job.stage('sending');
      posting = true;
    });
    job.finish('sent',body,receipt);
    return receipt;
  } catch (error) {
    if (job.signal.aborted) throw job.signal.reason;
    error.deliveryStarted = posting;
    if (error.reviewPlan && !posting) job.finish('question',error.message);
    else job.fail(error);
    throw error;
  }
}
