import { lookup } from 'node:dns/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { urlTask } from './task-links.mjs';

const maxBody = 640 * 1024;
const privateIPv4 = new BlockList();
const privateIPv6 = new BlockList();
const globalIPv6 = new BlockList();
for (const [prefix, size] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) {
  privateIPv4.addSubnet(prefix, size, 'ipv4');
}
globalIPv6.addSubnet('2000::', 3, 'ipv6');
for (const [prefix, size] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  privateIPv6.addSubnet(prefix, size, 'ipv6');
}

function safeUrl(value, attachment = false) {
  const url = new URL(value);
  if (value.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('Предпросмотр доступен для обычных ссылок HTTP и HTTPS.');
  }
  if (/(?:^|\/)(?:logout|sign[-_]?out|unsubscribe|reset[-_]?password|verify-email|magic[-_]?link)(?:\/|$)/i.test(url.pathname) ||
      [...url.searchParams.keys()].some(key => /^(?:(?:access|auth|refresh|login)[_-]?)?token$|^(?:signature|sig|password|x-amz-signature|session)$/i.test(key) &&
        !(attachment && url.protocol === 'https:' && /^(?:signature|sig|x-amz-signature)$/i.test(key)))) {
    throw new Error('Ссылка для входа или действия. Откройте её вручную.');
  }
  url.hash = '';
  return url;
}

export function messageLinks(text) {
  if (text && typeof text === 'object') {
    const markup = (Array.isArray(text.markup) ? text.markup : []).filter(mark => mark?.style === 'link').map(mark => mark.attributes?.url);
    const cards = [...(Array.isArray(text.link_previews) ? text.link_previews : []), text.link_preview].map(card => card?.original_link || card?.url);
    return [...new Set([...markup, ...messageLinks(text.text), ...cards].filter(url =>
      typeof url === 'string' && url.length <= 2048 && /^https?:\/\//iu.test(url)))].slice(0, 2);
  }
  return [...new Set(String(text ?? '').match(/https?:\/\/[^\s<>"'\x60]+/giu)?.map(link => {
    let clean = link.replace(/[.,!?;:»]+$/u, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      const surplus = clean.split(close).length - clean.split(open).length;
      if (surplus > 0 && clean.endsWith(close.repeat(surplus))) clean = clean.slice(0, -surplus);
    }
    return clean;
  }).filter(link => link.length <= 2048) ?? [])].slice(0, 2);
}

export function googleDocumentTextUrl(url) {
  if (url.origin !== 'https://docs.google.com') return;
  const match = /^\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)(?:\/(?:edit|view|preview))?\/?$/.exec(url.pathname);
  if (!match) return;
  const target = new URL('/document/d/' + match[1] + '/export', url.origin);
  target.searchParams.set('format','txt');
  for (const key of ['resourcekey','tab']) if (url.searchParams.has(key)) target.searchParams.set(key,url.searchParams.get(key));
  return target;
}

async function publicAddress(host, signal) {
  const hostname = host.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true });
  signal.throwIfAborted();
  const valid = ({ address, family }) => family === 4 ? !privateIPv4.check(address, 'ipv4') :
    globalIPv6.check(address, 'ipv6') && !privateIPv6.check(address, 'ipv6');
  if (!addresses.length || addresses.some(entry => !valid(entry))) throw new Error('Адрес ведёт в локальную или частную сеть.');
  return addresses.find(entry => entry.family === 4) ?? addresses[0];
}

async function fetchPage(url, signal, hops = 0, fileName = '', fileLimit = 0) {
  const address = await publicAddress(url.hostname, signal);
  const get = url.protocol === 'https:' ? httpsGet : httpGet;
  const response = await new Promise((resolve, reject) => {
    const request = get(url, {
      agent: false, signal,
      lookup: (_host, options, done) => options.all ? done(null, [address]) : done(null, address.address, address.family),
      headers: { Accept: fileLimit ? '*/*' : 'text/html, text/plain;q=0.9', 'Accept-Encoding': 'identity', 'User-Agent': 'PachcaAI-LinkPreview/1.0' },
    }, resolve);
    request.once('error', reject);
  });
  const status = response.statusCode;
  const location = response.headers.location;
  if ([301, 302, 303, 307, 308].includes(status) && location && hops < 4) {
    response.destroy();
    const next = safeUrl(new URL(location, url).href, Boolean(fileName));
    if (/(?:^|\/)(?:login|log-in|signin|sign-in)(?:\/|$)/i.test(next.pathname))
      throw new Error('Страница требует входа.');
    return fetchPage(next, signal, hops + 1, fileName, fileLimit);
  }
  if (status < 200 || status >= 300) {
    response.destroy();
    if ([401, 403].includes(status)) throw new Error('Страница требует входа или ограничивает доступ.');
    throw new Error(`Страница недоступна (HTTP ${status}).`);
  }
  const type = (response.headers['content-type'] ?? '').toLowerCase();
  if (fileLimit) {
    if (/html/.test(type)) { response.destroy(); throw Error('Вместо файла сервер вернул веб-страницу.'); }
    return readLimitedBytes(response,fileLimit);
  }
  const office = /\.(docx|xlsx)$/i.test(fileName);
  if (!office && !/\.(txt|csv|tsv|md)$/i.test(fileName) && !/^(?:text\/|application\/(?:json|xhtml\+xml|xml))/.test(type)) {
    response.destroy();
    throw new Error('Для этого формата доступно только открытие страницы в браузере.');
  }
  if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
    response.destroy();
    throw new Error('Страница использует неподдерживаемый формат сжатия.');
  }
  const chunks = [];
  const limit = office ? 8 * 1024 * 1024 : maxBody;
  let received = 0;
  for await (const part of response) {
    if (office && received + part.length > limit) throw new Error('Файл слишком велик для предпросмотра.');
    const count = Math.min(part.length, limit - received);
    chunks.push(part.subarray(0, count));
    received += count;
    if (!office && received === limit) break;
  }
  if (office) return {office:Buffer.concat(chunks)};
  const charset = type.match(/charset\s*=\s*["']?([^;"'\s]+)/)?.[1] ?? 'utf-8';
  let decoder;
  try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder(); }
  return { url: url.href, body: decoder.decode(Buffer.concat(chunks)), html: /html|xml/.test(type) };
}

