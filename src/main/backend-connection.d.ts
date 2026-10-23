declare module '*/../../backend/src/connection' {
  export class ConnectionManager {
    connect(profile: any): Promise<{ connectionId: string; engine: string; database: string }>;
    disconnect(connectionId: string): Promise<{ ok: boolean }>;
    executeQuery(connectionId: string, params: { sql: string; params: any[] }): Promise<any>;
    listTables(connectionId: string): Promise<{ tables: { name: string; type: string }[] }>;
    listColumns(connectionId: string, tableName: string): Promise<{ columns: { name: string; dataType: string; isNullable: boolean; defaultValue: any }[] }>;
    listConnections(): { connections: { connectionId: string; engine: string; database: string }[] };
    closeAll(): Promise<void>;
  }
}