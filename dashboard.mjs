import { setTimeout as delay } from 'node:timers/promises';
import { login, openSession } from './session.mjs';
import { printWatchEntry } from './watch-log.mjs';
import { callWatcher } from './watch-pipe.mjs';
import { watchPachca } from './watch.mjs';

async function watcherStatus() {
  return (await callWatcher({ command: 'watch-status' }))?.data;
}

async function followWatcher() {
  console.log('Подключаю окно к журналу работающего клиента. Ctrl+C закрывает просмотр.');
  let cursor;
  const stop = new AbortController();
  const onInterrupt = () => stop.abort();
  process.once('SIGINT', onInterrupt);
  try {
    while (!stop.signal.aborted) {
      const result = await callWatcher({ command: 'watch-logs', cursor });
      if (!result) {
        console.log('Наблюдение остановлено.');
        break;
      }
      const { instance, last, entries } = result.data;
      for (const entry of entries) printWatchEntry(entry);
      cursor = { instance, after: last };
      await delay(750, undefined, { signal: stop.signal });
    }
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
}

export async function openDashboard(profile, { interactive = true } = {}) {
  console.log('Пачка · журнал событий');
  console.log('В окне будут сообщения, автоответы и вопросы Codex к тебе.');
  const active = await watcherStatus();
  if (active?.logs) return followWatcher();
  if (active?.running) {
    console.log('Перезапускаю старый фоновый процесс, чтобы открыть журнал.');
    await callWatcher({ command: 'stop-watch' });
    const deadline = Date.now() + 15_000;
    while ((await watcherStatus())?.running && Date.now() < deadline) await delay(350);
    if ((await watcherStatus())?.running) throw new Error('Старый процесс ещё завершает работу. Откройте клиент снова через несколько секунд.');
    await delay(500);
    profile ??= active.profile_id;
  }

  try {
    return await watchPachca(profile);
  } catch (error) {
    if ((await watcherStatus())?.logs) return followWatcher();
    if (error.status !== 401 && error.code !== 'PACHCA_LOGIN_REQUIRED') throw error;
  }

  if (!interactive) return;
  console.log('Нужен вход в Пачку. Войдите в открывшемся окне Edge.');
  const session = await openSession(true);
  try {
    await login(session);
  } finally {
    await session.close();
  }
  return watchPachca(profile);
}
