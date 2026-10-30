import { describe, it, expect } from 'vitest';
import {
  isInternalGroup,
  isInternalCategory,
  indexCategoryGroups,
} from '../../../src/utils/categories.js';

const NAME = 'Internal Master Category';

describe('isInternalGroup', () => {
  it.each([
    [true, NAME, true],
    [true, 'Bills', true],
    [false, NAME, false],
    [false, 'Bills', false],
    [undefined, NAME, true],
    [undefined, 'Bills', false],
  ])('flag %s, name %s -> %s', (internal, name, expected) => {
    expect(isInternalGroup({ internal, name })).toBe(expected);
  });

  it('treats null flag like undefined', () => {
    expect(isInternalGroup({ internal: null, name: NAME })).toBe(true);
  });
});

describe('isInternalCategory', () => {
  it('prefers the category flag', () => {
    expect(isInternalCategory({ internal: true }, { name: 'Bills', internal: false })).toBe(true);
    expect(isInternalCategory({ internal: false }, { name: NAME })).toBe(false);
  });

  it('falls back to the group when the flag is undefined', () => {
    expect(isInternalCategory({}, { name: NAME })).toBe(true);
    expect(isInternalCategory({}, { name: 'Bills' })).toBe(false);
    expect(isInternalCategory({}, { name: 'Bills', internal: true })).toBe(true);
  });

  it('is false with no flag and no group', () => {
    expect(isInternalCategory({})).toBe(false);
  });
});

describe('indexCategoryGroups', () => {
  it('maps category ids to group names and collects internal ids', () => {
    const { names, internalIds } = indexCategoryGroups([
      { name: NAME, categories: [{ id: 'a' }] },
      { name: 'Bills', categories: [{ id: 'b' }, { id: 'c', internal: true }] },
    ]);
    expect(names.get('a')).toBe(NAME);
    expect(names.get('b')).toBe('Bills');
    expect([...internalIds].sort()).toEqual(['a', 'c']);
  });
});
