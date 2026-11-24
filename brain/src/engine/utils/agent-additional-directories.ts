import { gitService } from '../git/service';

export async function getAgentAdditionalDirectories(): Promise<string[]> {
  try {
    const repos = await gitService.listRepositories();
    return repos.map((repo) => repo.path);
  } catch {
    return [];
  }
}
