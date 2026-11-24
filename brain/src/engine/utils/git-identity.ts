import { gitIdentityConfigCommands, type GitIdentity } from '@okidoki/shared';
import { gitService } from '../git/service';
import { execFileAsync } from './exec';

export async function updateGitIdentity(
  identity: GitIdentity,
  tag: string,
  hosts?: string[],
): Promise<void> {
  if (!hosts) {
    try {
      const [nameArgs, emailArgs] = gitIdentityConfigCommands(identity);
      await execFileAsync('git', nameArgs);
      await execFileAsync('git', emailArgs);
      console.log(`[${tag}] Updated global git identity to ${identity.name} <${identity.email}>`);
    } catch (error) {
      console.error(`[${tag}] Failed to update global git identity:`, error);
    }
    return;
  }

  const normalizedHosts = hosts.map((host) => host.toLowerCase());
  const repositories = await gitService.listRepositories();
  await Promise.all(repositories.map(async (repository) => {
    try {
      const host = await gitService.getRepositoryOriginHost(repository.path, true);
      if (!host || !normalizedHosts.includes(host)) return;

      const [nameArgs, emailArgs] = gitIdentityConfigCommands(identity, 'local');
      await execFileAsync('git', nameArgs, { cwd: repository.path });
      await execFileAsync('git', emailArgs, { cwd: repository.path });
      console.log(`[${tag}] Updated git identity for ${repository.path} to ${identity.name} <${identity.email}>`);
    } catch (error) {
      console.error(`[${tag}] Failed to update git identity for ${repository.path}:`, error);
    }
  }));
}
