import { keepEdits } from './drafts';

describe('keepEdits', () => {
  it('takes the new value of each field not edited since, and keeps an edit', () => {
    const sent = { a: '1', b: '2', list: ['x'] };
    const now = { ...sent, b: '3' };
    const answer = { a: '1.00', b: '2.00', list: ['x', 'y'] };
    expect(keepEdits(now, sent, answer)).toEqual({ a: '1.00', b: '3', list: ['x', 'y'] });
    // An edited list is a new list, even with the same items: it is kept.
    expect(keepEdits({ ...sent, list: ['x'] }, sent, answer).list).toEqual(['x']);
    // Nothing given is changed.
    expect(now).toEqual({ a: '1', b: '3', list: ['x'] });
  });
});
