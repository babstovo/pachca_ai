'use strict';

// This page runs in its own WebView2 profile. Only the local host handles chat requests.
const host = window.chrome.webview;
const endpoint = new URL('api', location.href).href;
const uploadUrl = new URL('upload', location.href).href;
const requests = new Map();
const notice = document.querySelector('#status');
const retry = document.querySelector('#retry');
let state, view, loaded = false;

function showError(error) {
  notice.textContent = error.message || String(error);
  retry.hidden = false;
}
retry.onclick = () => location.reload();

function native(thread, type, fields = {}, onItem, onRestore) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    requests.set(id, {resolve, reject, onItem, onRestore});
    try { host.postMessage({type, thread, id, ...fields}); }
    catch (error) { requests.delete(id); reject(error); }
  });
}

function itemsFor(row, thread) {
  const common = {id: row.id, thread_id: thread, created_at: row.date};
  const buttons = (row.actions || []).map((label, index) => ({
    type:'Button', label, ...(row.question && index === 1 ? {variant:'outline'} : {}),
    onClickAction:{type:'pachca.open', handler:'client', payload:{row:row.id, index}}
  }));
  if (row.question) {
    const {chat, author, incoming} = row.question;
    const direct = chat?.startsWith('Личные сообщения: ');
    const source = direct ? (author || chat.slice('Личные сообщения: '.length)) : author;
    const children = [
      {type:'Caption', value:'Вопрос Codex', color:'#c2baff', weight:'semibold'},
      {type:'Text', value:row.text, weight:'semibold'},
    ];
    const quote = [{type:'Caption', value:direct ? 'Личная переписка' : chat || 'Сообщение из Пачки'}];
    if (source) quote.push({type:'Text', value:source, size:'sm', weight:'semibold'});
    if (incoming) quote.push({type:'Text', value:incoming, size:'sm'});
    children.push({type:'Col', gap:1, padding:3, radius:'md', background:'#252630', children:quote});
    if (buttons.length) children.push({type:'Row', wrap:'wrap', gap:2, children:buttons});
    return [{...common, type:'widget', widget:{type:'Card', children}}];
  }
  if (row.kind === 'status' || row.kind === 'error') {
    const error = row.kind === 'error';
    return [{...common, type:'widget', widget:{type:'Card', children:[
      {type:'Caption', value:error ? 'Ошибка' : 'Система', color:error ? '#ffb0a9' : '#b6cbcf', weight:'semibold'},
      {type:'Text', value:row.text, size:'sm'}, ...buttons
    ]}}];
  }
  const item = row.owner ? {...common, type: 'user_message', inference_options: {},
    content: row.text ? [{type:'input_text', text:row.text}] : [],
    attachments: (row.previews || []).map((preview, index) => ({
      type:'image', id:row.id + '-img-' + index, name:'Изображение.png',
      mime_type:'image/png', preview_url:'data:image/png;base64,' + preview
    }))} : {...common, type:'assistant_message', content:[{type:'output_text', text:row.text, annotations:[]}]};
  if (!buttons.length) return [item];
  return [item, {...common, id:row.id + '-actions', type:'widget', widget:{type:'Card', children:buttons}}];
}

function sse(run) {
  const encoder = new TextEncoder();
  let cancelled = false;
  return new Response(new ReadableStream({
    async start(controller) {
      const emit = event => {
        if (!cancelled) controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n'));
      };
      try { await run(emit); }
      catch (error) { emit({type:'error', code:'custom', message:error.message, allow_retry:false}); }
      finally { if (!cancelled) controller.close(); }
    },
    cancel() { cancelled = true; }
  }), {headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store'}});
}

function asDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Не удалось прочитать вложение.'));
    reader.readAsDataURL(file);
  });
}

