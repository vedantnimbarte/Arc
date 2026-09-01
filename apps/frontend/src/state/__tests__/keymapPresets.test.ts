import { describe, expect, it } from 'vitest';
import {
  ACTION_ORDER,
  DEFAULT_BINDINGS,
  KEYMAP_PRESETS,
  KEYMAP_PRESET_BY_ID,
  activePreset,
  bindingsEqual,
  formatBinding,
  type ActionId,
  type KeyBinding,
  type KeymapPresetId,
} from '../shortcuts';

/** The binding a preset actually produces for an action, defaults included. */
function resolved(presetId: KeymapPresetId, id: ActionId): KeyBinding | null {
  const overrides = KEYMAP_PRESET_BY_ID[presetId].overrides;
  const ov = overrides[id];
  return ov === undefined ? DEFAULT_BINDINGS[id] : ov;
}

describe('keymap presets', () => {
  it('only names actions that exist', () => {
    // A typo'd ActionId in a preset would silently bind nothing.
    const known = new Set<string>(ACTION_ORDER);
    for (const preset of KEYMAP_PRESETS) {
      for (const id of Object.keys(preset.overrides)) {
        expect(known.has(id), `${preset.id} names unknown action ${id}`).toBe(true);
      }
    }
  });

  it('binds no combo to two actions, in any preset', () => {
    // A conflict here is worse than a hand-made one: applying the preset
    // silently shadows one of the two actions with no warning anywhere.
    for (const preset of KEYMAP_PRESETS) {
      const seen = new Map<string, ActionId>();
      for (const id of ACTION_ORDER) {
        const binding = resolved(preset.id, id);
        if (!binding) continue;
        const key = formatBinding(binding);
        const prior = seen.get(key);
        expect(prior, `${preset.id}: ${key} is bound to both ${prior} and ${id}`).toBeUndefined();
        seen.set(key, id);
      }
    }
  });

  it('gives ARC the empty override set, so it is exactly the defaults', () => {
    expect(KEYMAP_PRESET_BY_ID.arc.overrides).toEqual({});
  });

  it('actually changes something in every non-default preset', () => {
    for (const preset of KEYMAP_PRESETS.filter((p) => p.id !== 'arc')) {
      const differs = ACTION_ORDER.some((id) => {
        const mine = resolved(preset.id, id);
        const base = DEFAULT_BINDINGS[id];
        if (!mine || !base) return mine !== base;
        return !bindingsEqual(mine, base);
      });
      expect(differs, `${preset.id} is identical to the defaults`).toBe(true);
    }
  });
});

describe('activePreset', () => {
  it('reports ARC for untouched overrides', () => {
    expect(activePreset({})).toBe('arc');
  });

  it('recognises a preset that has been applied wholesale', () => {
    for (const preset of KEYMAP_PRESETS) {
      expect(activePreset({ ...preset.overrides })).toBe(preset.id);
    }
  });

  it('reports custom once a key is rebound away from every preset', () => {
    const overrides = {
      'new-terminal': { code: 'F9', ctrl: true, meta: false, shift: false, alt: false },
    };
    expect(activePreset(overrides)).toBeNull();
  });

  it('matches on the resolved binding, not on the override map', () => {
    // Setting a key by hand to the value it already has must still read as
    // ARC rather than flipping the label to "custom".
    const sameAsDefault = { 'toggle-sidebar': DEFAULT_BINDINGS['toggle-sidebar'] };
    expect(activePreset(sameAsDefault)).toBe('arc');
  });

  it('treats a disabled action as different from a bound one', () => {
    expect(activePreset({ 'new-terminal': null })).toBeNull();
  });
});
