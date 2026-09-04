import { getDatabase } from './database.js';

export interface PaymentResult {
  success: boolean;
  transactionId: string;
}

export class PaymentProcessor {
  async charge(userId: string, amountCents: number): Promise<PaymentResult> {
    const db = getDatabase();
    const transactionId = `txn_${Date.now()}`;
    await db.recordPayment(userId, amountCents, transactionId);
    return { success: true, transactionId };
  }

  async retryFailedPayment(transactionId: string): Promise<PaymentResult> {
    const db = getDatabase();
    await db.markPaymentRetried(transactionId);
    return { success: true, transactionId };
  }
}
