import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface CustomersTable {
  id: string;
  tenant_id: string;
  legacy_id: number;
  name: string;
  email: string | null;
  document_kind: 'cpf' | 'cnpj' | null;
  document_digits: string | null;
  status: 'active' | 'suspended' | 'closed';
  suspension_reason: 'non_payment' | 'customer_request' | null;
  registered_on: string | null;
  city: string | null;
  state: string | null;
  plan_code: string | null;
  plan_price_cents: bigint | null;
  data_issues: string[];
  /** Change Tracking version of the legacy row this state came from. */
  source_version: bigint;
  deleted_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Timestamp;
}

export interface InvoicesTable {
  id: string;
  tenant_id: string;
  legacy_id: number;
  customer_id: string;
  period: string;
  due_date: string;
  amount_cents: bigint;
  status: 'open' | 'paid' | 'void';
  void_reason: 'cancelled' | 'written_off' | null;
  paid_on: string | null;
  notes: string | null;
  data_issues: string[];
  source_version: bigint;
  created_at: Generated<Date>;
  updated_at: Timestamp;
}

export interface SyncCheckpointsTable {
  stream: string;
  position: bigint;
  updated_at: Timestamp;
}

export interface SyncDeadLettersTable {
  id: Generated<bigint>;
  stream: string;
  legacy_id: number;
  source_version: bigint;
  reason: string;
  detail: string | null;
  payload: ColumnType<unknown, string | null, string | null>;
  created_at: Generated<Date>;
  resolved_at: Date | null;
}

export type Entity = 'customers' | 'invoices';
export type Owner = 'legacy' | 'modern';

export interface RoutingRulesTable {
  route_id: string;
  tenant_id: string;
  modern_percent: number;
  shadow_percent: number;
  updated_at: Timestamp;
  updated_by: string;
}

export interface EntityOwnershipTable {
  entity: Entity;
  tenant_id: string;
  owner: Owner;
  changed_at: Timestamp;
  changed_by: string;
}

export interface GatewaySettingsTable {
  id: Generated<boolean>;
  kill_switch: boolean;
  updated_at: Timestamp;
  updated_by: string;
}

export interface RoutingAuditTable {
  id: Generated<bigint>;
  actor: string;
  action: string;
  detail: ColumnType<unknown, string, never>;
  created_at: Generated<Date>;
}

export interface ShadowMismatchesTable {
  id: Generated<bigint>;
  route_id: string;
  tenant_id: string;
  resource_id: string | null;
  request_id: string | null;
  served_by: string;
  diff: ColumnType<unknown, string, never>;
  created_at: Generated<Date>;
}

export interface Database {
  customers: CustomersTable;
  invoices: InvoicesTable;
  sync_checkpoints: SyncCheckpointsTable;
  sync_dead_letters: SyncDeadLettersTable;
  routing_rules: RoutingRulesTable;
  entity_ownership: EntityOwnershipTable;
  gateway_settings: GatewaySettingsTable;
  routing_audit: RoutingAuditTable;
  shadow_mismatches: ShadowMismatchesTable;
}
