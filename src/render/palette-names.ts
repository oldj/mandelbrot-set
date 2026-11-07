/**
 * The palettes a render can use: their names and how the palette menu shows
 * them. The colours themselves are built in the workers (./palette.ts); the
 * main thread only needs this list. A new palette is added here, with its
 * shader in paletteShader.
 */
export const PALETTES = ['classic', 'vivid'] as const;
export type Palette = typeof PALETTES[number];
export const isPalette = (name: unknown): name is Palette => PALETTES.includes(name as Palette);

export interface PaletteInfo {
  name: string;
  /** One line on where the colours come from. */
  note: string;
  /** Colours along the start of its gradient, for the menu's swatch (tests keep them in step with palette.ts). */
  swatch: readonly string[];
}

export const PALETTE_INFO: Record<Palette, PaletteInfo> = {
  classic: {
    name: 'Classic',
    note: 'The Wikipedia zoom animation',
    swatch: ['#0e0b52', '#0e3ca5', '#4e9adc', '#b0e5ff', '#f9fdef', '#f9e560', '#f9b50f', '#d96c03', '#86200d', '#390423'],
  },
  vivid: {
    name: 'Vivid',
    note: 'After Maths Town’s “Eye of the Universe”',
    swatch: ['#2f4aba', '#5272d8', '#f2f3f7', '#09262e', '#57cff1', '#c9ebf7', '#eef5f7', '#3d1207', '#e95e3c', '#eba08d',
      '#f7f2f1', '#350c3d', '#bc63d0', '#d995e9', '#f6f1f7', '#200f56', '#5e4bc3', '#7f76dc'],
  },
};
