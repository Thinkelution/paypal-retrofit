export type Row = Record<string, unknown>;

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
}

export interface ForeignKey {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKey[];
  rowCount: number;
  /** A few rows with personal data masked. Safe to show to an LLM. */
  samples: Row[];
  /** Distinct values of short text columns that look like enums (status, state, type...). */
  enums: Record<string, string[]>;
}

export interface SchemaDescription {
  source: SourceKind;
  location: string;
  tables: TableInfo[];
}

export type SourceKind = 'sqlite' | 'postgres' | 'csv';

export type PayPalEnvironment = 'SANDBOX' | 'PRODUCTION' | 'MOCK';

export type PolicyMode = 'auto' | 'confirm' | 'never';

export const ACTION_KINDS = [
  'create_invoice',
  'send_invoice',
  'update_invoice',
  'send_reminder',
  'cancel_invoice',
  'record_payment',
  'create_refund',
  'create_subscription',
  'cancel_subscription',
  'accept_dispute',
  'offer_payment_plan',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface ActionTarget {
  entity: 'invoice' | 'subscription';
  legacyPk: string;
  paypalId?: string;
  label?: string;
}

export type ActionOrigin = 'sync' | 'agent' | 'dashboard' | 'cli' | 'reconcile';

export interface ActionRecord {
  id: number;
  origin: ActionOrigin;
  kind: ActionKind;
  target: ActionTarget;
  payload: Record<string, unknown>;
  reason: string;
  policy: PolicyMode;
  status: 'pending' | 'scheduled' | 'executed' | 'rejected' | 'failed' | 'skipped';
  createdAt: string;
  decidedAt: string | null;
  result: unknown;
  /** Why the policy engine chose this mode (rule, limit, quiet hours). */
  policyReason: string | null;
  /** Money involved, when the action has an amount. */
  amount: number | null;
  /** For scheduled actions: when they will run. */
  runAfter: string | null;
}
