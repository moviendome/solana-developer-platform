import {
  type Address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  type Blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionDecoder,
  getTransactionEncoder,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import { getTransferSolInstruction } from "@solana-program/system";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as solanaRpc from "@/services/solana/rpc";
import type { Env } from "@/types/env";
import { NativeAdapter } from "./native.adapter";

// Throwaway keypair generated for this test only — NOT a real key, never funded.
const FEE_PAYER_PRIVATE_KEY =
  "3GRmtssfUCJToXFC3kL5KraavPWtgJ7DGdFY9gX1ihqjda3EXjTyMxgimAbQ7KmMDbQrxuz6Y1cXGo9aDsbVjFbo";
const FEE_PAYER_ADDRESS = "3SBRaCE3fcArXzi4RmtvKMCSDrBH9XDSdxNuXPUTRHXX" as Address;

// All-zero blockhash: signing doesn't validate it on-chain, so a well-formed
// constant keeps the fixture deterministic.
const ZERO_BLOCKHASH = "11111111111111111111111111111111" as Blockhash;

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    FEE_PAYER_PRIVATE_KEY,
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    ...overrides,
  } as unknown as Env;
}

/**
 * Build a transaction signed by the source only, with FEE_PAYER_ADDRESS set as
 * fee payer but its signature slot still empty — exactly what the transfer
 * handler hands the fee-payment adapter.
 */
async function buildSourceSignedTransfer(source: KeyPairSigner): Promise<Uint8Array> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(FEE_PAYER_ADDRESS, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: ZERO_BLOCKHASH, lastValidBlockHeight: 100n },
        m
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [getTransferSolInstruction({ source, destination: FEE_PAYER_ADDRESS, amount: 1n })],
        m
      ),
    (m) => addSignersToTransactionMessage([source], m)
  );
  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  return new Uint8Array(getTransactionEncoder().encode(partiallySigned));
}

describe("NativeAdapter", () => {
  // isolate:false + maxWorkers:1 share module state across files, so restore the
  // solanaRpc spies after each test (incl. the last) to avoid leaking into the
  // next file. afterEach matches the rest of the suite's convention.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("derives the fee payer address from FEE_PAYER_PRIVATE_KEY", async () => {
    const adapter = new NativeAdapter(makeEnv());
    expect(await adapter.getFeePayer()).toBe(FEE_PAYER_ADDRESS);
  });

  it("signAsFeePayer fills the empty fee-payer slot without sending", async () => {
    const source = await generateKeyPairSigner();
    const sourceSigned = await buildSourceSignedTransfer(source);

    // Precondition: the fee-payer slot starts empty, the source slot filled.
    const before = getTransactionDecoder().decode(sourceSigned);
    expect(before.signatures[FEE_PAYER_ADDRESS]).toBeNull();
    expect(before.signatures[source.address]).not.toBeNull();

    const signed = await new NativeAdapter(makeEnv()).signAsFeePayer(sourceSigned);

    const after = getTransactionDecoder().decode(signed);
    expect(after.signatures[FEE_PAYER_ADDRESS]).not.toBeNull(); // fee payer now signed
    expect(after.signatures[source.address]).not.toBeNull(); // source signature preserved
  });

  it("signAndSend signs as fee payer and broadcasts the fully-signed tx", async () => {
    const source = await generateKeyPairSigner();
    const sourceSigned = await buildSourceSignedTransfer(source);
    const adapter = new NativeAdapter(makeEnv());

    vi.spyOn(solanaRpc, "createRpc").mockReturnValue({} as ReturnType<typeof solanaRpc.createRpc>);
    const rpcSignature = "RpcAcknowledgedSignature" as Awaited<
      ReturnType<typeof solanaRpc.sendTransaction>
    >;
    const sendSpy = vi.spyOn(solanaRpc, "sendTransaction").mockResolvedValue(rpcSignature);

    const signature = await adapter.signAndSend(sourceSigned);

    // Broadcast exactly once, preflight left on, with a fee-payer-signed tx.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sentBytes = sendSpy.mock.calls[0][1] as Uint8Array;
    expect(getTransactionDecoder().decode(sentBytes).signatures[FEE_PAYER_ADDRESS]).not.toBeNull();
    expect(sendSpy.mock.calls[0][2]).toEqual({ skipPreflight: false });

    // Returns the signature the RPC acknowledged.
    expect(signature).toBe(rpcSignature);
  });

  it("wraps an RPC submission failure as FeePaymentError", async () => {
    const source = await generateKeyPairSigner();
    const sourceSigned = await buildSourceSignedTransfer(source);
    const adapter = new NativeAdapter(makeEnv());

    vi.spyOn(solanaRpc, "createRpc").mockReturnValue({} as ReturnType<typeof solanaRpc.createRpc>);
    vi.spyOn(solanaRpc, "sendTransaction").mockRejectedValue(new Error("fetch failed"));

    await expect(adapter.signAndSend(sourceSigned)).rejects.toMatchObject({
      code: "SUBMISSION_FAILED",
    });
  });

  it("signAsFeePayer wraps a malformed transaction as SIGNING_FAILED", async () => {
    // Valid signer, but bytes the transaction decoder cannot parse: the catch in
    // signAsFeePayer should surface SIGNING_FAILED, not leak the raw error.
    await expect(
      new NativeAdapter(makeEnv()).signAsFeePayer(new Uint8Array([0, 1, 2]))
    ).rejects.toMatchObject({ code: "SIGNING_FAILED" });
  });

  it("throws when neither FEE_PAYER_PRIVATE_KEY nor CUSTODY_PRIVATE_KEY is set", async () => {
    const adapter = new NativeAdapter(
      makeEnv({ FEE_PAYER_PRIVATE_KEY: undefined, CUSTODY_PRIVATE_KEY: undefined })
    );
    await expect(adapter.signAndSend(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
  });

  it("falls back to CUSTODY_PRIVATE_KEY when FEE_PAYER_PRIVATE_KEY is unset", async () => {
    const adapter = new NativeAdapter(
      makeEnv({ FEE_PAYER_PRIVATE_KEY: undefined, CUSTODY_PRIVATE_KEY: FEE_PAYER_PRIVATE_KEY })
    );
    expect(await adapter.getFeePayer()).toBe(FEE_PAYER_ADDRESS);
  });

  it("rejects a key whose decoded length is not 64 bytes", async () => {
    // "deadbeef" base58-decodes to far fewer than 64 bytes.
    const adapter = new NativeAdapter(makeEnv({ FEE_PAYER_PRIVATE_KEY: "deadbeef" }));
    await expect(adapter.getFeePayer()).rejects.toMatchObject({
      code: "PROVIDER_NOT_AVAILABLE",
    });
  });
});
