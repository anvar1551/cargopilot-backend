export type IntegrationDomain =
  | "carrier"
  | "sms"
  | "payment"
  | "webhook_sink";

export type ProviderStatus = "active" | "paused" | "disabled";

export type ProviderEnvironment = "sandbox" | "production";

export type IntegrationProviderRef = {
  providerId: string;
  companyId: string;
  domain: IntegrationDomain;
  providerCode: string;
  status: ProviderStatus;
  environment: ProviderEnvironment;
  capabilities: string[];
  rateLimitRps: number | null;
  timeoutMs: number;
  retryPolicyId: string | null;
  secretRef: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IntegrationSecretRef = {
  secretId: string;
  providerId: string;
  keyVersion: number;
  rotatedAt: string | null;
};

export type IntegrationActor = {
  userId: string;
  companyId: string;
  roleCodes: string[];
  permissionCodes: string[];
};

export type IntegrationRequestContext = {
  requestId: string;
  companyId: string;
  traceId?: string;
  idempotencyKey?: string;
  initiatedBy?: "api" | "worker" | "webhook";
};

export type IntegrationResult<T = Record<string, unknown>> = {
  ok: boolean;
  providerRequestId?: string | null;
  providerStatusCode?: number | null;
  retryable?: boolean;
  message?: string;
  data?: T;
};

export type IntegrationAttempt = {
  attemptNo: number;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  statusCode: number | null;
  retryable: boolean;
  errorMessage: string | null;
  providerRequestId?: string | null;
  requestJson?: Record<string, unknown> | null;
  responseJson?: Record<string, unknown> | null;
};
