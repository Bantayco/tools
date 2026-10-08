// Durable Object stubs: one global registry, one SessionDO per page UUID.
export const registry = (env) => env.REGISTRY.get(env.REGISTRY.idFromName("global"));
export const session = (env, id) => env.SESSION.get(env.SESSION.idFromName(id));
