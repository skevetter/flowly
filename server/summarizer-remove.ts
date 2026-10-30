/** The child session a summarizer or insight run created, and is now done with. */
export type RemovableAgent = { id: string; archive(): Promise<unknown> };
export type RemoveAgent = (agent: RemovableAgent) => Promise<void>;

/** The plugin SDK can only archive a session; hard-deleting one needs a Paseo call it does not expose. */
export const archiveRemovedAgent: RemoveAgent = async (agent) => {
  await agent.archive().catch(() => undefined);
};
