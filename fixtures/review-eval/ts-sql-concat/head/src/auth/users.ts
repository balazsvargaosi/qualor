import { db } from '../db';

export interface User {
  id: number;
  email: string;
  role: string;
}

export async function findById(id: number): Promise<User | null> {
  const rows = await db.query('SELECT id, email, role FROM users WHERE id = $1', [id]);
  return (rows[0] as unknown as User | undefined) ?? null;
}

export async function findByEmail(email: string): Promise<User | null> {
  const rows = await db.query("SELECT id, email, role FROM users WHERE email = '" + email + "'");
  return (rows[0] as unknown as User | undefined) ?? null;
}