function mount(current) {
  const thread = current.thread;
  const files = new Map();
  const el = document.createElement('openai-chatkit');
  const next = {el, thread, revision:current.revision, busy:false, ready:false, pages:1};
  view = next;
  document.querySelector('#chat').replaceChildren(el);
  const api = async (input, init) => {
    const request = new Request(input, init);
    if (view !== next) throw new Error('Чат уже закрыт.');
    if (request.url === uploadUrl) {
      const form = await request.formData();
      const file = [...form.values()].find(value => value instanceof Blob);
      if (!file || !['image/png','image/jpeg','image/webp','image/gif','image/bmp'].includes(file.type) ||
          file.size > 4 * 1024 * 1024 || files.size >= 3) throw new Error('Можно приложить до трёх изображений по 4 МБ.');
      const id = crypto.randomUUID();
      const preview = await asDataUrl(file);
      const attachment = {id, type:'image', name:file.name, mime_type:file.type, preview_url:preview};
      files.set(id, attachment);
      return Response.json(attachment);
    }
    if (request.url !== endpoint || request.method !== 'POST') throw new Error('Неизвестный запрос ChatKit.');
    const {type, params = {}} = await request.json();
    if (params.thread_id && params.thread_id !== thread) throw new Error('Профиль чата изменился.');
    const history = async (params = {}) => {
      const list = await native(thread, 'history', {
        limit:params.limit ?? 24, after:params.after?.replace(/-actions$/, ''), order:params.order || 'asc'
      });
      const data = list.rows.flatMap(row => {
        const items = itemsFor(row, thread);
        return params.order === 'desc' ? items.reverse() : items;
      });
      return {data, has_more:list.more, after:list.more ? data.at(-1)?.id : null};
    };
    const metadata = {id:thread, title:'Локальный Codex', status:{type:'active'},
      created_at:new Date().toISOString(), metadata:{}};
    if (type === 'threads.get_by_id') {
      const revision = state.revision;
      if (next.cacheRevision !== revision) {
        next.history = [];
        next.cacheRevision = revision;
      }
      while (next.history.length < next.pages) {
        const previous = next.history.at(-1);
        if (previous && !previous.has_more) break;
        const page = await history({limit:16, order:'desc', after:previous?.after});
        if (view !== next || state.revision !== revision) break;
        next.history.push(page);
      }
      if (view !== next) throw new Error('Чат уже закрыт.');
      next.more = Boolean(next.history.at(-1)?.has_more);
      next.revision = revision;
      return Response.json({...metadata, items:{data:next.history.flatMap(page => page.data).reverse(), has_more:false, after:null}});
    }
    if (type === 'items.list') {
      const revision = state.revision;
      const page = await history(params);
      next.revision = revision;
      return Response.json(page);
    }
    if (type === 'threads.list') return Response.json({data:[metadata], has_more:false, after:null});
    if (type === 'attachments.delete') { files.delete(params.attachment_id); return Response.json({}); }
    if (!['threads.add_user_message','threads.create'].includes(type)) throw new Error('Эта операция недоступна в Пачке.');
    return sse(async emit => {
      if (next.busy || !state.available) throw new Error('Локальный Codex сейчас недоступен.');
      next.busy = true;
      try {
        if (type === 'threads.create') emit({type:'thread.created',thread:{...metadata,items:{data:[],has_more:false,after:null}}});
        emit({type:'stream_options',stream_options:{allow_cancel:false}});
        const message = params.input;
        const text = message.content.map(part => part.text || '').join('');
        const attachments = message.attachments.map(id => {
          const attachment = files.get(id);
          if (!attachment) throw new Error('Прикрепите изображение ещё раз.');
          return attachment;
        });
        const images = attachments.map(a => a.preview_url.split(',')[1]);
        let restore = false;
        await native(thread, 'submit', {text, images}, row => {
          for (const item of itemsFor(row, thread)) emit({type:'thread.item.done',item});
        }, () => { restore = true; });
        if (restore) next.draft = {text, attachments};
        else for (const id of message.attachments) files.delete(id);
      } finally { next.busy = false; }
    });
  };

  el.addEventListener('chatkit.ready', () => {
    if (view !== next) return;
    next.ready = true;
    publishReply();
    notice.textContent = state.notice;
    retry.hidden = true;
    sync();
  });
  el.addEventListener('chatkit.error', e => { if (view === next) showError(e.detail.error); });
  el.addEventListener('chatkit.response.start', () => { next.responding = true; });
  el.addEventListener('chatkit.response.end', () => {
    if (view !== next) return;
    next.responding = false;
    if (next.draft) {
      el.setComposerValue(next.draft).catch(showError);
      next.draft = null;
    }
    setTimeout(sync, 0);
  });
  el.setOptions({
    api:{url:endpoint, domainKey:'domain_pk_localhost_dev', fetch:api, uploadStrategy:{type:'direct',uploadUrl}},
    initialThread:thread, locale:'ru', theme:{colorScheme:'dark',density:'compact'},
    header:{enabled:false}, history:{enabled:false}, threadItemActions:{feedback:false,retry:false}, frameTitle:'Чат с локальным Codex',
    composer:{placeholder:'Написать Codex', attachments:{enabled:true,maxCount:3,maxSize:4194304,
      accept:{'image/png':['.png'],'image/jpeg':['.jpg','.jpeg'],'image/gif':['.gif'],'image/bmp':['.bmp']}}},
    widgets:{onAction:async action => {
      if (view === next && action.type === 'pachca.open') {
        try { await native(thread, 'action', {row:action.payload.row,index:action.payload.index}); }
        catch (error) { showError(error); }
      }
    }}
  });
}

