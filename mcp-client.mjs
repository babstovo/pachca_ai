import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { mcpCommand, connectCodex, codexMcpEnabled } from './codex.mjs';

const key = 'pachca_local';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function clientBinding(client = 'codex', file, previous) {
  if (client === 'codex') return {client};
  if (client === 'copilot') file = join(process.env.COPILOT_HOME || join(homedir(), '.copilot'), 'mcp-config.json');
  else if (client !== 'custom') throw new Error('Выберите MCP-клиент из списка.');
  if (typeof file !== 'string' || !isAbsolute(file) || !/\.jsonc?$/i.test(file))
    throw new Error('Выберите файл конфигурации MCP в формате JSON или JSONC.');
  const same = previous?.client === client && previous.file === file;
  return {client, file, binding: same && previous.binding || randomUUID()};
}

async function configFile(file) {
  try { return await readFile(file,'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function registration(link, action) {
  const original = await configFile(link.file);
  const bom = original?.startsWith('\uFEFF') ? '\uFEFF' : '';
  const source = original === null ? '{}\n' : original.slice(bom.length);
  const errors = [];
  const config = parse(source,errors,{allowTrailingComma:true});
  if (errors.length || !object(config)) throw new Error('Проверьте синтаксис файла конфигурации MCP.');
  const group = link.client === 'custom' && !Object.hasOwn(config,'mcpServers') && Object.hasOwn(config,'servers')
    ? 'servers' : 'mcpServers';
  if (Object.hasOwn(config,group) && !object(config[group])) throw new Error('Некорректный список MCP-серверов.');
  const current = config[group]?.[key];
  const { command, args } = mcpCommand();
  const launch = {command,args:[...args,'--binding',link.binding]};
  if (link.client === 'copilot') Object.assign(launch,{type:'stdio',tools:['*']});
  const owned = Array.isArray(current?.args) && current.args.at(-1) === link.binding && current.args.at(-2) === '--binding';
  const matches = owned && current.command === command && JSON.stringify(current.args) === JSON.stringify(launch.args);
  if (action === 'check') return Boolean(matches);
  if (action === 'remove' && !owned || action === 'add' && matches) return;
  if (action === 'add' && current !== undefined && !owned)
    throw new Error('В этом клиенте имя pachca_local уже занято. Проверьте существующую запись MCP.');
  const edits = modify(source,[group,key],action === 'add' ? launch : undefined,{
    formattingOptions:{insertSpaces:true,tabSize:2,eol:source.includes('\r\n')?'\r\n':'\n'},
  });
  await mkdir(dirname(link.file),{recursive:true});
  const temp = link.file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp,bom + applyEdits(source,edits),{flag:'wx',mode:0o600});
    if (await configFile(link.file) !== original) throw new Error('Настройки клиента изменились. Повторите операцию.');
    await rename(temp,link.file);
  } finally { await rm(temp,{force:true}); }
}

export async function clientEnabled(link) {
  if (link?.binding) return registration(link,'check');
  try { return await codexMcpEnabled(); }
  catch (error) {
    if (error.code === 'CODEX_NOT_INSTALLED') return false;
    throw error;
  }
}
export function configureClient(link, enabled) {
  return link?.binding ? registration(link,enabled?'add':'remove') : connectCodex(enabled);
}
