(() => {
  if (window !== window.top || location.origin !== 'https://app.pachca.com') return;

  const maxBytes = 8 * 1024 * 1024;
  const cardSelector = '[class~="group/file"]';
  const buttons = new WeakMap();

  function updateButton(owner) {
    // A file card links both its filename and its hover icon to the same download.
    const download = owner.matches(cardSelector) ? owner.querySelector('a[download][href]') : owner;
    const existing = buttons.get(owner);
    const available = download?.isConnected && download.hasAttribute('href') && /\.html?$/i.test(download.download);
    if (available && existing?.download === download && existing.button === download.nextElementSibling) return;
    existing?.button.remove();
    buttons.delete(owner);
    if (!available) return;

    const button = document.createElement('button');
    buttons.set(owner, { download, button });
    button.type = 'button';
    button.textContent = 'Открыть интерактивно';
    button.style.cssText = 'align-self:center;max-width:100%;margin:2px 0;padding:3px 8px;border:1px solid #697388;border-radius:6px;background:#242831;color:white;cursor:pointer';
    download.after(button);
    button.addEventListener('click', async event => {
      event.stopPropagation();
      if (!event.isTrusted || button.disabled) return;
      button.disabled = true;
      button.textContent = 'Открываем…';
      try {
        const url = new URL(download.href);
        if (url.protocol !== 'https:') throw new Error('Недоступна ссылка на оригинал');
        const credentials = /(^|\.)pachca\.com$/i.test(url.hostname) && !url.searchParams.has('X-Amz-Signature') ? 'include' : 'omit';
        const response = await fetch(url, { credentials, signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('Не удалось загрузить оригинал');
        const limitMessage = 'Файл больше 8 МБ — используйте скачивание';
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maxBytes) {
            await reader.cancel();
            throw new Error(limitMessage);
          }
          chunks.push(value);
        }
        const fileReader = new FileReader();
        const encoded = new Promise((resolve, reject) => {
          fileReader.onload = () => resolve(fileReader.result.split(',')[1]);
          fileReader.onerror = () => reject(new Error('Не удалось прочитать файл'));
        });
        fileReader.readAsDataURL(new Blob(chunks));
        const data = await encoded;
        if (button.isConnected && download.isConnected && download.href === url.href) {
          window.chrome.webview.postMessage({ type: 'html-attachment', name: download.download, data });
        }
        button.textContent = 'Открыть интерактивно';
      } catch (error) {
        button.textContent = error.message.includes('8 МБ') ? error.message : 'Не удалось открыть. Повторить';
      } finally {
        button.disabled = false;
      }
    });
  }

  function collect(node, owners) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const add = link => owners.add(link.closest(cardSelector) || link);
    if (node.matches('a[download]')) add(node);
    node.querySelectorAll('a[download]').forEach(add);
  }
  new MutationObserver(records => {
    const owners = new Set();
    for (const record of records) {
      const card = record.target.closest?.(cardSelector);
      if (card) owners.add(card);
      if (record.type === 'attributes') {
        if (!card && record.target.matches('a')) owners.add(record.target);
      } else {
        record.removedNodes.forEach(node => collect(node, owners));
        record.addedNodes.forEach(node => collect(node, owners));
      }
    }
    owners.forEach(updateButton);
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['download', 'href'] });
  const initial = new Set();
  if (document.documentElement) collect(document.documentElement, initial);
  initial.forEach(updateButton);
})();
