import { findById } from './users';

export async function sessionUser(userId: number): Promise<string> {
  const user = await findById(userId);
  return user === null ? 'anonymous' : user.email;
}
