import { getProviderDisplayName, type AgentProvider } from './agent';
import type { CredentialAccount } from './analytics/types';
import { CREDENTIAL_SCOPE, getCredentialMethodLabel, type AuthMethod, type CredentialScope } from './credentials';
import type { AuthFallbackPayload, ModelRefusalFallback } from './event';
import { MODEL_LABELS } from './engine/types';

export function describeCredential(
  provider: AgentProvider,
  credential: { method: AuthMethod; scope?: CredentialScope; account?: CredentialAccount },
): string {
  const { ownerName, email, ordinal } = credential.account ?? {};
  const label = `${getCredentialMethodLabel(provider, credential.method)}${ordinal ? ` #${ordinal}` : ''}`;
  const owner = credential.scope === CREDENTIAL_SCOPE.USER
    ? (ownerName ? `${ownerName}'s personal ${label}` : `your ${label}`)
    : credential.scope === CREDENTIAL_SCOPE.ORG ? `the organization's ${label}` : `the ${label}`;
  return email ? `${owner} (${email})` : owner;
}

export function describeAuthFallback(payload: AuthFallbackPayload): {
  headline: string;
  outcomeClause: string;
} {
  const agent = getProviderDisplayName(payload.provider);
  const exhausted = describeCredential(payload.provider, {
    method: payload.exhaustedMethod,
    scope: payload.exhaustedScope,
    account: payload.exhaustedAccount,
  });
  const switched = payload.status === 'switched';
  if (payload.fromModel && payload.toModel) {
    return {
      headline: `${MODEL_LABELS[payload.fromModel] ?? payload.fromModel} isn't available on ${exhausted}`,
      outcomeClause: `switched to ${MODEL_LABELS[payload.toModel] ?? payload.toModel}`,
    };
  }

  return {
    headline: payload.reason === 'out_of_credits'
      ? `${agent} is out of credits on ${exhausted}`
      : payload.reason === 'auth_failed'
        ? `${agent} could not authenticate with ${exhausted}`
        : payload.reason === 'credits_required'
          ? `The selected model needs usage credits on ${exhausted}`
          : payload.reason === 'model_unavailable'
            ? `The selected model is not available on ${exhausted}`
            : `${agent} hit its usage limit on ${exhausted}`,
    outcomeClause: switched
      ? `switched to ${describeCredential(payload.provider, {
        method: payload.candidateMethod,
        scope: payload.candidateScope,
        account: payload.candidateAccount,
      })}`
      : 'could not use the configured fallback credential',
  };
}

export function describeModelRefusalFallback({ fromModel, toModel, sessionSwitched }: ModelRefusalFallback): {
  headline: string;
  outcomeClause: string;
} {
  const fallback = MODEL_LABELS[toModel] ?? toModel;
  return {
    headline: `${MODEL_LABELS[fromModel] ?? fromModel}'s safeguards flagged this chat`,
    outcomeClause: sessionSwitched ? `switched to ${fallback}` : `${fallback} answered that part`,
  };
}
