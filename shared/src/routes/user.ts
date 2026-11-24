import type { Organization } from '../types';
import { IMAGE_MEDIA_TYPES } from '../engine/types';

export const USER_PROFILE_ENDPOINT = '/v1/user/profile';
export const ACCOUNT_DELETION_ENDPOINT = '/v1/user/account-deletion';
export const TERMS_ACCEPTANCE_ENDPOINT = '/v1/user/terms-acceptance';
export const PROFILE_AVATAR_MEDIA_TYPES = IMAGE_MEDIA_TYPES;
export const PROFILE_AVATAR_MAX_SIZE_BYTES = 5 * 1024 * 1024;
export const PROFILE_AVATAR_VALIDATION_ERROR = 'Choose a JPG, PNG, WebP, or GIF under 5 MB';

type ProfileAvatarMediaType = (typeof PROFILE_AVATAR_MEDIA_TYPES)[number];

const PROFILE_AVATAR_EXTENSIONS: Record<ProfileAvatarMediaType, string> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function isProfileAvatarMediaType(value: string): value is ProfileAvatarMediaType {
  return PROFILE_AVATAR_MEDIA_TYPES.some((mediaType) => mediaType === value);
}

export function getProfileAvatarExtension(contentType: string): string | null {
  return isProfileAvatarMediaType(contentType) ? PROFILE_AVATAR_EXTENSIONS[contentType] : null;
}

export interface GetUserOrganizationsResponse {
  organizations: Organization[];
}

export interface UserProfile {
  userId: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
}

// A display name equal to the email means it was never set: the server stores the email as the fallback.
export function hasUnsetDisplayName(profile: { displayName: string | null; email: string | null }): boolean {
  return profile.displayName === profile.email;
}

export interface GetUserProfileResponse {
  profile: UserProfile;
}

export interface UpdateUserProfileRequest {
  displayName: string;
  avatarUrl: string | null;
}

export interface UpdateUserProfileResponse {
  profile: UserProfile;
}

export interface RequestAccountDeletionResponse {
  requestedAt: string;
  deleteBy: string;
}

export interface GetAccountDeletionResponse {
  request: RequestAccountDeletionResponse | null;
}

export interface GetTermsAcceptanceResponse {
  acceptedAt: string | null;
}

export interface AcceptTermsResponse {
  acceptedAt: string;
}

export interface UserProfileMutationInput<TAvatar> {
  displayName?: string;
  avatar?: TAvatar;
  removeAvatar?: boolean;
}
