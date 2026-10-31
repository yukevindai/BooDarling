export { BaronessCritique, splitCritique, type BaronessCritiqueProps } from "./BaronessCritique";
export { BaronessGuidance, type BaronessGuidanceProps } from "./BaronessGuidance";
export { AudioSetupControl, type AudioSetupControlProps, type AudioSetupState } from "./AudioSetupControl";
export {
  useBaroness,
  type BaronessRunInput,
  type BaronessRunOutcome,
  type BaronessState,
  type BaronessStatus,
  type UseBaroness,
} from "./useBaroness";
export {
  BaronessVoice,
  createBaronessVoice,
  getBaronessVoice,
  type SpeakKind,
  type SpeakOptions,
  type SpeakOutcome,
  type SpeakVia,
  type VoiceState,
} from "./audio";
export {
  CritiqueDiscardedError,
  fallbackCritique,
  isCritiqueDiscarded,
  requestCritique,
  type RequestCritiqueOptions,
} from "./critique-client";
export {
  configureBaronessTimeouts,
  critiqueClientTimeoutMs,
  speechClientTimeoutMs,
  type BaronessTimeoutConfig,
} from "./timeouts";
export { decideRun, type RunDecision } from "./session-gate";
export { AuraMax, AuraMaxStage, ScareAuraMax, type AuraMaxStageData, type AuraMaxStageProps } from "./AuraMax";
