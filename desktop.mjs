import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { openDashboard } from './dashboard.mjs';
import { callWatcher } from './watch-pipe.mjs';
import { localCodexState, readAgentLink, saveAgentLink, listCodexModels } from './codex.mjs';
import { clientBinding, configureClient, clientEnabled } from './mcp-client.mjs';
import { normalizeCommunicationProfile } from './communication-profile.mjs';
import { configuredBoard } from './workspace-settings.mjs';
import { assignedTaskAction, assignedTaskBoard, assignedTaskWorkflow, configuredTaskProfile, hasOpenProjectKey,
  removeOpenProjectKey, saveOpenProjectKey, updateAssignedTaskStatus } from './openproject.mjs';
import { readProjects, saveProjects } from './projects.mjs';
import { clientDataDir } from './session.mjs';

export async function desktop(command) {
  if (command === 'desktop-start' || command === 'desktop-resume') {
    const active = (await callWatcher({ command: 'watch-status' }))?.data;
    if (active?.desktop_chat_version === 44) return;
    if (active?.running) {
      await callWatcher({ command: 'stop-watch' });
      for (let attempt = 0; attempt < 40; attempt++) {
        if (!(await callWatcher({ command: 'watch-status' }))?.data?.running) break;
        await delay(400);
      }
      if ((await callWatcher({ command: 'watch-status' }))?.data?.running) throw new Error('Не удалось остановить предыдущий процесс.');
      await delay(700);
    }
    return openDashboard(active?.profile_id, { interactive: command === 'desktop-start' });
  }

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (command === 'desktop-task-profile') {
    console.log(JSON.stringify({ profile_id: await configuredTaskProfile(input.profiles) }));
    return;
  }
  if (input.standalone && command.startsWith('desktop-task-')) {
    const profile = input.profile_id;
    if (!Number.isSafeInteger(profile) || profile <= 0) throw Error('Выберите пространство Пачки для доски задач.');
    const action = command.slice('desktop-'.length);
    let result;
    switch (action) {
      case 'task-board': result = await assignedTaskBoard(profile, input); break;
      case 'task-workflow': result = await assignedTaskWorkflow(profile, input); break;
      case 'task-update': result = await updateAssignedTaskStatus(profile, input); break;
      case 'task-detail': case 'task-fields': case 'task-comments': case 'task-edit': case 'task-comment':
        result = await assignedTaskAction(profile, action, input); break;
      case 'task-codex-info':
        result = { repositories: [], selectedFolders: [], message: 'Для работы с проектами Codex подключите агента.' }; break;
      default: throw Error('Для работы с проектами Codex подключите агента.');
    }
    console.log(JSON.stringify(result));
    return;
  }
  if (command === 'desktop-available-models') {
    console.log(JSON.stringify({ items: await listCodexModels(), selected: '', effort: '' }));
    return;
  }
  if (command === 'desktop-agent-link') {
    console.log(JSON.stringify(await readAgentLink() || {}));
    return;
  }
  if (['desktop-openproject-key-state', 'desktop-openproject-key', 'desktop-openproject-remove-key'].includes(command)) {
    const profile = input.profile_id;
    if (!Number.isSafeInteger(profile) || profile <= 0) throw new Error('Выберите пространство Пачки для ключа OpenProject.');
    if (command === 'desktop-openproject-key-state') {
      const board = configuredBoard();
      console.log(JSON.stringify({configured:await hasOpenProjectKey(profile, board), boardUrl:board?.href ?? null}));
      return;
    }
    const save = command === 'desktop-openproject-key';
    const watcher = (await callWatcher({command:'watch-status'}))?.data;
    if (watcher?.profile_id === profile && watcher.desktop_chat_version === 44) {
      const reply = await callWatcher({command:save ? 'openproject-save-key' : 'openproject-remove-key', values:input});
      if (reply) { console.log(JSON.stringify(reply.data)); return; }
    }
    const result = save ? await saveOpenProjectKey(profile, input.key, input.boardUrl) : await removeOpenProjectKey(profile);
    if (save) {
      const file = join(clientDataDir(), `projects-${profile}.json`);
      const settings = await readProjects(file);
      if (!settings.openproject) await saveProjects(file, settings, {openproject:true});
    }
    console.log(JSON.stringify(result));
    return;
  }
  if (command === 'desktop-agent-enable') {
    const active = (await callWatcher({ command: 'watch-status' }))?.data;
    if (!active?.desktop_host || active.profile_id !== input.profile_id) throw new Error('Подключение к открытой Пачке прервалось.');
    const previous = await readAgentLink();
    const binding = clientBinding(input.client, input.file, previous);
    if (previous?.enabled && (previous.client || 'codex') !== binding.client && await clientEnabled(previous))
      throw new Error('Сначала отключите текущий MCP-клиент.');
    if (binding.client === 'codex' && typeof input.model === 'string') {
      await callWatcher({ command: 'codex-models', values: { profile_id: input.profile_id } });
      await callWatcher({ command: 'save-codex-model', values: input });
    }
    await configureClient(binding,true);
    try {
      if (!await clientEnabled(binding)) throw new Error('Не удалось подтвердить регистрацию MCP Пачки.');
      await saveAgentLink({ ...binding, enabled:true, profile_id:input.profile_id });
    } catch (error) {
      if (!previous?.enabled) await configureClient(binding,false);
      throw error;
    }
    console.log('{}');
    return;
  }
  if (command === 'desktop-agent-disable') {
    const link = await readAgentLink();
    await saveAgentLink({ ...link, enabled:false });
    await configureClient(link,false);
    console.log('{}');
    return;
  }
  if (command === 'desktop-codex-status' || command === 'desktop-codex-connect') {
    const link = await readAgentLink();
    const status = await localCodexState({ connect: command === 'desktop-codex-connect' }).catch(error => {
      if (link?.binding && command !== 'desktop-codex-connect') return {state:'error'};
      throw error;
    });
    const enabled = !!link?.enabled && (link.binding || status.state !== 'missing') && await clientEnabled(link);
    console.log(JSON.stringify({ ...status, client:link?.client || 'codex', file:link?.file,
      mcp_enabled: enabled, cli_link: enabled && link.mode === 'cli' }));
    return;
  }
  if (command === 'desktop-profile' || command === 'desktop-save-profile') {
    const result = await callWatcher({ command: command === 'desktop-profile' ? 'communication-profile' : 'save-communication-profile', values: input });
    if (!result) throw new Error('Подключитесь к Пачке, чтобы открыть настройки профиля.');
    const data = command === 'desktop-profile' ? { ...result.data, defaults: normalizeCommunicationProfile() } : result.data;
    console.log(JSON.stringify(data));
    return;
  }
  const replyCommands = { 'desktop-activity':'activity-list', 'desktop-activity-cancel':'activity-cancel', 'desktop-participants': 'participants', 'desktop-participant': 'participant',
    'desktop-save-participant': 'save-participant', 'desktop-index-participants': 'index-participants', 'desktop-find-participants': 'find-participants', 'desktop-answer': 'answer-question', 'desktop-draft': 'draft-question', 'desktop-delegate': 'delegate-question',
    'desktop-compose': 'compose-prepare', 'desktop-compose-read': 'compose-read', 'desktop-compose-send': 'compose-send',
    'desktop-logout': 'logout', 'desktop-auto-reply': 'auto-reply-setting', 'desktop-projects': 'project-settings',
    'desktop-save-projects': 'save-project-settings', 'desktop-codex-projects':'codex-projects', 'desktop-models': 'codex-models', 'desktop-save-model': 'save-codex-model',
    'desktop-confirmation': 'send-confirmation', 'desktop-dismiss-question': 'dismiss-question',
    'desktop-openproject-status': 'openproject-confirm-status',
    'desktop-task-board': 'task-board', 'desktop-task-workflow': 'task-workflow', 'desktop-task-update': 'task-update',
    'desktop-task-detail':'task-detail','desktop-task-fields':'task-fields','desktop-task-edit':'task-edit',
    'desktop-task-comments':'task-comments','desktop-task-comment':'task-comment',
    'desktop-task-codex-info':'task-codex-info','desktop-task-codex-start':'task-codex-start','desktop-task-codex-open':'task-codex-open' };
  if (Object.hasOwn(replyCommands, command)) {
    let result = await callWatcher({ command: replyCommands[command], values: input, text: input.text });
    if (command === 'desktop-compose' && result?.data?.lookup === true) {
      const { candidates, token } = result.data;
      if (candidates.length > 1) {
        console.log(JSON.stringify({ note:'В какой переписке искать?', lookup_token:token,
          lookup_choices:candidates.map(({label,type,id},index) => ({label, index, chat_id:type === 'chat' ? id : undefined})) }));
        return;
      }
      if (!candidates.length) throw new Error('Не удалось найти переписку.');
      try {
        result = await callWatcher({ command: 'compose-read', values: { token, index: 0, images: input.images } });
      } catch (error) {
        console.log(JSON.stringify({note:error.message, lookup_token:token}));
        return;
      }
    }
    if (!result) throw new Error('Клиент отключён. Подключитесь снова.');
    console.log(JSON.stringify(Array.isArray(result.data) ? { items: result.data } : result.data));
    return;
  }
  const status = (await callWatcher({ command: 'watch-status' }))?.data;
  if (!status?.desktop) return console.log(JSON.stringify({ status }));
  const questions = await callWatcher({ command: 'questions' });
  console.log(JSON.stringify({ status, questions: questions?.data }));
}
