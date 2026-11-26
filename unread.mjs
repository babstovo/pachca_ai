export async function unreadChatIds(get) {
  const response = await get('/chats/unread_ids');
  if (!Array.isArray(response?.data)) throw new Error('Пачка не вернула список непрочитанных чатов.');
  return [...new Set(response.data.filter(id => Number.isSafeInteger(id) && id > 0))];
}

export async function chatReadStates(get, ids) {
  const unique = [...new Set(ids)];
  const groups = [];
  for (let offset = 0; offset < unique.length; offset += 40) groups.push(unique.slice(offset, offset + 40));
  const pages = await Promise.all(groups.map(async group => {
    const result = await get('/chats/read_info', { ids: group });
    if (!Array.isArray(result?.data)) throw new Error('Пачка не вернула счётчики чатов.');
    return result.data;
  }));
  return new Map(pages.flat().filter(row => Number.isSafeInteger(row.id)).map(row => [row.id, row]));
}

export function unreadBadge(state, unreadById) {
  const count = state?.unread_message_counter;
  return {
    unread: unreadById || state?.unread === true || Number.isSafeInteger(count) && count > 0,
    unread_count: Number.isSafeInteger(count) && count > 0 ? count : 0,
    mentioned: state?.mentioned === true,
  };
}

// WebView can mark a DM read before the watcher reconnects. Inspect only the
// latest message, with a bounded lookback; recovered DMs are for owner review.
export async function recentReadDirectMessages(get, menu, states, profileId, since, handled, signal) {
  const candidates = new Map();
  for (const [id, chat] of menu) {
    const state = states.get(id);
    const last = state?.last_message_id;
    if (chat.personal === false || !Number.isSafeInteger(last) || unreadBadge(state, false).unread ||
        handled.has(`${profileId}:${last}`)) continue;
    candidates.set(last, id);
  }
  const ids = [...candidates.keys()];
  const result = [];
  for (let offset = 0; offset < ids.length; offset += 30) {
    signal.throwIfAborted();
    const rows = await get('/messages', { ids: ids.slice(offset, offset + 30) });
    for (const row of rows) {
      if (candidates.get(row.id) !== row.chat_id || row.user_id === profileId || !(Date.parse(row.created_at) >= since)) continue;
      const chat = menu.get(row.chat_id);
      if (chat.personal === true || (await get('/chats', { ids: [row.chat_id] })).records?.some(c => c.id === row.chat_id && c.personal === true))
        result.push(row);
    }
  }
  return result;
}

export async function markDisplayedChat(get, mark, id, through) {
  const state = (await chatReadStates(get, [id])).get(id);
  if (!state || !Number.isSafeInteger(state.last_message_id) || state.last_message_id > through) return { read: false };
  const indicator = unreadBadge(state, false);
  if (indicator.unread || indicator.mentioned) await mark(id);
  return { read: true };
}

export async function unreadMessages(get, id, state, signal) {
  // A chat manually marked as unread can have a badge but no new messages to answer.
  if (!Number.isSafeInteger(state?.unread_message_counter) || state.unread_message_counter < 1) return [];
  const lastRead = state.last_read_message_id ?? 0;
  const collected = new Map();
  let before;
  for (let page = 0; page < 10; page++) {
    signal.throwIfAborted();
    const rows = await get('/messages', { chat_id: id, per: 30, direction: before ? 'early' : 'around', message_id: before });
    if (!Array.isArray(rows)) throw new Error('Пачка не вернула непрочитанные сообщения.');
    const matched = rows.filter(row => row.chat_id === id && Number.isSafeInteger(row.id) && (!before || row.id < before));
    for (const row of matched) if (row.id > lastRead) collected.set(row.id, row);
    const oldest = Math.min(...matched.map(row => row.id));
    if (!matched.length || oldest <= lastRead) break;
    before = oldest;
  }
  return [...collected.values()].sort((first, second) => second.id - first.id);
}
