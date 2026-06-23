import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { createFeePaymentAdapter } from "./index";
import { KoraAdapter } from "./kora";
import { NativeAdapter } from "./native";

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  // SOLANA_NETWORK lets createKoraAdapter resolve a default Kora URL without
  // KORA_RPC_URL, so the "kora" case constructs without throwing.
  return { SOLANA_NETWORK: "devnet", ...overrides } as unknown as Env;
}

describe("createFeePaymentAdapter", () => {
  it("defaults to the native adapter when FEE_PAYMENT_PROVIDER is unset", () => {
    expect(createFeePaymentAdapter(makeEnv())).toBeInstanceOf(NativeAdapter);
  });

  it("returns the Kora adapter when FEE_PAYMENT_PROVIDER=kora", () => {
    expect(createFeePaymentAdapter(makeEnv({ FEE_PAYMENT_PROVIDER: "kora" }))).toBeInstanceOf(
      KoraAdapter
    );
  });

  it("returns the native adapter when FEE_PAYMENT_PROVIDER=native", () => {
    expect(createFeePaymentAdapter(makeEnv({ FEE_PAYMENT_PROVIDER: "native" }))).toBeInstanceOf(
      NativeAdapter
    );
  });

  it("falls back to the native adapter for an unrecognized provider", () => {
    expect(
      createFeePaymentAdapter(makeEnv({ FEE_PAYMENT_PROVIDER: "something-else" }))
    ).toBeInstanceOf(NativeAdapter);
  });
});
