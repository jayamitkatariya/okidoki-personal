export function defineStateMachine<const S extends string>(states: readonly S[], transitions: Record<NoInfer<S>, readonly NoInfer<S>[]>) {
  return {
    sourcesOf: (to: S): S[] => states.filter((state) => transitions[state].includes(to)),
  };
}
