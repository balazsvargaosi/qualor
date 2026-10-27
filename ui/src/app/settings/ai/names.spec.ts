import { namesOf } from './names';

const orgs = (count: number) => Array.from({ length: count }, (_, i) => `Org ${i + 1}`);

describe('namesOf', () => {
  it('lists up to three names as the locale joins a list', () => {
    expect(namesOf(orgs(1), 'en-US')).toBe('Org 1');
    expect(namesOf(orgs(2), 'en-US')).toBe('Org 1 and Org 2');
    expect(namesOf(orgs(3), 'en-US')).toBe('Org 1, Org 2, and Org 3');
    expect(namesOf(orgs(3), 'en-GB')).toBe('Org 1, Org 2 and Org 3');
  });

  it('names three and counts the others, joined as the same locale joins a list', () => {
    expect(namesOf(orgs(5), 'en-US')).toBe('Org 1, Org 2, Org 3, and 2 more');
    expect(namesOf(orgs(5), 'en-GB')).toBe('Org 1, Org 2, Org 3 and 2 more');
    expect(namesOf(orgs(1_004), 'en-US')).toBe('Org 1, Org 2, Org 3, and 1,001 more');
  });
});
