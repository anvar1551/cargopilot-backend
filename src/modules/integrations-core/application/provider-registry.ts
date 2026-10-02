import type { IntegrationProviderRef, ProviderStatus } from "../domain/types";

export type ProviderFilter = {
  companyId: string;
  domain?: IntegrationProviderRef["domain"];
  status?: ProviderStatus;
  providerCode?: string;
};

export interface ProviderRegistryRepository {
  findMany(filter: ProviderFilter): Promise<IntegrationProviderRef[]>;
  findById(providerId: string): Promise<IntegrationProviderRef | null>;
  findOne(args: { companyId: string; domain: IntegrationProviderRef["domain"]; providerCode: string }): Promise<IntegrationProviderRef | null>;


}

export interface ProviderRegistryService {
  listActiveProviders(args: { companyId: string; domain: IntegrationProviderRef["domain"] }): Promise<IntegrationProviderRef[]>;
  resolveProvider(args: {
    companyId: string;
    domain: IntegrationProviderRef["domain"];
    providerCode?: string;
    providerId?: string | null;
    environment?: IntegrationProviderRef["environment"] | null;
  }): Promise<IntegrationProviderRef | null>;
}
