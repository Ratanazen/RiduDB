declare module 'better-sqlite3' {
  function Database(path: string, options?: object): Database.Database;
  namespace Database {
    interface Database {
      prepare(sql: string): Statement;
      all(sql: string, params?: any[]): any[];
      close(): void;
    }
    interface Statement {
      all(params?: any[]): any[];
      run(params?: any[]): any;
      get(params?: any[]): any;
      columns: any[];
      free(): void;
    }
  }
  export = Database;
}
