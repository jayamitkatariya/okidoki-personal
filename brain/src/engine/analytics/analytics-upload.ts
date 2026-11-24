import { monolithRequest } from '../services/monolith-service';

export async function uploadAnalytics(endpoint: string, body: unknown): Promise<void> {
  const response = await monolithRequest(endpoint, { body });
  if (!response.ok) {
    throw new Error(`Analytics upload failed: ${response.status} ${await response.text()}`);
  }
}
