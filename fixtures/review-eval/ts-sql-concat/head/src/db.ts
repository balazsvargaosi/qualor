export interface Row {
  [column: string]: string | number | null;
}

/** Runs one statement with its parameters bound by the driver: `$1`, `$2`, ... */
export const db = {
  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    const response = await fetch('http://localhost:5433/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    });
    if (!response.ok) {
      throw new Error(`query failed with ${response.status}`);
    }
    return (await response.json()) as Row[];
  },
};
