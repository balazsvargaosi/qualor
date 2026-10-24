import { type APIRequestContext, expect } from '@playwright/test';

/** The models of the instance's AI provider besides the standard one: the strong and the fast tier. */
export interface TierModels {
  strongModel: string | null;
  fastModel: string | null;
}

/**
 * The instance admin's save of the AI assistant settings with the models of the strong and the
 * fast tier set (or none), everything else as it is stored: the API, as the AI assistant page's own
 * save sends it. The key is left out, so the stored one stays. `admin` is a request context signed
 * in as the instance admin. The tests that set tier models put the seed's one model back with it,
 * in a `finally` or an `afterEach`, so that a failure midway never leaves them in the shared e2e
 * database.
 */
export async function setTierModels(admin: APIRequestContext, models: TierModels): Promise<void> {
  const me = (await (await admin.get('/api/v0/auth/me')).json()) as { csrfToken: string };
  const stored = (await (await admin.get('/api/v0/system/llm')).json()) as {
    provider: {
      kind: string;
      baseUrl: string;
      model: string;
      auth: string;
      jsonMode: string;
      maxTokensField: string;
      temperature: number | null;
      timeoutSeconds: number;
    };
  };
  const { provider } = stored;
  const saved = await admin.put('/api/v0/system/llm', {
    headers: { 'x-qualor-csrf': me.csrfToken },
    data: {
      ...stored,
      provider: {
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        model: provider.model,
        ...models,
        auth: provider.auth,
        jsonMode: provider.jsonMode,
        maxTokensField: provider.maxTokensField,
        temperature: provider.temperature,
        timeoutSeconds: provider.timeoutSeconds,
      },
    },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}
