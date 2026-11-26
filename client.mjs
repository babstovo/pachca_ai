import { randomUUID } from 'node:crypto';
import { openSession, webRequest, workspaces } from './session.mjs';
import { callWatcher } from './watch-pipe.mjs';
import { uploadFile, uploadImage } from './images.mjs';
import { formatTaskLinks } from './task-links.mjs';

const searchTypes = new Map([['chats', 'chat'], ['users', 'user'], ['messages', 'message']]);

export function positiveInteger(value, label) {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} должен быть положительным целым числом.`);
  }
  return number;
}

function limit(value) {
  const number = positiveInteger(value ?? '20', '--limit');
  if (number > 30) throw new Error('--limit должен быть от 1 до 30.');
  return number;
}

function normalizeMessage(content, hasImages = false) {
  if (typeof content !== 'string') throw new Error('Введите непустой текст.');
  content = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!content.trim() && !hasImages) throw new Error('Введите непустой текст.');
  if (content.length > 16_000) throw new Error('Текст должен занимать не более 16 000 символов.');
  return content;
}

export async function existingMessageThread(api, parent) {
  if (!parent.thread_id) return null;
  const result = await api('/threads', { query: { ids: [parent.thread_id], limit: 1 } });
  const thread = result?.data?.find(entry => entry.id === parent.thread_id &&
    (entry.message_id == null || entry.message_id === parent.id) &&
    (entry.message_chat_id == null || entry.message_chat_id === parent.chat_id));
  if (!thread?.chat_id) throw new Error(`Тред сообщения ${parent.id} недоступен.`);
  return thread;
}

export function selectProfile(profiles, requestedId) {
  if (!profiles.length) {
    const error = new Error('Войдите в пространство Пачки через login.');
    error.code = 'PACHCA_LOGIN_REQUIRED';
    throw error;
  }
  if (requestedId === undefined && profiles.length === 1) return profiles[0].profile_id;
  if (requestedId !== undefined && profiles.some(profile => String(profile.profile_id) === String(requestedId))) {
    return requestedId;
  }
  throw new Error('Укажите --profile ID пространства из вывода profiles.');
}

async function runCommand(api, command, values, [first, second], text) {
  const page = () => ({ limit: limit(values.limit), cursor: values.cursor });
  const history = chatId => api('/messages', { query: {
    chat_id: chatId, per: limit(values.limit), direction: values.before === undefined ? 'around' : 'early',
    message_id: values.before === undefined ? undefined : positiveInteger(values.before, '--before'),
  } });
  const message = async id => {
    const messages = await api('/messages', { query: { ids: [id] } });
    const found = messages.find(item => String(item.id) === String(id));
    if (!found) throw new Error(`Сообщение ${id} недоступно в выбранном пространстве.`);
    return found;
  };

  switch (command) {
    case 'folders':
      return api('/menu/folders');
    case 'chats': {
      const folder = positiveInteger(first, 'FOLDER_ID');
      return api(`/menu/folders/${folder}/chats`, { query: { ...page(), direction: 'early' }, version: '3.7' });
    }
    case 'search': {
      const type = searchTypes.get(first);
      if (!type || !second.trim()) throw new Error('Укажите chats, users или messages и непустой запрос.');
      return api('/search', { query: { ...page(), type, query: second } });
    }
    case 'message':
      return message(positiveInteger(first, 'MESSAGE_ID'));
    case 'history':
      return history(positiveInteger(first, 'CHAT_ID'));
    case 'thread': {
      const parent = await message(positiveInteger(first, 'PARENT_MESSAGE_ID'));
      const thread = await existingMessageThread(api, parent);
      return { parent, thread, messages: thread ? await history(thread.chat_id) : [] };
    }
    case 'send': {
      if (!['chat', 'user', 'thread'].includes(first)) throw new Error('Укажите получателя: chat, user или thread.');
      const target = positiveInteger(second, 'ID');
      const parentMessageId = values.quote === undefined ? undefined : positiveInteger(values.quote, '--quote');
      let chatId = target;
      if (first === 'user') {
        const dm = await api('/chats', { method: 'POST', body: { personal: true, user_id: target } });
        chatId = dm?.id;
        if (!chatId) throw new Error('Пачка не вернула ID личного чата.');
      }
      if (first === 'thread') {
        const parent = await message(target);
        if (parent.deleted_at || (values.parentChatId !== undefined && parent.chat_id !== values.parentChatId))
          throw new Error('Исходное сообщение недоступно в открытом чате.');
        const current = await existingMessageThread(api, parent);
        const thread = current ?? (await api(`/messages/${target}/thread`, { method: 'POST' }))?.data;
        chatId = thread?.chat_id;
        if (!chatId) throw new Error('Пачка не вернула ID чата треда.');
      }

      const files = [];
      if (values.document) files.push(await uploadFile(api,values.document,'text/html'));
      for (const image of values.clipboardImages ?? []) {
        try { files.push(await uploadImage(api, image)); }
        catch (error) { throw new Error(`Картинка не загружена. ${error.message}`, { cause: error }); }
      }
      const formatted = formatTaskLinks(text);
      if (values.checkContext) await values.checkContext(chatId);
      values.beforeSend?.();
      const uuid = randomUUID();
      const result = await api('/messages', { method: 'POST', body: {
        chat_id: chatId,
        message: {
          uuid, text:formatted.text, markup:formatted.markup, kind: 0, files, skip_invite_mentions: false,
          parent_message_id: parentMessageId,
        },
      } });
      const saved = result?.data ?? result;
      if (values.document && Array.isArray(saved?.files) && !saved.files.some(file => file.name === values.document.name))
        throw Error('Пачка приняла сообщение, но не подтвердила вложение. Проверьте переписку.');
      return { accepted: true, chat_id: chatId, uuid, message_id: result?.id ?? result?.data?.id };
    }
  }
}

export async function useSession(session, command, values = {}, positionals = [], text) {
  if (command === 'send') text = normalizeMessage(text, Boolean(values.document || values.clipboardImages?.length));
  const request = webRequest(session);
  const available = await workspaces(request);
  const profiles = session.profileId ? available.filter(p => p.profile_id === session.profileId) : available;
  if (command === 'profiles') return profiles;
  const requestedId = values.profile === undefined ? undefined : positiveInteger(values.profile, 'profile');
  const profileId = selectProfile(profiles, requestedId);
  return runCommand((path, options) => request(path, { ...options, profileId }), command, values, positionals, text);
}

export async function runPachca(command, values, positionals, text) {
  if (command === 'send') text = normalizeMessage(text);
  const relayed = await callWatcher({ command, values, positionals, text });
  if (relayed !== undefined) return relayed.data;
  const session = await openSession();
  try {
    return await useSession(session, command, values, positionals, text);
  } finally {
    await session.close();
  }
}
