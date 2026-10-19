/** Tipos mínimos da biblioteca gifenc (sem tipos próprios), usada para o GIF da documentação. */
declare module 'gifenc' {
  type Palette = number[][];
  interface Encoder {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: Palette; delay?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  const gifenc: {
    GIFEncoder(): Encoder;
    quantize(rgba: Uint8Array, maxColors: number): Palette;
    applyPalette(rgba: Uint8Array, palette: Palette): Uint8Array;
  };
  export default gifenc;
}
