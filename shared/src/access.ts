import { isRecord } from './type-guards';

export const ACCESS_RESOURCE_TYPES = ['environments', 'automations', 'analytics'] as const;
export type AccessResourceType = (typeof ACCESS_RESOURCE_TYPES)[number];

export type AccessLevel = 'none' | 'read' | 'write';
export type AccessScope = `${AccessResourceType}:${Exclude<AccessLevel, 'none'>}`;

export const ACCESS_RESOURCE_TYPE_INFO: Record<AccessResourceType, { label: string; levels: readonly AccessLevel[]; per_resource: boolean }> = {
  environments: { label: 'Environments', levels: ['none', 'read', 'write'], per_resource: true },
  automations: { label: 'Automations', levels: ['none', 'read', 'write'], per_resource: true },
  analytics: { label: 'Analytics', levels: ['none', 'read'], per_resource: false },
};

export const ACCESS_LEVEL_RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2 };

export interface ResourceAccess {
  can_read: boolean;
  can_write: boolean;
}

/** A role grant. `resource_id: null` covers every resource of that type in the organization. */
export interface AccessGrant {
  resource_type: AccessResourceType;
  resource_id: string | null;
  scope: AccessScope;
}

export const canWriteAutomations = (scopes: readonly AccessScope[] | undefined) => (scopes ?? []).includes('automations:write');

export function parseAccessScope(scope: string): { resource_type: AccessResourceType; level: 'read' | 'write' } | null {
  const [type, level] = scope.split(':');
  const resource_type = ACCESS_RESOURCE_TYPES.find((known) => known === type);
  if (!resource_type) return null;
  if (level !== 'read' && level !== 'write') return null;
  return { resource_type, level };
}

export function isAccessGrant(value: unknown): value is AccessGrant {
  if (!isRecord(value)) return false;
  const parsed = typeof value.scope === 'string' ? parseAccessScope(value.scope) : null;
  return !!parsed
    && parsed.resource_type === value.resource_type
    && (value.resource_id === null || typeof value.resource_id === 'string')
    && (value.resource_id === null || ACCESS_RESOURCE_TYPE_INFO[parsed.resource_type].per_resource)
    && ACCESS_RESOURCE_TYPE_INFO[parsed.resource_type].levels.includes(parsed.level);
}

export function grantAccessLevel(access: ResourceAccess, level: 'read' | 'write'): ResourceAccess {
  return { can_read: true, can_write: access.can_write || level === 'write' };
}

export interface ResourceTypeAccess {
  all: AccessLevel;
  overrides: Record<string, AccessLevel>;
}

export function grantsToResourceTypeAccess(grants: AccessGrant[], resourceType: AccessResourceType): ResourceTypeAccess {
  const result: ResourceTypeAccess = { all: 'none', overrides: {} };
  for (const grant of grants) {
    if (grant.resource_type !== resourceType) continue;
    const level = parseAccessScope(grant.scope)?.level ?? 'none';
    if (grant.resource_id === null) {
      if (ACCESS_LEVEL_RANK[level] > ACCESS_LEVEL_RANK[result.all]) result.all = level;
    } else if (ACCESS_LEVEL_RANK[level] > ACCESS_LEVEL_RANK[result.overrides[grant.resource_id] ?? 'none']) {
      result.overrides[grant.resource_id] = level;
    }
  }
  for (const [id, level] of Object.entries(result.overrides)) {
    if (ACCESS_LEVEL_RANK[level] <= ACCESS_LEVEL_RANK[result.all]) delete result.overrides[id];
  }
  return result;
}

export function resourceTypeAccessToGrants(resourceType: AccessResourceType, access: ResourceTypeAccess): AccessGrant[] {
  const grants: AccessGrant[] = [];
  if (access.all !== 'none') grants.push({ resource_type: resourceType, resource_id: null, scope: `${resourceType}:${access.all}` });
  for (const [resource_id, level] of Object.entries(access.overrides)) {
    if (level !== 'none' && ACCESS_LEVEL_RANK[level] > ACCESS_LEVEL_RANK[access.all]) {
      grants.push({ resource_type: resourceType, resource_id, scope: `${resourceType}:${level}` });
    }
  }
  return grants;
}

export interface GetOrganizationAccessPolicyResponse {
  everyone: AccessGrant[];
  roles: Array<{ role_id: string; grants: AccessGrant[] }>;
}

export interface UpdateOrganizationAccessPolicyRequest {
  grants: AccessGrant[];
}

export interface UpdateOrganizationAccessPolicyResponse {
  grants: AccessGrant[];
}
