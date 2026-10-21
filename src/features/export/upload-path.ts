import { validateUploadPath } from '../../device/bluetooth';

export const DEFAULT_TARGET_DIRECTORY = '/SD:/ROUTES/';
export const TARGET_DIRECTORY_STORAGE_KEY = 'trl-x.bluetooth-target-directory';

export function uploadPath(directory: string, filename: string): string {
  const trimmed = directory.trim();
  if (
    !trimmed.startsWith('/') ||
    /[\\\u0000-\u001f\u007f-\u009f]/u.test(directory) ||
    trimmed.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('bluetooth.invalidDirectory');
  }
  const normalized = trimmed.replace(/\/+$/u, '') + '/';
  const path = normalized + filename;
  validateUploadPath(path);
  return path;
}
