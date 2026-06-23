/**
 * Fee Payment Adapters Registry
 *
 * Factory functions for creating fee payment adapters. Native is the default
 * (no external dependency); Kora is the opt-in gasless/relayer provider.
 */

import type { FeePaymentPort } from "@/services/ports";
import { FeePaymentError } from "@/services/ports";
import type { Env } from "@/types/env";
import { KoraAdapter, type KoraAdapterConfig } from "./kora";
import { NativeAdapter } from "./native";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Supported fee payment provider types */
export type FeePaymentProviderType = "kora" | "native";

// ═══════════════════════════════════════════════════════════════════════════
// Default URLs
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Default Kora RPC URLs by network.
 * These may need to be updated based on Solana Foundation's deployment.
 */
const DEFAULT_KORA_URLS: Record<string, string> = {
  devnet: "https://kora-devnet.solana.com",
  "mainnet-beta": "https://kora.solana.com",
};

// ═══════════════════════════════════════════════════════════════════════════
// Factory Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a fee payment adapter from environment variables.
 * Defaults to the native adapter when FEE_PAYMENT_PROVIDER is unset, matching
 * the self-hosted guidance in .dev.vars.example (native = no external
 * dependency; Kora points at a public relayer endpoint).
 * Kora is opt-in via FEE_PAYMENT_PROVIDER=kora.
 */
export function createFeePaymentAdapter(env: Env): FeePaymentPort {
  const provider = (env.FEE_PAYMENT_PROVIDER ?? "native") as FeePaymentProviderType;

  switch (provider) {
    case "kora":
      return createKoraAdapter(env);
    case "native":
      return new NativeAdapter(env);
    default:
      return new NativeAdapter(env);
  }
}

/**
 * Create a Kora adapter from environment configuration.
 */
export function createKoraAdapter(env: Env): KoraAdapter {
  // Get RPC URL from env or use default based on network
  const rpcUrl = env.KORA_RPC_URL ?? getDefaultKoraUrl(env);

  if (!rpcUrl) {
    throw new FeePaymentError(
      "KORA_RPC_URL not configured and no default URL for network",
      "PROVIDER_NOT_AVAILABLE"
    );
  }

  const config: KoraAdapterConfig = {
    rpcUrl,
    apiKey: env.KORA_API_KEY,
    timeoutMs: env.KORA_TIMEOUT_MS ? Number.parseInt(env.KORA_TIMEOUT_MS, 10) : undefined,
  };

  return new KoraAdapter(config);
}

/**
 * Create a native fee payment adapter (for testing/fallback).
 */
export function createNativeAdapter(env: Env): NativeAdapter {
  return new NativeAdapter(env);
}

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

function getDefaultKoraUrl(env: Env): string | undefined {
  const network = env.SOLANA_NETWORK ?? "devnet";
  return DEFAULT_KORA_URLS[network];
}

// ═══════════════════════════════════════════════════════════════════════════
// Re-exports
// ═══════════════════════════════════════════════════════════════════════════

export { KoraAdapter, KoraClient } from "./kora";
export { NativeAdapter } from "./native";
