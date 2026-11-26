import { normalizedName } from './auto-reply.mjs';
import { existingMessageThread } from './client.mjs';
import { messageLinks } from './link-preview.mjs';

export function threadMessageId(text) {
  for (const link of messageLinks(text)) {
    let url;
    try { url = new URL(link); } catch { continue; }
    if (url.origin !== 'https://app.pachca.com' || !/^\/chats(?:\/\d+)?\/?$/.test(url.pathname)) continue;
    const value = url.searchParams.get('thread_message_id');
    if (/^\d+$/.test(value) && Number.isSafeInteger(+value) && +value > 0) return +value;
  }
}

export async function linkedDiscussion(get, id) {
  const rows = await get('/messages', {ids:[id]});
  const parent = rows.find(row => row.id === id && !row.deleted_at);
  if (!parent) throw new Error('Сообщение по ссылке недоступно в этом пространстве.');
  const thread = await existingMessageThread((path, {query}) => get(path, query), parent);
  return {type:'chat', id:thread?.chat_id || parent.chat_id, label:`Тред сообщения №${id}`, parent};
}

export function exactChat(candidates, query) {
  const name = normalizedName(query);
  const matches = candidates.filter(item => normalizedName(item.label) === name || String(item.id) === query.trim().replace(/^№/, ''));
  return matches.length === 1 ? matches[0] : undefined;
}

export function messageUrl(row, parent) {
  if (parent && row.chat_id !== parent.chat_id)
    return `https://app.pachca.com/chats/${parent.chat_id}?thread_message_id=${parent.id}&sidebar_message=${row.id}`;
  return `https://app.pachca.com/chats/${row.chat_id}?message=${row.id}`;
}

function sharedLinks(row) {
  const links = new Map();
  function add(url, title) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || /^https?:\/\/app\.pachca\.com\//i.test(url)) return;
    if (!links.has(url) || title) links.set(url, {url, title});
  }
  for (const card of [...(row.link_previews || []), row.link_preview].filter(Boolean)) add(card.original_link || card.url, card.title);
  for (const mark of row.markup || []) if (mark.style === 'link') add(mark.attributes?.url);
  for (const url of messageLinks(row.text)) add(url);
  return [...links.values()];
}

export function documentQueries(...groups) {
  return [...new Set(groups.flatMap(group => Array.isArray(group) ? group : []).filter(q => typeof q === 'string')
    .map(q => q.trim()).filter(q => q.length >= 2 && q.length <= 150))].slice(0,4);
}

export function refersToDocument(text, hasImage) {
  const request = text.trim().replace(/[.!?]+$/u,'');
  return (hasImage && /^вот (?:же|он[ао]?|документ|скрин)$/iu.test(request)) ||
    /^(?:(?:открой|посмо?три|проверь|почитай)[\s,]+)*(?:(?:что|че|чё|какие)\s+там\s+(?:за\s+)?цен[аы]|(?:цены|стоимость)\s+(?:там|в н[её]м)|(?:этот|тот)\s+документ)$/iu.test(request);
}

function authorMatches(name, wanted) {
  const words = normalizedName(name).split(' ');
  return wanted.split(' ').every(word => words.includes(word));
}

async function findDocumentAuthor(get, author) {
  if (!author) return;
  const result = await get('/search', {type:'user', query:author, limit:15}).catch(() => null);
  const users = result?.users || [];
  const wanted = normalizedName(author);
  const exact = users.filter(user => authorMatches(user.snippet, wanted));
  if (exact.length === 1) return exact[0];
  // Accept a unique search result in an oblique case only when every name component agrees.
  if (users.length === 1) {
    const forms = normalizedName(users[0].snippet).split(' ');
    if (wanted.split(' ').every(word => forms.some(base => word === base || word === base+'a' || word === base+'u')))
      return users[0];
  }
}

