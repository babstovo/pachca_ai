// Installed by the desktop host in its agent WebView. Keep the reply target
// next to ChatKit's own composer as the footer resizes or is remounted.
(() => {
  if (window === parent || location.origin !== 'https://cdn.platform.openai.com') return;
  const hostOrigin = 'http://localhost';
  function styleMessages() {
    const style = document.createElement('style');
    style.textContent = `
      [data-thread-item="assistant-message"] {border-inline-start:2px solid #54516b;padding-inline-start:12px;margin-block:8px}
      [data-thread-item="assistant-message"]::before,
      [data-thread-item="user-message"]::before {display:block;font:600 12px/18px "Segoe UI",sans-serif;margin-bottom:4px}
      [data-thread-item="assistant-message"]::before {content:"Codex";color:#c2baff}
      [data-thread-item="user-message"]::before {content:"Вы";color:#c0c6cf;text-align:end}
    `;
    document.head.append(style);
  }
  if (document.head) styleMessages();
  else document.addEventListener('DOMContentLoaded',styleMessages,{once:true});
  let reply, bar, label, clear;
  function mount() {
    if (!reply) return;
    const composer = document.querySelector('[data-composer-root]');
    if (!composer || (bar?.isConnected && bar.nextElementSibling === composer)) return;
    if (!bar) {
      bar = document.createElement('div');
      bar.setAttribute('role','group');
      bar.setAttribute('aria-label','Адресат ответа');
      bar.style.cssText = 'display:flex;align-items:center;gap:8px;margin:0 6px 4px;padding:3px 8px;border-left:2px solid #898dfb;border-radius:4px;background:#292a31;color:#ececf2;font:13px/20px "Segoe UI",sans-serif';
      label = document.createElement('span');
      label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      clear = document.createElement('button');
      clear.type = 'button'; clear.textContent = '×'; clear.title = 'Отменить ответ на вопрос';
      clear.setAttribute('aria-label',clear.title);
      clear.style.cssText = 'background:none;border:0;color:inherit;cursor:pointer;font-size:17px;padding:0 6px';
      clear.onclick = () => { if (reply?.canClear) parent.postMessage({type:'pachca.reply.clear',key:reply.key},hostOrigin); };
      bar.append(label,clear);
    }
    composer.before(bar);
    update();
  }
  function update() {
    if (!bar || !reply) return;
    const title = 'Вопрос из «'+reply.title+'»';
    if (label.textContent !== title) label.textContent = label.title = title;
    clear.disabled = !reply.canClear;
  }
  const observer = new MutationObserver(mount);
  window.addEventListener('message',e => {
    if (e.origin !== hostOrigin || e.source !== parent) return;
    if (e.data?.type !== 'pachca.reply') return;
    reply = e.data.reply;
    if (!reply) { observer.disconnect(); bar?.remove(); return; }
    observer.observe(document,{subtree:true,childList:true});
    mount(); update();
  });
  parent.postMessage({type:'pachca.reply.ready'},hostOrigin);
})();
