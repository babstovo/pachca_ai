import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { login, openSession } from './session.mjs';
import { runPachca } from './client.mjs';

const invocation = process.env.PACHCA_PORTABLE === '1' ? 'pachca.exe' : 'node pachca.mjs';
const profileOption = { profile: { type: 'string' } };
const listOptions = { limit: { type: 'string' }, cursor: { type: 'string' } };
const commands = {
  dashboard: ['dashboard [--profile ID]', 0],
  login: ['login', 0],
  'openproject-login': ['openproject-login', 0],
  'openproject-tasks': ['openproject-tasks [--limit N]', 0, { limit: { type: 'string' } }],
  connect: ['connect', 0],
  'mcp-config': ['mcp-config', 0],
  mcp: ['mcp', 0],
  watch: ['watch [--profile ID]', 0],
  'watch-status': ['watch-status', 0],
  'stop-watch': ['stop-watch', 0],
  inbox: ['inbox', 0],
  profiles: ['profiles', 0],
  folders: ['folders', 0],
  chats: ['chats FOLDER_ID [--limit N] [--cursor CURSOR]', 1, listOptions],
  search: ['search chats|users|messages "запрос" [--limit N] [--cursor CURSOR]', 2, listOptions],
  message: ['message MESSAGE_ID', 1],
  history: ['history CHAT_ID [--limit N] [--before MESSAGE_ID]', 1, {
    limit: { type: 'string' }, before: { type: 'string' },
  }],
  thread: ['thread PARENT_MESSAGE_ID [--limit N] [--before MESSAGE_ID]', 1, {
    limit: { type: 'string' }, before: { type: 'string' },
  }],
  send: ['send chat|user|thread ID (--file FILE | --stdin | --text "текст") [--quote MESSAGE_ID]', 2, {
    file: { type: 'string' }, stdin: { type: 'boolean' }, text: { type: 'string' }, quote: { type: 'string' },
  }],
};

function parseCommand(command, args) {
  if (!Object.hasOwn(commands, command)) throw new Error('Неизвестная команда. См. --help.');
  const [usage, count, commandOptions] = commands[command];
  const options = ['login', 'openproject-login', 'openproject-tasks', 'profiles', 'connect', 'mcp-config', 'mcp', 'inbox',
    'watch-status', 'stop-watch'].includes(command)
    ? commandOptions ?? {} : { ...profileOption, ...commandOptions };
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true });
    if (parsed.positionals.length === count) return parsed;
  } catch {
    // The usage line contains the command's valid options.
  }
  const suffix = options.profile ? ' [--profile ID]' : '';
  throw new Error(`Использование: ${invocation} ${usage}${suffix}`);
}

