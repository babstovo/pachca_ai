import { managerNickname } from './workspace-settings.mjs';
export const projectManager = managerNickname;

export function isProjectManager(user) {
  return Boolean(projectManager) && typeof user?.nickname === 'string' && user.nickname.replace(/^@/, '').toLowerCase() === projectManager;
}
