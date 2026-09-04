import type { User } from './users.js';

class Database {
  private users: User[] = [];

  async findUserByCredentials(username: string, _password: string): Promise<User | null> {
    return this.users.find((u) => u.username === username) ?? null;
  }

  async findUserById(id: string): Promise<User | null> {
    return this.users.find((u) => u.id === id) ?? null;
  }

  async insertUser(username: string, email: string): Promise<User> {
    const user: User = { id: `${this.users.length + 1}`, username, email };
    this.users.push(user);
    return user;
  }

  async recordPayment(_userId: string, _amountCents: number, _transactionId: string): Promise<void> {
    // append-only ledger write would go here
  }

  async markPaymentRetried(_transactionId: string): Promise<void> {
    // update retry counter would go here
  }
}

let instance: Database | undefined;

export function getDatabase(): Database {
  if (!instance) instance = new Database();
  return instance;
}
