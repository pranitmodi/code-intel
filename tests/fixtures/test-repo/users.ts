import { getDatabase } from './database.js';

export interface User {
  id: string;
  username: string;
  email: string;
}

export class UserRepository {
  async findById(id: string): Promise<User | null> {
    const db = getDatabase();
    return db.findUserById(id);
  }

  async create(username: string, email: string): Promise<User> {
    const db = getDatabase();
    return db.insertUser(username, email);
  }
}
