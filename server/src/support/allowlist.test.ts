import { describe, expect, it } from 'vitest';
import { testConfig } from '../../test/config';
import type { Config } from '../config';
import {
  allowlistedConfig,
  allowlistedSetting,
  applyAllowlist,
  SUPPORT_CONFIG_ALLOWLIST,
  urlHost,
} from './allowlist';

const keep = (text: string) => `clean(${text})`;

/** Every leaf path of the configuration, as the allowlist names them. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Set) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, v]) =>
    leafPaths(v, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('urlHost', () => {
  it('keeps the scheme, host and port only', () => {
    expect(urlHost('postgres://qualor:pw@db.internal:5432/qualor?sslmode=require')).toBe(
      'postgres://db.internal:5432',
    );
    expect(urlHost('https://user:pass@hooks.example/services/T0/B0/SECRET?x=1#f')).toBe(
      'https://hooks.example',
    );
    expect(urlHost('http://[::1]:8080/x')).toBe('http://[::1]:8080');
    expect(urlHost('not a url')).toBe('[set]');
  });
});

describe('the configuration allowlist (4E-3b §2)', () => {
  const config: Config = testConfig({
    databaseUrl: 'postgres://qualor:DbPassword-123@db.internal:5432/qualor',
    secretKey: 'a-secret-key-that-is-long-enough-to-be-valid',
    bootstrapAdmin: { username: 'root', password: 'bootstrap-password' },
    publicUrl: 'https://qualor.example/base',
    license: { text: 'QLK1.test-a.payload.signature', file: null },
    scmInternalHosts: new Set(['gitlab.internal', 'b.internal']),
    telemetry: { enabled: true, url: 'https://telemetry.example/api/in?k=v' },
  });
  const out = allowlistedConfig(config, keep) as Record<string, unknown>;

  it('copies listed keys, reduces URLs, and marks every other key set or unset', () => {
    expect(out).toMatchObject({
      databaseUrl: 'postgres://db.internal:5432',
      secretKey: '[set]',
      port: 0,
      bootstrapAdmin: { username: 'root', password: '[set]' },
      publicUrl: 'https://qualor.example',
      license: { text: '[set]', file: null },
      scmInternalHosts: ['b.internal', 'gitlab.internal'],
      telemetry: { enabled: true, url: 'https://telemetry.example' },
    });
    const unset = allowlistedConfig(
      testConfig({ bootstrapAdmin: { username: 'admin', password: undefined } }),
      keep,
    ) as { bootstrapAdmin: unknown; license: unknown };
    expect(unset.bootstrapAdmin).toEqual({ username: 'admin', password: '[unset]' });
    expect(unset.license).toEqual({ text: '[unset]', file: null });
    const text = JSON.stringify(out);
    for (const secret of ['DbPassword-123', 'a-secret-key', 'bootstrap-password', 'signature']) {
      expect(text).not.toContain(secret);
    }
  });

  it('lists no path that holds a secret, and an unknown key is set or unset', () => {
    for (const path of ['secretKey', 'bootstrapAdmin.password', 'license.text']) {
      expect(Object.hasOwn(SUPPORT_CONFIG_ALLOWLIST, path)).toBe(false);
    }
    // Every listed path exists in the configuration (a renamed key is noticed here).
    const leaves = new Set(leafPaths(config));
    for (const path of Object.keys(SUPPORT_CONFIG_ALLOWLIST)) expect(leaves).toContain(path);
    const future = allowlistedConfig(
      { ...config, newToken: 'xyz', newOff: null } as unknown as Config,
      keep,
    ) as Record<string, unknown>;
    expect(future.newToken).toBe('[set]');
    expect(future.newOff).toBe('[unset]');
  });
});

describe('the settings allowlist (4E-3b §2)', () => {
  const envelope = { v: 1, iv: 'aXY=', ct: 'Y3Q=', tag: 'dGFn' };

  it('keeps the llm provider kind, model and base URL host, never the API key', () => {
    const out = allowlistedSetting(
      'llm',
      {
        v: 1,
        provider: {
          kind: 'openai',
          baseUrl: 'https://key:inurl@llm.example:8443/v1?api_key=abc',
          model: 'gpt-x',
          auth: 'bearer',
          jsonMode: 'json_object',
          maxTokensField: 'max_tokens',
          temperature: null,
          timeoutSeconds: 60,
          apiKeyEnc: envelope,
        },
        organizations: {
          'org-1': {
            enabled: true,
            features: { explain: true, triage: false, fix: true },
            excludedProjectIds: ['p1'],
            autoFix: { enabled: true, minSeverity: 'high', maxPerAnalysis: 10 },
            autoFixDisabledProjectIds: [],
          },
        },
        excludePaths: ['vendor/**'],
        budgets: { explainPerDay: 1 },
        pricing: null,
        storePrompts: false,
        promptRetentionDays: 7,
      },
      keep,
    );
    expect(out).toEqual({
      v: 1,
      provider: {
        kind: 'openai',
        baseUrl: 'https://llm.example:8443',
        model: 'gpt-x',
        auth: 'bearer',
        jsonMode: 'json_object',
        maxTokensField: 'max_tokens',
        temperature: null,
        timeoutSeconds: 60,
        apiKeyEnc: '[set]',
      },
      organizations: {
        'org-1': {
          enabled: true,
          features: { explain: true, triage: false, fix: true },
          excludedProjectIds: '[set]',
          autoFix: { enabled: true, minSeverity: 'high', maxPerAnalysis: 10 },
          autoFixDisabledProjectIds: '[set]',
        },
      },
      excludePaths: ['vendor/**'],
      budgets: { explainPerDay: 1 },
      pricing: null,
      storePrompts: false,
      promptRetentionDays: 7,
    });
  });

  it('reduces the audit stream URL to its host and drops its secret', () => {
    expect(
      allowlistedSetting(
        'audit',
        {
          retentionDays: 365,
          stream: { url: 'https://siem.example/in/tok3n', active: true, secretEnc: envelope },
        },
        keep,
      ),
    ).toEqual({
      retentionDays: 365,
      stream: { url: 'https://siem.example', active: true, secretEnc: '[set]' },
    });
  });

  it('cleans free text, keeps scalar rows, and marks an unknown key or path as set', () => {
    expect(allowlistedSetting('audit-stream', { lastError: 'boom', cursorSeq: '4' }, keep)).toEqual(
      { lastError: 'clean(boom)', cursorSeq: '4' },
    );
    expect(allowlistedSetting('gate.smallChangesetLines', 20, keep)).toBe(20);
    expect(allowlistedSetting('retention', { closedIssuesDays: 9 }, keep)).toEqual({
      closedIssuesDays: 9,
    });
    expect(
      allowlistedSetting('license', { key: 'QLK1.x.y.z', savedAt: 't', savedBy: 'u' }, keep),
    ).toEqual({ key: '[set]', savedAt: 't', savedBy: 'u' });
    expect(allowlistedSetting('telemetry', { installationId: 'id' }, keep)).toBe('[set]');
    expect(allowlistedSetting('something-new', { token: 'x' }, keep)).toBe('[set]');
    expect(allowlistedSetting('constructor', {}, keep)).toBe('[set]');
    expect(
      allowlistedSetting('webhooks', { allowHttp: true, extra: { token: 'x' } }, keep),
    ).toEqual({ allowHttp: true, extra: '[set]' });
  });

  it('walks object keys in byte order', () => {
    expect(
      Object.keys(applyAllowlist({ b: 1, B: 2, a: 3 }, { '*': 'value' }, keep) as object),
    ).toEqual(['B', 'a', 'b']);
  });
});