// Search hits are hints. Verify the original message, chat and author before reading its links.
export async function documentHistory(get, target, author, readLink, signal, {queries = [], messageIds = []} = {}) {
  const authors = new Map(), seen = new Set(), matches = [];
  const wanted = normalizedName(author);
  const resolved = await findDocumentAuthor(get, author);
  const phrases = documentQueries(queries);
  const words = [...new Set(phrases.join(' ').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])];
  let scanned = 0;
  async function inspect(rows) {
    const documents = [];
    for (const row of rows) {
      if (seen.has(row.id) || row.deleted_at) continue;
      seen.add(row.id);
      scanned++;
      const files = (Array.isArray(row.files) ? row.files : []).filter(f => f && typeof f.name === 'string');
      const text = String(row.text ?? '');
      const links = sharedLinks(row);
      if (files.length || links.length) documents.push({row, files, links, text});
    }
    const ids = [...new Set(documents.map(d => d.row.user_id).filter(id => id && !authors.has(id)))];
    if (ids.length) {
      const users = (await get('/users', {ids})).data || [];
      for (const id of ids) authors.set(id, users.find(u => String(u.id) === String(id)));
    }
    for (const {row, files, links, text} of documents) {
      const user = authors.get(row.user_id);
      const names = [user?.name, [user?.first_name,user?.last_name].filter(Boolean).join(' '), user?.nickname];
      if (resolved ? String(row.user_id) !== String(resolved.id) : wanted && !names.some(n => n && authorMatches(n,wanted))) continue;
      const searchable = [text, ...files.map(f=>f.name), ...links.map(l=>l.title)].join(' ').toLowerCase();
      matches.push({message_id:row.id, author:names.find(Boolean) || resolved?.snippet || String(row.user_id), text:text.slice(0,1800),
        rank:words.filter(word => searchable.includes(word)).length,
        message_url:messageUrl(row,target.parent),
        files:files.slice(0,8).map(f => ({name:f.name, url:f.url})), links});
    }
  }
  if (target.parent) await inspect([target.parent]);
  const ids = new Set(messageIds.filter(Number.isSafeInteger).slice(0,12));
  for (const query of phrases) {
    signal.throwIfAborted();
    const result = await get('/search', {type:'message', query, limit:30}).catch(() => null);
    for (const hit of result?.messages || []) if (Number(hit.chat_id) === target.id && Number.isSafeInteger(hit.id)) ids.add(hit.id);
  }
  const candidates = [...ids];
  for (let i=0; i<candidates.length; i+=30) {
    const batch = candidates.slice(i,i+30);
    const rows = await get('/messages', {ids:batch});
    await inspect(rows.filter(row => Number(row.chat_id) === target.id && batch.includes(row.id)));
  }
  let exhausted = Boolean(target.parent && target.id === target.parent.chat_id);
  let before;
  const hasTopicMatch = () => matches.some(match => messageIds.includes(match.message_id) || (words.length && match.rank >= Math.min(words.length,2)));
  for (let page = 0; !exhausted && page < 100 && !hasTopicMatch() && (words.length || matches.length < 12); page++) {
    signal.throwIfAborted();
    const rows = await get('/messages', {chat_id:target.id, per:30, direction:before?'early':'around', message_id:before});
    if (!Array.isArray(rows)) throw new Error('Пачка не вернула историю переписки.');
    const valid = rows.filter(row => row.chat_id === target.id && Number.isSafeInteger(row.id) && (!before || row.id < before));
    await inspect(valid);
    exhausted = rows.length < 30 || !valid.length;
    if (valid.length) before = Math.min(...valid.map(row => row.id));
  }
  matches.sort((a,b) => b.rank - a.rank || Number(messageIds.includes(b.message_id))-Number(messageIds.includes(a.message_id)));
  matches.splice(12);
  let previews = 0;
  for (const match of matches) {
    match.sources = [];
    for (const item of [...match.links, ...match.files]) {
      if (typeof item.url !== 'string') continue;
      if (previews >= 6) { match.sources.push({name:item.title || item.name, error:'Содержимое не прочитано.'}); continue; }
      previews++;
      const preview = await readLink(item.url, item.name);
      match.sources.push({name:item.title || item.name || preview.title || 'Ссылка из сообщения', text:preview.text?.slice(0,12000), error:preview.error});
    }
    match.files = match.files.map(f => f.name);
    delete match.links;
    delete match.rank;
  }
  return {scanned, exhausted, matches};
}
