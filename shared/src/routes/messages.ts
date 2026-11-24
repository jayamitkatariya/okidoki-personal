export const USER_MESSAGE_FROM_MAX_LENGTH = 120;
export const USER_MESSAGE_SUBJECT_MAX_LENGTH = 200;
export const USER_MESSAGE_BODY_MAX_LENGTH = 5000;

export interface CreateUserMessageRequest {
  from?: string;
  subject?: string;
  message: string;
}

export interface CreateUserMessageResponse {
  success: boolean;
  id: string;
}
