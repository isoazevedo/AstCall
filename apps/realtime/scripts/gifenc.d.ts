/** Tipos mínimos da biblioteca gifenc (sem tipos próprios), usada para o GIF da documentação. */
declare module 'gifenc' {
  type Palette = number[][];
  function GIFEncoder(): {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: Palette; delay?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  function quantize(rgba: Uint8Array, maxColors: number): Palette;
  function applyPalette(rgba: Uint8Array, palette: Palette): Uint8Array;
  const gifenc: {
    GIFEncoder: typeof GIFEncoder;
    quantize: typeof quantize;
    applyPalette: typeof applyPalette;
  };
  export default gifenc;
}
