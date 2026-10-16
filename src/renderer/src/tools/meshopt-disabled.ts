/** Rodin's validated raw GLB needs no meshopt decoder. Avoid eager WASM compilation under script-src 'self'.
 * Compressed meshopt assets remain unsupported instead of relaxing CSP or loading remote decoder code. */
export const MeshoptDecoder = { supported: false, ready: Promise.resolve() }
