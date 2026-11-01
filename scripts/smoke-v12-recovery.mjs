// Current product recovery follows persistent work identities and the native archive.
// The pinned family/privacy contracts remain in dsh-family-check and dsh-collaboration-check.
process.env.LCA_CONTINUITY_RECOVERY = '1'
await import('./smoke-collaboration.mjs')
