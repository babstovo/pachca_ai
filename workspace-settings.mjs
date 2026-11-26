import { readFileSync, mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

function settingsFile() {
  return process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'PachcaWebClient', 'workspace.local.json');
}

function readSettings() {
  const file = settingsFile();
  if (!file) return {};
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

const settings = readSettings();
export const managerNickname = String(settings.managerNickname || '').trim().replace(/^@/, '').toLowerCase();
export const projectBaseBranches = settings.projectBaseBranches ?? {};

export function parseBoardAddress(value) {
  const error = 'Откройте доску OpenProject и скопируйте её HTTPS-ссылку вида /projects/проект/boards/номер.';
  if (typeof value !== 'string' || !URL.canParse(value)) throw Error(error);
  const url = new URL(value);
  const id = /^\/projects\/[^/]+\/boards\/([1-9]\d*)\/?$/u.exec(url.pathname)?.[1];
  if (url.protocol !== 'https:' || url.username || url.password || !id || !Number.isSafeInteger(Number(id))) throw Error(error);
  url.search = url.hash = '';
  url.pathname = url.pathname.replace(/\/$/u, '');
  return url;
}

export function configuredBoard() {
  const value = readSettings().openProjectBoard;
  if (value) {
    try { return parseBoardAddress(value); } catch { /* Allow correcting an invalid saved address in settings. */ }
  }
}

export function preferredBoardProfile() {
  return readSettings().openProjectProfile;
}

export function saveBoardAddress(board, profile) {
  const file = settingsFile();
  const current = readSettings();
  if (current.openProjectBoard === board.href && current.openProjectProfile === profile) return;
  mkdirSync(dirname(file), {recursive:true});
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify({...current, openProjectBoard:board.href, openProjectProfile:profile}, null, 2), {mode:0o600});
    renameSync(temp, file);
  } finally { rmSync(temp, {force:true}); }
}
