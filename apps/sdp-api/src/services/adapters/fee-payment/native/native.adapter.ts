/**
 * Native Fee Payment Adapter
 *
 * Default adapter when FEE_PAYMENT_PROVIDER is unset: signs as fee payer and
 * broadcasts over direct RPC, with no external relayer dependency.
 *
 * Requires a funded keypair to be configured as the fee payer. Set
 * FEE_PAYMENT_PROVIDER=kora to opt into the Kora relay instead.
 */

import { getBase58Codec } from "@solana/codecs";
import {
  type Address,
  createKeyPairSignerFromBytes,
  getTransactionDecoder,
  getTransactionEncoder,
  type KeyPairSigner,
  partiallySignTransaction,
  type Signature,
} from "@solana/kit";
import type { FeePaymentErrorCode, FeePaymentPort } from "@/services/ports";
import { FeePaymentError } from "@/services/ports";
import * as solanaRpc from "@/services/solana/rpc";
import type { Env } from "@/types/env";

const base58 = getBase58Codec();

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Native fee payment adapter using direct SOL payment.
 *
 * This adapter requires:
 * 1. A funded keypair (FEE_PAYER_PRIVATE_KEY or CUSTODY_PRIVATE_KEY env var)
 * 2. Direct RPC access for transaction submission
 *
 * The fee payer pays the fee itself (no sponsor). Use KoraAdapter when a
 * gasless/relayer flow is required.
 */
export class NativeAdapter implements FeePaymentPort {
  readonly providerId = "native";

  private env: Env;
  private signer: KeyPairSigner | null = null;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Get the fee payer address.
   * Uses FEE_PAYER_PRIVATE_KEY if set, falls back to CUSTODY_PRIVATE_KEY.
   */
  async getFeePayer(): Promise<Address> {
    const signer = await this.getSigner();
    return signer.address;
  }

  /**
   * Sign a transaction as fee payer.
   * Note: This only adds the fee payer signature, does not send.
   */
  async signAsFeePayer(transaction: Uint8Array): Promise<Uint8Array> {
    try {
      const feePayer = await this.getSigner();
      const decoded = getTransactionDecoder().decode(transaction);
      const signed = await partiallySignTransaction([feePayer.keyPair], decoded);
      return new Uint8Array(getTransactionEncoder().encode(signed));
    } catch (error) {
      throw this.wrapError(error, "Failed to sign transaction as fee payer", "SIGNING_FAILED");
    }
  }

  /**
   * Sign as fee payer and broadcast. The fee payer must be a funded account —
   * it pays the fee itself; there is no sponsor. Confirmation is the caller's.
   */
  async signAndSend(transaction: Uint8Array): Promise<Signature> {
    try {
      const wireTransaction = await this.signAsFeePayer(transaction);
      const rpc = solanaRpc.createRpc(this.env);
      return await solanaRpc.sendTransaction(rpc, wireTransaction, { skipPreflight: false });
    } catch (error) {
      throw this.wrapError(error, "Failed to sign and send transaction", "SUBMISSION_FAILED");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Normalize a thrown value to a FeePaymentError so callers can branch on the
   * port's error type (as KoraAdapter does). An existing FeePaymentError — e.g.
   * the PROVIDER_NOT_AVAILABLE from getSigner — passes through unchanged.
   */
  private wrapError(error: unknown, message: string, code: FeePaymentErrorCode): FeePaymentError {
    if (error instanceof FeePaymentError) {
      return error;
    }
    const cause = error instanceof Error ? error : undefined;
    return new FeePaymentError(`${message}: ${cause?.message ?? String(error)}`, code, cause);
  }

  private async getSigner(): Promise<KeyPairSigner> {
    if (this.signer) {
      return this.signer;
    }

    // Try FEE_PAYER_PRIVATE_KEY first, fall back to CUSTODY_PRIVATE_KEY
    const privateKey = this.env.FEE_PAYER_PRIVATE_KEY ?? this.env.CUSTODY_PRIVATE_KEY;

    if (!privateKey) {
      throw new FeePaymentError(
        "FEE_PAYER_PRIVATE_KEY or CUSTODY_PRIVATE_KEY not configured",
        "PROVIDER_NOT_AVAILABLE"
      );
    }

    const secretKey = base58.encode(privateKey);

    if (secretKey.length !== 64) {
      throw new FeePaymentError(
        `Invalid keypair length: expected 64 bytes, got ${secretKey.length}`,
        "PROVIDER_NOT_AVAILABLE"
      );
    }

    this.signer = await createKeyPairSignerFromBytes(secretKey);
    return this.signer;
  }
}
