/**
 * Shared contracts between the Electron main process (backend bridge) and the
 * renderer (frontend). Kept dependency-free so both sides can import them.
 */

export type DbEngine = 'sqlite' | 'postgres' | 'mysql';

export interface ConnectionProfile {
  id?: string;
  name: string;
  engine: DbEngine;
  host?: string;
  port?: number;
  database: string;
  username?: string;
  password?: string; // sensitive - never logged
  ssl?: boolean;
  connectTimeoutMs?: number;
}

export interface ConnectionSummary {
  connectionId: string;
  engine: DbEngine;
  database: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable?: boolean;
  defaultValue?: any;
  maxLength?: number | null;
}

export interface TableInfo {
  name: string;
  type: 'table' | 'view';
  columns?: ColumnInfo[];
}

export interface ExecutionResult {
  status: 'ok' | 'error';
  columns: Array<{ name: string; dataType: string }>;
  rows: Array<Array<any>>;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  error?: { code: string; message: string };
}

export interface ValidateResult {
  valid: boolean;
  errors: string[];
}

export interface IpcResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
