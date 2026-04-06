export function vaultProvider(_config: Record<string, string>) {
  return {
    getSecret: async (_name: string): Promise<string> => {
      throw new Error(
        "HashiCorp Vault not configured. Install node-vault.",
      );
    },
    setSecret: async (_name: string, _value: string): Promise<void> => {
      throw new Error(
        "HashiCorp Vault not configured. Install node-vault.",
      );
    },
    deleteSecret: async (_name: string): Promise<void> => {
      throw new Error(
        "HashiCorp Vault not configured. Install node-vault.",
      );
    },
    testConnection: async (): Promise<{ ok: boolean; error?: string }> => {
      return { ok: false, error: "Vault client not installed" };
    },
  };
}
