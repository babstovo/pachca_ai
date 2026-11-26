import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { googleDocumentTextUrl, publicTaskFile } from './link-preview.mjs';
import { urlTask } from './task-links.mjs';
import { officePictures } from './office-preview.mjs';

const fileLimit = 16 * 1024 * 1024;
const textFile = /\.(?:txt|md|csv|tsv|json|ya?ml|xml|log)$/i;
const publicFile = /\.(?:png|jpe?g|gif|webp|svg|pdf|docx?|xlsx?|pptx?|zip|txt|md|csv|tsv|json)$/i;

function safeName(name) {
  const clean = basename(String(name).replaceAll('\\','/')).replace(/[<>:"/\\|?*\x00-\x1f#\u202a-\u202e\u2066-\u2069]/g,'_')
    .slice(0,100).trim().replace(/[. ]+$/,'');
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? '_'+clean : clean || 'Файл';
}

// Keep the words the author linked. Bare page addresses retain their route
// (often part of the acceptance criteria) without sending a navigable URL.
export function taskText(value, collect = ()=>{}, decorate = text=>text) {
  function labelFor(raw,label) {
    let url;
    try { url = new URL(raw.replaceAll('&amp;','&')); } catch { return label || 'Материал'; }
    const name = label && !/^(?:https?:\/\/|www\.)/i.test(label) ? label : '';
    return decorate(linkText(url,name),collect(url,name));
  }
  function linkText(url,name) {
    const id = urlTask(url.href);
    if (id) return name || 'задача №'+id;
    if (googleDocumentTextUrl(url)) return name || 'Документ Google';
    if (url.hostname === 'app.pachca.com') return name || 'Сообщение в Пачке';
    if (publicFile.test(url.pathname) || /\/attachments\//i.test(url.pathname)) return name || safeName(url.pathname);
    const route = new URLSearchParams();
    for (const key of ['page','sort','order','sortBy']) {
      const value = url.searchParams.get(key);
      if (value && /^[\w.-]{1,60}$/.test(value)) route.set(key,value);
    }
    if (url.pathname === '/' && !route.size) return name || 'сайт';
    const page = url.pathname+(route.size ? '?'+route : '');
    return name ? name+' ('+page+')' : page;
  }
  const definitions = new Map();
  return String(value ?? '').replace(/^\s{0,3}\[([^\]\n]+)\]:\s*<?(https?:\/\/[^\s>]+)>?[^\n]*$/gim,(_,id,url)=>{
    definitions.set(id.toLowerCase(),url); return '';
  }).replace(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g,(match,label,id)=>{
    const url = definitions.get((id || label).toLowerCase());
    return url ? labelFor(url,label) : match;
  })
    .replace(/<a\b[^>]*?\bhref=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,(_,url,label)=>labelFor(url,label.replace(/<[^>]+>/g,'')))
    .replace(/!?\[([^\]\n]*)\]\(\s*<?(https?:\/\/(?:[^\s()<>]|\([^()\s]*\))*)>?(?:\s+["'][^"'\n]*["'])?\s*\)/gi,(_,label,url)=>labelFor(url,label))
    .replace(/!?\[([^\]\n]*)\]\((\/(?!\/)[^\n)]*|#[^\n)]*)\)/g,(_,label,path)=>label ? label+' ('+path+')' : path)
    .replace(/<?https?:\/\/[^\s<>"'\x60]+>?/gi,raw=>{
      const url = raw.replace(/^</,'').replace(/[>.,!?;:»)\]]+$/u,'');
      return labelFor(url,'')+raw.replace(/^</,'').slice(url.length).replace('>','');
    });
}

