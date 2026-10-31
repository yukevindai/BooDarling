import { criticProviderId } from "../config";
import type { CriticProvider } from "../types";
import { GeminiCriticProvider } from "./gemini";
import { MockCriticProvider } from "./mock";
import { OllamaCriticProvider } from "./ollama";

export { CriticProviderError, isTransientError } from "./errors";
export { GeminiCriticProvider, MockCriticProvider, OllamaCriticProvider };

/** The critic provider selected by `CRITIC_PROVIDER` (read on every call). */
export function getCriticProvider(): CriticProvider {
  switch (criticProviderId()) {
    case "ollama":
      return new OllamaCriticProvider();
    case "mock":
      return new MockCriticProvider();
    case "gemini":
    default:
      return new GeminiCriticProvider();
  }
}
