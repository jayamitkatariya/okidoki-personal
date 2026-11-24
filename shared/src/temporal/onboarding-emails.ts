export const ONBOARDING_EMAIL_TASK_QUEUE = 'onboarding-email';
export const PROCESS_ONBOARDING_EMAILS_WORKFLOW = 'processOnboardingEmailsWorkflow';

export interface ProcessOnboardingEmailsResult {
  enrollmentsProcessed: number;
  totalSent: number;
  totalSkipped: number;
  totalErrors: number;
}
