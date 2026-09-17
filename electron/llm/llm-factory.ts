import { ILLMProvider } from './provider.interface'
import { AiSdkProvider } from './ai-sdk/ai-sdk-provider'

/**
 * Transport is the AI SDK (`electron/llm/ai-sdk/`). The legacy hand-written
 * fetch providers (`openai-provider.ts`, `gemini-provider.ts`) are kept only
 * as a rollback path until the AI SDK transport has qualified a release.
 */
export class LLMFactory {
  static getProvider(): ILLMProvider {
    return new AiSdkProvider()
  }
}
