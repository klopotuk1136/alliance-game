// The part of the `web-push` package (no bundled types) that server/push.ts uses.
declare module 'web-push' {
  export interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }
  export interface RequestOptions {
    TTL?: number;
    urgency?: 'very-low' | 'low' | 'normal' | 'high';
    topic?: string;
    timeout?: number;
    vapidDetails?: { subject: string; publicKey: string; privateKey: string };
  }
  export interface SendResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }
  export class WebPushError extends Error {
    statusCode: number;
    body: string;
    endpoint: string;
  }
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
  export function sendNotification(sub: PushSubscription, payload?: string | Buffer | null, options?: RequestOptions): Promise<SendResult>;
}
