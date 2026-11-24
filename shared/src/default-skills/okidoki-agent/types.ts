export interface OkidokiAgentReferenceFile {
  name: string;
  content: string;
}

export interface OkidokiAgentAbilityDescriptor {
  label: string;
  description: string;
  /**
   * Empty string means "no bullet emitted in the integrations hint" — used
   * for abilities already covered by another prompt block (e.g. `okidoki`
   * lives in `help_instructions`).
   */
  bullet: string;
  section: string;
  referenceFile: OkidokiAgentReferenceFile;
  /**
   * When true, the UI hides the toggle and the server forces the ability on
   * regardless of input. Used for abilities that teach the agent about
   * Okidoki itself — disabling them would leave the agent unable to
   * navigate the platform it's running on.
   */
  locked?: boolean;
}

export interface OkidokiAgentSkillFile {
  /** Path relative to the skill install dir (e.g. `SKILL.md`, `references/SLACK.md`). */
  path: string;
  content: string;
}
