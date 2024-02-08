import { PluginRequestPayload, createHeadersWithPluginSettings } from '@lobehub/chat-plugin-sdk';
import { produce } from 'immer';
import { merge } from 'lodash-es';

import { DEFAULT_AGENT_CONFIG } from '@/const/settings';
import { ModelProvider } from '@/libs/agent-runtime';
import { filesSelectors, useFileStore } from '@/store/file';
import { useGlobalStore } from '@/store/global';
import { modelProviderSelectors } from '@/store/global/selectors';
import { useToolStore } from '@/store/tool';
import { pluginSelectors, toolSelectors } from '@/store/tool/selectors';
import { ChatMessage } from '@/types/message';
import type { ChatStreamPayload, OpenAIChatMessage } from '@/types/openai/chat';
import { UserMessageContentPart } from '@/types/openai/chat';
import { fetchAIFactory, getMessageError } from '@/utils/fetch';

import { createHeaderWithAuth } from './_auth';
import { createHeaderWithOpenAI } from './_header';
import { PLUGINS_URLS } from './_url';

interface FetchOptions {
  signal?: AbortSignal | undefined;
}

interface GetChatCompletionPayload extends Partial<Omit<ChatStreamPayload, 'messages'>> {
  messages: ChatMessage[];
}

class ChatService {
  createAssistantMessage = async (
    { plugins: enabledPlugins, messages, ...params }: GetChatCompletionPayload,
    options?: FetchOptions,
  ) => {
    const payload = merge(
      {
        model: DEFAULT_AGENT_CONFIG.model,
        stream: true,
        ...DEFAULT_AGENT_CONFIG.params,
      },
      params,
    );
    // ============  1. preprocess messages   ============ //

    const oaiMessages = this.processMessages({
      messages,
      model: payload.model,
      tools: enabledPlugins,
    });

    // ============  2. preprocess tools   ============ //

    const filterTools = toolSelectors.enabledSchema(enabledPlugins)(useToolStore.getState());

    // check this model can use function call
    const canUseFC = modelProviderSelectors.modelEnabledFunctionCall(payload.model)(
      useGlobalStore.getState(),
    );
    // the rule that model can use tools:
    // 1. tools is not empty
    // 2. model can use function call
    const shouldUseTools = filterTools.length > 0 && canUseFC;

    const tools = shouldUseTools ? filterTools : undefined;

    return this.getChatCompletion({ ...params, messages: oaiMessages, tools }, options);
  };

  getChatCompletion = async (params: Partial<ChatStreamPayload>, options?: FetchOptions) => {
    const { provider = ModelProvider.OpenAI, ...res } = params;
    const payload = merge(
      {
        model: DEFAULT_AGENT_CONFIG.model,
        stream: true,
        ...DEFAULT_AGENT_CONFIG.params,
      },
      res,
    );

    const headers = await createHeaderWithAuth({
      headers: { 'Content-Type': 'application/json' },
      provider,
    });

    return fetch(`/api/chat/${provider}`, {
      body: JSON.stringify(payload),
      headers,
      method: 'POST',
      signal: options?.signal,
    });
  };

  /**
   * run the plugin api to get result
   * @param params
   * @param options
   */
  runPluginApi = async (params: PluginRequestPayload, options?: FetchOptions) => {
    const s = useToolStore.getState();

    const settings = pluginSelectors.getPluginSettingsById(params.identifier)(s);
    const manifest = pluginSelectors.getPluginManifestById(params.identifier)(s);

    const gatewayURL = manifest?.gateway;

    const res = await fetch(gatewayURL ?? PLUGINS_URLS.gateway, {
      body: JSON.stringify({ ...params, manifest }),
      // TODO: we can have a better auth way
      headers: createHeadersWithPluginSettings(settings, createHeaderWithOpenAI()),
      method: 'POST',
      signal: options?.signal,
    });

    if (!res.ok) {
      throw await getMessageError(res);
    }

    return await res.text();
  };

  fetchPresetTaskResult = fetchAIFactory(this.getChatCompletion);

  private processMessages = ({
    messages,
    tools,
    model,
  }: {
    messages: ChatMessage[];
    model: string;
    tools?: string[];
  }): OpenAIChatMessage[] => {
    // handle content type for vision model
    // for the models with visual ability, add image url to content
    // refs: https://platform.openai.com/docs/guides/vision/quick-start
    const getContent = (m: ChatMessage) => {
      if (!m.files) return m.content;

      const imageList = filesSelectors.getImageUrlOrBase64ByList(m.files)(useFileStore.getState());

      if (imageList.length === 0) return m.content;

      const canUploadFile = modelProviderSelectors.modelEnabledUpload(model)(
        useGlobalStore.getState(),
      );

      if (!canUploadFile) {
        return m.content;
      }

      return [
        { text: m.content, type: 'text' },
        ...imageList.map(
          (i) => ({ image_url: { detail: 'auto', url: i.url }, type: 'image_url' }) as const,
        ),
      ] as UserMessageContentPart[];
    };

    const postMessages = messages.map((m): OpenAIChatMessage => {
      switch (m.role) {
        case 'user': {
          return { content: getContent(m), role: m.role };
        }

        case 'function': {
          const name = m.plugin?.identifier as string;
          return { content: m.content, name, role: m.role };
        }

        default: {
          return { content: m.content, role: m.role };
        }
      }
    });

    return produce(postMessages, (draft) => {
      if (!tools || tools.length === 0) return;
      const hasFC = modelProviderSelectors.modelEnabledFunctionCall(model)(
        useGlobalStore.getState(),
      );
      if (!hasFC) return;

      const systemMessage = draft.find((i) => i.role === 'system');

      const toolsSystemRoles = toolSelectors.enabledSystemRoles(tools)(useToolStore.getState());
      if (!toolsSystemRoles) return;

      if (systemMessage) {
        systemMessage.content = systemMessage.content + '\n\n' + toolsSystemRoles;
      } else {
        draft.unshift({
          content: toolsSystemRoles,
          role: 'system',
        });
      }
    });
  };
}

export const chatService = new ChatService();