async function readText({ file, stdin, text }) {
  if ([file !== undefined, Boolean(stdin), text !== undefined].filter(Boolean).length !== 1) {
    throw new Error('Укажите один источник текста: --file, --stdin или --text.');
  }
  let content = text;
  if (file !== undefined) content = await readFile(file, 'utf8');
  if (stdin) {
    if (process.stdin.isTTY) throw new Error('Передайте текст в UTF-8 через stdin или используйте --file.');
    process.stdin.setEncoding('utf8');
    content = '';
    for await (const chunk of process.stdin) content += chunk;
  }
  return content;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'mcp' && args.length === 2 && args[0] === '--binding' && /^[0-9a-f-]{36}$/.test(args[1])) {
    const { serveMcp } = await import('./mcp.mjs');
    return serveMcp(args[1]);
  }
  if (command === 'desktop-host' && args.length === 1 && /^\d+$/.test(args[0])) {
    const { desktopSession } = await import('./desktop-session.mjs');
    const { watchPachca } = await import('./watch.mjs');
    return watchPachca(Number(args[0]), { host: desktopSession(Number(args[0])) });
  }
  if (['desktop-start', 'desktop-resume', 'desktop-state', 'desktop-logout', 'desktop-auto-reply', 'desktop-answer', 'desktop-draft', 'desktop-delegate', 'desktop-profile', 'desktop-save-profile',
    'desktop-participants', 'desktop-participant', 'desktop-save-participant', 'desktop-index-participants', 'desktop-find-participants',
    'desktop-projects', 'desktop-save-projects', 'desktop-codex-projects', 'desktop-models', 'desktop-save-model',
      'desktop-confirmation', 'desktop-dismiss-question', 'desktop-review-draft',
    'desktop-openproject-key-state', 'desktop-openproject-key', 'desktop-openproject-remove-key', 'desktop-openproject-status', 'desktop-task-profile',
    'desktop-task-board', 'desktop-overlay-statuses', 'desktop-task-workflow', 'desktop-task-update', 'desktop-task-detail',
    'desktop-task-comments', 'desktop-task-fields', 'desktop-task-edit', 'desktop-task-comment',
    'desktop-task-codex-info', 'desktop-task-codex-start', 'desktop-task-codex-open',
    'desktop-codex-status', 'desktop-codex-connect', 'desktop-agent-enable', 'desktop-agent-disable', 'desktop-agent-link', 'desktop-available-models',
    'desktop-activity', 'desktop-activity-cancel', 'desktop-compose', 'desktop-compose-read', 'desktop-compose-send'].includes(command) && !args.length) {
    const { desktop } = await import('./desktop.mjs');
    return desktop(command);
  }
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log([`Использование: ${invocation} <команда>`, '',
      ...Object.values(commands).map(([usage]) => `  ${usage}`), '',
      'При нескольких пространствах укажите --profile ID из вывода profiles.'].join('\n'));
    return;
  }

  const { values, positionals } = parseCommand(command, args);
  if (command === 'dashboard') {
    const { openDashboard } = await import('./dashboard.mjs');
    return openDashboard(values.profile);
  }
  if (command === 'openproject-login') {
    console.error('Войдите в OpenProject в открывшемся окне Edge. После проверки доступа оно закроется.');
    const { loginOpenProject } = await import('./openproject.mjs');
    return console.log(JSON.stringify(await loginOpenProject(), null, 2));
  }
  if (command === 'openproject-tasks') {
    const { myBoardTasks } = await import('./openproject.mjs');
    return console.log(JSON.stringify(await myBoardTasks(values.limit === undefined ? undefined : Number(values.limit)), null, 2));
  }
  if (command === 'mcp') {
    const { serveMcp } = await import('./mcp.mjs');
    return serveMcp();
  }
  if (command === 'connect' || command === 'mcp-config') {
    const { connectCodex, configSnippet, saveAgentLink } = await import('./codex.mjs');
    if (command === 'mcp-config') return console.log(configSnippet());
    try {
      await connectCodex();
      await saveAgentLink({ enabled: true, mode: 'cli' });
    } catch (error) {
      throw new Error(`${error.message}\nОткройте пользовательский config.toml в Codex и добавьте блок:\n\n${configSnippet()}`);
    }
    return console.log('Пачка подключена к пользовательским настройкам Codex. Откройте новый чат.');
  }
  if (command === 'watch') {
    const { watchPachca } = await import('./watch.mjs');
    return watchPachca(values.profile);
  }
  if (command === 'watch-status' || command === 'stop-watch') {
    const { callWatcher } = await import('./watch-pipe.mjs');
    const state = await callWatcher({ command });
    return console.log(JSON.stringify(state?.data ?? { running: false }, null, 2));
  }
  if (command === 'inbox') {
    const { latestDrafts } = await import('./watch.mjs');
    return console.log(JSON.stringify(await latestDrafts(), null, 2));
  }
  const text = command === 'send' ? await readText(values) : undefined;
  if (command !== 'login') {
    console.log(JSON.stringify(await runPachca(command, values, positionals, text), null, 2));
    return;
  }

  console.error('Войдите в Пачку в открывшемся окне Edge. После входа оно закроется.');
  const { callWatcher } = await import('./watch-pipe.mjs');
  if ((await callWatcher({ command: 'watch-status' }))?.data.running) {
    throw new Error('Профиль Edge занят наблюдением Пачки. Откройте pachca.exe для журнала. Для повторного входа сначала выполните stop-watch.');
  }
  const session = await openSession(true);
  try {
    console.log(JSON.stringify(await login(session), null, 2));
  } finally {
    await session.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
