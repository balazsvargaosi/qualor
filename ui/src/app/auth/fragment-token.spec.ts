import { takeFragmentToken } from './fragment-token';

describe('takeFragmentToken (mail E2 A2)', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  const at = (url: string) => {
    window.history.replaceState({ navigationId: 7 }, '', url);
    return takeFragmentToken(document);
  };

  it('reads #token= and removes the fragment, keeping the path, the query and the history state', () => {
    expect(at('/reset-password?from=mail#token=Abc123')).toBe('Abc123');
    expect(window.location.hash).toBe('');
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      '/reset-password?from=mail',
    );
    expect(window.history.state).toEqual({ navigationId: 7 });
  });

  it('finds the token among other fragment parameters', () => {
    expect(at('/accept-invite#utm=x&token=Abc123&y=1')).toBe('Abc123');
  });

  it('answers null for a missing or empty token, and clears the fragment all the same', () => {
    expect(at('/reset-password')).toBeNull();
    expect(at('/reset-password#token=')).toBeNull();
    expect(at('/reset-password#other=1')).toBeNull();
    expect(window.location.hash).toBe('');
  });

  it('reads another parameter by name (mail E3: the stop link is #t=<token>)', () => {
    window.history.replaceState({ navigationId: 3 }, '', '/unsubscribe#t=abc.def');
    expect(takeFragmentToken(document, 't')).toBe('abc.def');
    expect(window.location.hash).toBe('');
    expect(window.history.state).toEqual({ navigationId: 3 });
  });
});
