import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { getKmsKeyPath } from './runtimeConfig';
import 'dotenv/config';
import { createHash } from 'crypto';

let kmsClient: any = null;

async function getKmsClient() {
  if (kmsClient) return kmsClient;
  try {
    // Lazy import to avoid cost when not configured
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { KeyManagementServiceClient } = require('@google-cloud/kms');
    kmsClient = new KeyManagementServiceClient();
    return kmsClient;
  } catch (e) {
    return null;
  }
}

export interface KmsSignResult { signatureBase64: string; algo: string; }

export async function kmsSign(data: Buffer): Promise<KmsSignResult | null> {
  const keyPath = getKmsKeyPath();
  if (!keyPath) return null;
  try {
    const client = await getKmsClient();
    if (!client) return null;
    const [resp] = await client.asymmetricSign({
      name: keyPath,
      digest: { sha256: createHash('sha256').update(data).digest() }
    });
    const sig = resp.signature?.toString('base64') || '';
    return { signatureBase64: sig, algo: 'KMS_EC_SIGN_P256_SHA256' };
  } catch (e) {
    console.warn('KMS sign failed', e);
    return null;
  }
}

interface AuditEventInput {
  event: string;
  uid?: string | null;
  refId?: string;
  data?: Record<string, any>;
  severity?: 'info'|'warn'|'error';
}

export async function logEvent(input: AuditEventInput) {
  const db = admin.firestore();
  const ts = admin.firestore.Timestamp.now();
  const payload = { ...input, ts: ts, createdAt: ts };
  // Hash canonical string for tamper detection
  const canonical = JSON.stringify({ e: input.event, u: input.uid, r: input.refId, d: input.data, t: ts.toMillis() });
  const hash = createHash('sha256').update(canonical).digest('hex');
  let sig: KmsSignResult | null = null;
  try { sig = await kmsSign(Buffer.from(canonical)); } catch { /* ignore */ }
  await db.collection('audit_logs').add({
    ...payload,
    hash,
    signature: sig ? { ...sig } : null
  });
}