export async function readLimitedBytes(stream,limit) {
  let size = 0;
  const chunks = [];
  for await (const part of stream) {
    size += part.length;
    if (size > limit) throw Error('Превышен лимит размера вложений.');
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

export function publicTaskFile(value,limit,signal) {
  return fetchPage(safeUrl(value,true),AbortSignal.any([signal,AbortSignal.timeout(20000)]),0,'attachment',limit);
}

export async function extractPage(page, source) {
  return page.evaluate(html => {
    const document = new DOMParser().parseFromString(html, 'text/html');
    const description = document.querySelector('meta[name=description],meta[property="og:description"]')?.content ?? '';
    const title = document.title.trim().slice(0, 180);
    document.querySelectorAll('script,style,noscript,template,svg,nav,footer,iframe,form,[hidden],[aria-hidden="true"]').forEach(node => node.remove());
    const root = document.querySelector('main,article,[role=main]') ?? document.body;
    root.querySelectorAll('br,h1,h2,h3,p,li,pre,div,section,tr').forEach(node => {
      node.before(document.createTextNode('\n'));
      node.after(document.createTextNode('\n'));
    });
    const text = root.textContent.replace(/[^\S\n]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
    return { title, text: [...new Set([description.trim(), text].filter(Boolean))].join('\n\n').slice(0, 12000) };
  }, source);
}

export function linkReader({ parseHtml, parseOffice, authenticatedTask, signal }) {
  const cache = new Map();
  let active = 0;
  const pending = [];
  const drain = () => {
    while (pending.length && active < 3) {
      active++;
      const job = pending.shift();
      void job.run().then(job.resolve).finally(() => { active--; drain(); });
    }
  };
  async function read(value, fileName, requestSignal) {
    try {
      requestSignal.throwIfAborted();
      const url = safeUrl(value, Boolean(fileName));
      const timeout = AbortSignal.any([signal,requestSignal,AbortSignal.timeout(12_000)]);
      const card = authenticatedTask?.(url);
      if (card) return { url: url.href, ...await card };
      const exportUrl = googleDocumentTextUrl(url);
      const result = await fetchPage(exportUrl || url, timeout, 0, fileName);
      if (exportUrl && result.html) throw new Error('Google Документы не предоставили текст. Проверьте доступ по ссылке.');
      const preview = result.office ? {text:await parseOffice(result.office)} : result.html ? await parseHtml(result.body) : { text: result.body };
      const text = String(preview.text ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim().slice(0, 12000);
      if (!text) throw new Error('На странице не найден текст. Возможно, она загружается через JavaScript.');
      return { url: exportUrl ? url.href : result.url || value, title: fileName || preview.title || url.hostname, text };
    } catch (error) {
      const message = error?.code || error?.name === 'AbortError' ? 'Не удалось прочитать страницу.' : error.message;
      return { url: value, error: message };
    }
  }
  return (value, fileName = '', requestSignal = signal) => {
    if (!(requestSignal instanceof AbortSignal)) requestSignal = signal;
    if (typeof fileName === 'string' && fileName) return read(value, fileName, requestSignal);
    // The sender may resend the same card immediately after reassigning it.
    const taskLink = authenticatedTask && urlTask(value);
    const cached = !taskLink && cache.get(value);
    if (cached && cached.until > Date.now() && (requestSignal === signal || cached.settled)) return cached.result;
    if (pending.length >= 40) return Promise.resolve({ url: value, error: 'Слишком много ссылок для одновременного просмотра.' });
    const result = new Promise(resolve => { pending.push({ resolve, run: () => read(value, '', requestSignal) }); drain(); });
    if (requestSignal !== signal || taskLink) return result;
    if (cache.size >= 150) cache.delete(cache.keys().next().value);
    const entry = { result, until: Date.now() + 5 * 60_000 };
    cache.set(value, entry);
    void result.then(preview => { entry.settled = true; if (preview.error) entry.until = Date.now() + 15_000; });
    return result;
  };
}
