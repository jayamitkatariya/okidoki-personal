const HOME_PREFIX = '~/';

export const ENVIRONMENT_FILE_PATH_GUIDANCE = 'Use ~/... for home-directory files, or ~/workspaces/... for files that should live alongside your cloned repositories.';

export function validateEnvironmentFilePath(path: string): string | null {
  const trimmedPath = path.trim();

  if (!trimmedPath) {
    return 'Path is required.';
  }

  if (!trimmedPath.startsWith(HOME_PREFIX)) {
    return `Path must start with the home-directory prefix ~/ . ${ENVIRONMENT_FILE_PATH_GUIDANCE}`.replace('~/ .', '~/');
  }

  if (trimmedPath === HOME_PREFIX) {
    return 'Path must include a file name after ~/.';
  }

  return null;
}
