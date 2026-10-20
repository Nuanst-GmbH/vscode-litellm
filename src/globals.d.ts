/**
 * Injected at build time by esbuild (see the `define` in esbuild.mjs). Holds
 * the package.json version of the bundle that is *currently executing* in this
 * extension host — which may be older than the newest installed vsix if the
 * window hasn't been reloaded since the last install.
 */
declare const __LITELLM_EXT_VERSION__: string;
