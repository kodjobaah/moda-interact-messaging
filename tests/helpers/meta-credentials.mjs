export const META_CREDENTIALS = Object.freeze({
  appSecret: "local-arch043-meta-secret",
  verifyToken: "local-arch043-verification-token",
});

export function createMetaCredentialsReader({
  credentials = META_CREDENTIALS,
  version = 1,
  failure,
} = {}) {
  let reads = 0;
  return {
    get reads() { return reads; },
    reader: {
      async read() {
        reads += 1;
        if (failure) throw failure;
        return Object.freeze({
          key: "messaging.meta",
          version,
          value: Object.freeze({ ...credentials }),
        });
      },
    },
  };
}
