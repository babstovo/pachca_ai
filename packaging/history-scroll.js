(() => {
  if (window === parent || location.origin !== 'https://cdn.platform.openai.com') return;
  const hostOrigin = 'http://localhost';
  // ChatKit fetches new items on its own. Request the preceding page only
  // when the reader reaches the top of the message list.
  let anchor, requestedAnchor;
  function older(scroller) {
    const first = scroller.querySelector('[data-thread-item]');
    if (!first || first.closest('main') == null) return;
    requestedAnchor = {scroller, first, count:scroller.querySelectorAll('[data-thread-item]').length,
      top:first.getBoundingClientRect().top};
    parent.postMessage({type:'pachca.history.older'},hostOrigin);
  }
  document.addEventListener('scroll', event => {
    const el = event.target;
    if (el instanceof HTMLElement && el.scrollTop <= 8 && el.scrollHeight > el.clientHeight) older(el);
  }, true);
  // A short page can already be at the top and produce no scroll event.
  document.addEventListener('wheel', event => {
    if (event.deltaY >= 0 || !event.target.closest?.('main')) return;
    for (let el = event.target; el; el = el.parentElement) {
      if (!/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
      if (el.scrollTop <= 8) older(el);
      break;
    }
  }, {passive:true});
  new MutationObserver(() => {
    if (!anchor) return;
    const {scroller, first, count, top} = anchor;
    const rows = scroller.querySelectorAll('[data-thread-item]');
    if (rows.length <= count) return;
    const row = rows[rows.length - count];
    if (row.textContent !== first.textContent) return;
    anchor = null;
    scroller.scrollTop += row.getBoundingClientRect().top - top;
  }).observe(document, {subtree:true,childList:true});
  window.addEventListener('message', e => {
    if (e.origin === hostOrigin && e.source === parent && e.data?.type === 'pachca.history.loading') anchor = requestedAnchor;
  });
})();
