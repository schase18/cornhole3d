export {};

declare global {
  /**
   * Emscripten `ammo.js` loaded via `<script>` from `public/ammo.js`.
   * It is a factory function: `await Ammo()` returns the resolved API object.
   */
  function Ammo(): Promise<Record<string, unknown>>;
}
