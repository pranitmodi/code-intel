import { getDatabase } from './database.js';

export class AuthService {
  private sessions = new Map<string, string>();

  async login(username: string, password: string): Promise<string> {
    const db = getDatabase();
    const user = await db.findUserByCredentials(username, password);
    if (!user) throw new Error('invalid credentials');
    const token = createToken(user.id);
    this.sessions.set(token, user.id);
    return token;
  }

  async refreshToken(oldToken: string): Promise<string> {
    const userId = this.sessions.get(oldToken);
    if (!userId) throw new Error('session expired, please log in again');
    this.sessions.delete(oldToken);
    const newToken = createToken(userId);
    this.sessions.set(newToken, userId);
    return newToken;
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }
}

function createToken(userId: string): string {
  return `${userId}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
}