function sync() {
  if (!state || !loaded) return;
  if (!state.connected && !state.signedIn) {
    view = null;
    document.querySelector('#chat').replaceChildren();
    notice.textContent = state.notice || 'Подключите локальный Codex в настройках агента.';
    return;
  }
  if (view?.thread !== state.thread) { mount(state); return; }
  if (view.ready && retry.hidden) notice.textContent = state.notice || (state.connected ? '' : 'Нет соединения с локальным Codex.');
  const needsRefresh = active => active.revision !== state.revision || (active.more && active.history.length < active.pages);
  if (view.ready && !view.busy && !view.responding && !view.refreshing && needsRefresh(view)) {
    const active = view;
    active.refreshing = true;
    active.el.fetchUpdates().catch(showError).finally(() => {
      active.refreshing = false;
      if (active === view && retry.hidden && needsRefresh(active)) setTimeout(sync, 250);
    });
  }
}

const chatkitOrigin = 'https://cdn.platform.openai.com';
function composerFrame() {
  const el = view?.el;
  if (!el) return null;
  const frame = el.querySelector('iframe') || el.shadowRoot?.querySelector('iframe');
  return frame?.contentWindow || (window.frames.length === 1 ? window.frames[0] : null);
}
function publishReply() {
  composerFrame()?.postMessage({type:'pachca.reply',reply:state?.reply || null},chatkitOrigin);
}
window.addEventListener('message', e => {
  if (e.origin !== chatkitOrigin || e.source !== composerFrame()) return;
  if (e.data?.type === 'pachca.history.older' && view.more && !view.refreshing && !view.busy && !view.responding) {
    e.source.postMessage({type:'pachca.history.loading'},chatkitOrigin);
    view.pages = view.history.length + 1;
    sync();
  }
  if (e.data?.type === 'pachca.reply.ready') publishReply();
  if (e.data?.type === 'pachca.reply.clear' && state?.reply?.canClear && state.reply.key === e.data.key)
    native(view.thread,'clearReply',{key:e.data.key}).catch(showError);
});
host.addEventListener('message', ({data}) => {
  if (data.type === 'state') { state = data; sync(); publishReply(); return; }
  if (data.type === 'focus') { if (view?.ready) view.el.focusComposer().catch(() => {}); return; }
  const pending = requests.get(data.id);
  if (!pending) return;
  if (data.type === 'item') { pending.onItem?.(data.row); return; }
  if (data.type === 'restoreDraft') { pending.onRestore?.(); return; }
  if (data.type === 'result') {
    requests.delete(data.id);
    if (data.error) pending.reject(new Error(data.error));
    else pending.resolve(data.result);
  }
});

host.postMessage({type:'ready'});
const script = document.createElement('script');
script.src = 'https://cdn.platform.openai.com/deployments/chatkit/chatkit.js';
script.onerror = () => showError(new Error('Не удалось загрузить ChatKit. Проверьте доступ к CDN OpenAI.'));
script.onload = async () => {
  await customElements.whenDefined('openai-chatkit');
  loaded = true;
  sync();
};
document.head.append(script);
