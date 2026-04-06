export function gcpSecretManagerProvider(_config: Record<string, string>) {
  return {
    getSecret: async (_name: string): Promise<string> => {
      throw new Error(
        "GCP Secret Manager not configured. Install @google-cloud/secret-manager.",
      );
    },
    setSecret: async (_name: string, _value: string): Promise<void> => {
      throw new Error(
        "GCP Secret Manager not configured. Install @google-cloud/secret-manager.",
      );
    },
    deleteSecret: async (_name: string): Promise<void> => {
      throw new Error(
        "GCP Secret Manager not configured. Install @google-cloud/secret-manager.",
      );
    },
    testConnection: async (): Promise<{ ok: boolean; error?: string }> => {
      return { ok: false, error: "GCP SDK not installed" };
    },
  };
}
