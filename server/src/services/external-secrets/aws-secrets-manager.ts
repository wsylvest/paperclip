export function awsSecretsManagerProvider(_config: Record<string, string>) {
  return {
    getSecret: async (_name: string): Promise<string> => {
      throw new Error(
        "AWS Secrets Manager not configured. Install @aws-sdk/client-secrets-manager.",
      );
    },
    setSecret: async (_name: string, _value: string): Promise<void> => {
      throw new Error(
        "AWS Secrets Manager not configured. Install @aws-sdk/client-secrets-manager.",
      );
    },
    deleteSecret: async (_name: string): Promise<void> => {
      throw new Error(
        "AWS Secrets Manager not configured. Install @aws-sdk/client-secrets-manager.",
      );
    },
    testConnection: async (): Promise<{ ok: boolean; error?: string }> => {
      return { ok: false, error: "AWS SDK not installed" };
    },
  };
}
