export type Row = Record<string, unknown>;

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  /** The database fills it when an insert leaves it out (a default or an auto-increment key). */
  hasDefault?: boolean;
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

export type SourceKind = 'sqlite' | 'postgres' | 'mysql' | 'csv' | 'excel' | 'gsheet';

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
  'submit_dispute_evidence',
  'pay_supplier',
  'offer_payment_plan',
  'apply_late_fee',
  'expire_discount',
  'send_statement',
  'charge_autopay',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface ActionTarget {
  entity: 'invoice' | 'subscription' | 'customer' | 'payable';
  legacyPk: string;
  paypalId?: string;
  label?: string;
}

export type ActionOrigin =
  | 'sync'
  | 'agent'
  | 'dashboard'
  | 'cli'
  | 'reconcile'
  | 'portal'
  /** A customer's email, read by the inbox agent. Emails can be forged: money actions always wait for the owner. */
  | 'inbox'
  /** A customer's own AI assistant over MCP. */
  | 'assistant';

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
