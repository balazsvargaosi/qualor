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

  it('counts organisations it cannot name, with those it names or alone', () => {
    expect(namesOf(['Acme'], 'en-US', 2)).toBe('Acme and 2 more');
    expect(namesOf(orgs(3), 'en-US', 1)).toBe('Org 1, Org 2, Org 3, and 1 more');
    expect(namesOf(orgs(5), 'en-US', 1)).toBe('Org 1, Org 2, Org 3, and 3 more');
    expect(namesOf([], 'en-US', 3)).toBe('3 organizations');
    expect(namesOf([], 'en-US', 1)).toBe('1 organization');
    expect(namesOf([], 'en-US', 1_200)).toBe('1,200 organizations');
  });
});