export async function prepareTaskMaterials(card,{directory,signal,download = publicTaskFile,readOffice,readMessage,partition}) {
  const files = [], notes = [], excerpts = [], sources = new Map();
  function source(key,details) {
    if (!sources.has(key)) sources.set(key,{...details,owners:new Set()});
    return sources.get(key);
  }
  function collect(url,label) {
    const doc = googleDocumentTextUrl(url);
    if (doc) {
      doc.searchParams.set('format','docx');
      return source(doc.href,{url:doc.href,name:safeName(label || 'Документ Google')+'.docx'});
    } else if (publicFile.test(url.pathname)) {
      let name = basename(url.pathname);
      try { name = decodeURIComponent(name); } catch {}
      return source(url.href,{url:url.href,name});
    } else if (readMessage && url.origin === 'https://app.pachca.com' && /^\/chats\/\d+\/?$/.test(url.pathname)) {
      const id = url.searchParams.get('message') || url.searchParams.get('message_id') || url.searchParams.get('thread_message_id');
      if (/^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) && !url.searchParams.has('sidebar_message'))
        return source(url.href,{chat:Number(url.pathname.split('/')[2]),message:Number(id)});
    }
  }
  const references = [];
  // An unnamed attachment inherits the message only when all its identified
  // requirements belong to one project. Mixed messages need a filename or link.
  function messageOwners(start) {
    const paths = new Set(references.slice(start).flatMap(chunk=>chunk.owners));
    return paths.size === 1 ? [...paths] : [];
  }
  function scoped(value,owners=[]) {
    if (!partition) return taskText(value,collect);
    const links = [];
    const text = taskText(value,collect,(label,source)=>{
      if (!source) return label;
      links.push(source);
      return label+'\uE000'+(links.length-1)+'\uE001';
    });
    const chunks = partition.chunks(text,owners);
    for (const chunk of chunks) {
      chunk.text = chunk.text.replace(/\uE000(\d+)\uE001/g,(_,index)=>{
        for (const path of chunk.owners) links[index]?.owners.add(path);
        return '';
      });
      references.push(chunk);
    }
    return chunks.filter(c=>c.owners.includes(partition.folder)).map(c=>c.text).join('\n').trim();
  }
  function fileOwners(name) {
    if (!partition) return [];
    const matches = references.filter(c=>name && c.text.includes(name));
    const owners = [...new Set(matches.flatMap(c=>c.owners))];
    return owners.length ? owners : partition.owners(name.replace(/[_.-]+/g,' '));
  }
  const title = taskText(card.subject,collect);
  const localTitle = partition?.chunks(title).filter(chunk=>chunk.owners.length===1 && chunk.owners.includes(partition.folder))
    .map(chunk=>chunk.text).join(' ').trim();
  const subject = localTitle || partition?.label || title;
  const description = scoped(card.description);
  const commentOwners = new Map();
  const comments = (card.comments || []).map(text=>{
    const prefix = /^#\d+ [^\n:]+: /.exec(text)?.[0] || '';
    const start = references.length;
    const part = scoped(text.slice(prefix.length));
    if (partition && prefix) commentOwners.set(Number(/^#(\d+)/.exec(prefix)[1]),messageOwners(start));
    return part ? prefix+part : '';
  }).filter(Boolean);
  let remaining = 48 * 1024 * 1024, textLeft = 60000, attempts = 0;
  let unassignedFile = false;
  async function storeFile(name,bytes) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const folder = join(directory,hash.slice(0,24)), path = join(folder,name);
    if (files.some(f=>f.path === path)) return;
    await mkdir(folder,{recursive:true});
    const temp = join(folder,randomUUID()+'.tmp');
    try { await writeFile(temp,bytes,{flag:'wx'}); await rename(temp,path); }
    finally { await unlink(temp).catch(e=>{if (e.code !== 'ENOENT') throw e;}); }
    const image = /\.(png|jpe?g|webp|gif)$/i.test(name) && (
      bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) || bytes[0] === 0xff && bytes[1] === 0xd8 ||
      bytes.toString('ascii',0,3)==='GIF' || bytes.toString('ascii',8,12)==='WEBP');
    files.push({path,name,image});
  }
  async function add(name,read,size,owners=fileOwners(name)) {
    name = safeName(name);
    const docx = /\.docx$/i.test(name), office = docx || /\.xlsx$/i.test(name), readable = office || textFile.test(name);
    if (partition && !readable && !owners.includes(partition.folder)) {
      if (!owners.length) unassignedFile = true;
      return;
    }
    if (attempts++ >= 24) { if (attempts === 25) notes.push('Часть вложений пропущена: лимит 24 файла на запуск.'); return; }
    const limit = Math.min(fileLimit,remaining);
    try {
      signal.throwIfAborted();
      if (!limit || size > limit) throw Error('Превышен лимит размера вложений.');
      const bytes = await read(limit);
      signal.throwIfAborted();
      if (bytes.length > limit) throw Error('Превышен лимит размера вложений.');
      remaining -= bytes.length;
      if (!partition || !readable) await storeFile(name,bytes);
      let text;
      if (textLeft && textFile.test(name)) text = bytes.subarray(0,textLeft*4).toString('utf8');
      if (readOffice && office) text = await readOffice(bytes,{pictureReferences:!!partition}).catch(()=>null);
      const pictures = new Map();
      if (partition && readable) {
        const chunks = partition.chunks(text || '',owners);
        for (const chunk of chunks) for (const picture of chunk.pictures) {
          if (!chunk.owners.length) unassignedFile = true;
          pictures.set(picture,[...new Set([...(pictures.get(picture) || []),...chunk.owners])]);
        }
        text = chunks.filter(c=>c.owners.includes(partition.folder)).map(c=>c.text).join('\n').trim();
        if (text) {
          name = safeName('ТЗ — '+partition.label)+'.txt';
          await storeFile(name,Buffer.from(taskText(text)));
        } else if (!chunks.some(c=>c.owners.length)) unassignedFile = true;
      }
      if (text?.trim()) {
        const clean = taskText(text).trim().slice(0,textLeft);
        excerpts.push(name+'\n'+clean);
        textLeft -= clean.length;
      }
      if (docx && attempts < 24 && remaining > 0) {
        await officePictures(bytes,(part,data)=>add(part,async()=>data,data.length,pictures.get(part) || []),
          part=>!partition || pictures.get(part)?.includes(partition.folder)).catch(()=>{
          signal.throwIfAborted();
          notes.push(partition ? 'Не удалось извлечь иллюстрации для проекта.' : 'Иллюстрации из «'+name+'» доступны в приложенном документе.');
        });
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!partition || owners.includes(partition.folder)) notes.push('Не удалось приложить «'+name+'». '+(error.message.includes('лимит') ? error.message : 'Проверьте доступ к файлу.'));
      else if (!owners.length) unassignedFile = true;
    }
  }
  for (const file of card.attachments || []) {
    const owners = fileOwners(file.name);
    await add(file.name,limit=>card.readAttachment(file.id,limit),file.size,owners.length ? owners : commentOwners.get(file.commentId) || []);
  }
  // Read only the particular chat message referenced in the task. Never walk
  // other chats or follow more message links discovered in the referenced text.
  for (const source of [...sources.values()].filter(s=>s.message).slice(0,8)) {
    const row = await readMessage(source.chat,source.message).catch(()=>undefined);
    signal.throwIfAborted();
    if (!row || row.deleted_at || row.id !== source.message || row.chat_id !== source.chat) {
      notes.push('Исходное сообщение №'+source.message+' недоступно.'); continue;
    }
    const owners = [...source.owners];
    const start = references.length;
    const content = scoped(row.text,owners);
    const messageProjects = messageOwners(start);
    if (content) excerpts.push('Сообщение №'+source.message+'\n'+content);
    for (const mark of row.markup || []) {
      if (mark.style === 'link' && URL.canParse(mark.attributes?.url)) collect(new URL(mark.attributes.url),'');
    }
    for (const file of row.files || []) if (file.url) {
      const name = file.name || 'Файл';
      const entry = sources.get(file.url) || {url:file.url,name,owners:new Set()};
      const named = fileOwners(name);
      for (const path of named.length ? named : messageProjects.length ? messageProjects : owners) entry.owners.add(path);
      sources.set(file.url,entry);
    }
  }
  for (const file of sources.values()) if (file.url)
    await add(file.name,limit=>download(file.url,limit,signal),undefined,file.owners.size ? [...file.owners] : fileOwners(file.name));
  if (unassignedFile) notes.push('В исходной карточке есть материалы, для которых не удалось определить проект.');
  if (partition && !localTitle && !description && !comments.length && !excerpts.length && !files.length)
    throw Error('В карточке не удалось выделить требования для проекта «'+partition.label+'». Укажите в ТЗ, какие пункты или вложения относятся к этому проекту.');
  return {subject,description,comments,files,excerpts,notes};
}
