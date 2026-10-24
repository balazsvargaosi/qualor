import { findByEmail, findById } from './users';

export async function sessionUser(userId: number): Promise<string> {
  const user = await findById(userId);
  return user === null ? 'anonymous' : user.email;
}

/** The sign-in page asks whether an address is registered before it shows the password field. */
export async function isRegistered(email: string): Promise<boolean> {
  return (await findByEmail(email.trim())) !== null;
}
