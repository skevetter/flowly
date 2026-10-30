import { summarySettingsValues } from "../shared/summary";
import type { ModelCallClaim } from "./model-calls";

export const modelCallsAllowed: ModelCallClaim = async () => undefined;

export const sharingSettings = (overrides: Parameters<typeof summarySettingsValues>[0] = {}) =>
  summarySettingsValues({ summaryEnabled: true, sendTextToModels: true, digestEnabled: true, retroEnabled: true, ...(overrides as object) });
