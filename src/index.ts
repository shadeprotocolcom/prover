import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as snarkjs from "snarkjs";
import type { CircuitSignals } from "snarkjs";

dotenv.config();

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "5000", 10);
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR ?? path.join(process.cwd(), "artifacts");
const WASM_PATH = path.join(ARTIFACTS_DIR, "joinsplit.wasm");
const ZKEY_PATH = path.join(ARTIFACTS_DIR, "joinsplit.zkey");

// ---------------------------------------------------------------------------
// Prover type detection
// ---------------------------------------------------------------------------

type ProverType = "rapidsnark" | "snarkjs";

let proverType: ProverType = "snarkjs";
let rapidsnarkPath: string | null = null;

/**
 * Check if rapidsnark binary is available.
 */
async function detectProverType(): Promise<void> {
  const candidates = [
    "rapidsnark",
    "/usr/local/bin/rapidsnark",
    "/usr/bin/rapidsnark",
    path.join(ARTIFACTS_DIR, "rapidsnark"),
  ];

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--help"]);
      rapidsnarkPath = candidate;
      proverType = "rapidsnark";
      process.stdout.write(`[prover] Found rapidsnark at: ${candidate}\n`);
      return;
    } catch {
      // Not found, try next.
    }
  }

  process.stdout.write(
    "[prover] rapidsnark not found, falling back to snarkjs (WASM)\n",
  );
  proverType = "snarkjs";
}

// ---------------------------------------------------------------------------
// Proof generation
// ---------------------------------------------------------------------------

/**
 * The proof result matching the contract's SnarkProof struct.
 */
interface ProofResult {
  proof: {
    a: [string, string];
    b: [[string, string], [string, string]];
    c: [string, string];
  };
  publicSignals: string[];
}

/**
 * Convert a decimal string to a 0x-prefixed 32-byte hex string.
 */
function toHex256(value: string): string {
  const bi = BigInt(value);
  return "0x" + bi.toString(16).padStart(64, "0");
}

/**
 * Format snarkjs/rapidsnark proof output into the contract-compatible format.
 *
 * snarkjs outputs:
 *   proof.pi_a = [x, y, "1"]
 *   proof.pi_b = [[x0, x1], [y0, y1], ["1", "0"]]
 *   proof.pi_c = [x, y, "1"]
 *
 * Contract expects (per EIP-197 / Ethereum bn128 precompile):
 *   a = [x, y]                    (G1 point)
 *   b = [[x1, x0], [y1, y0]]     (G2 point — coordinates swapped)
 *   c = [x, y]                    (G1 point)
 */
function formatProof(
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
  },
  publicSignals: string[],
): ProofResult {
  return {
    proof: {
      a: [toHex256(proof.pi_a[0]), toHex256(proof.pi_a[1])],
      b: [
        [toHex256(proof.pi_b[0][1]), toHex256(proof.pi_b[0][0])],
        [toHex256(proof.pi_b[1][1]), toHex256(proof.pi_b[1][0])],
      ],
      c: [toHex256(proof.pi_c[0]), toHex256(proof.pi_c[1])],
    },
    publicSignals: publicSignals.map(toHex256),
  };
}

/**
 * Generate a Groth16 proof using snarkjs (WASM-based).
 * This is the fallback when rapidsnark is not available.
 */
async function proveWithSnarkjs(
  witness: CircuitSignals,
): Promise<ProofResult> {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    witness,
    WASM_PATH,
    ZKEY_PATH,
  );
  return formatProof(proof, publicSignals);
}

/**
 * Generate a Groth16 proof using rapidsnark (native binary, ~100x faster).
 *
 * Flow:
 * 1. Use snarkjs to calculate the witness from the WASM circuit.
 * 2. Write the witness to a .wtns temp file.
 * 3. Run rapidsnark with the .zkey and .wtns to produce the proof.
 * 4. Parse the proof JSON output.
 */
async function proveWithRapidsnark(
  witness: CircuitSignals,
): Promise<ProofResult> {
  if (!rapidsnarkPath) {
    throw new Error("rapidsnark binary not found");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shade-prover-"));
  const wtnsPath = path.join(tmpDir, "witness.wtns");
  const proofPath = path.join(tmpDir, "proof.json");
  const publicPath = path.join(tmpDir, "public.json");

  try {
    // Step 1: Calculate witness using snarkjs WASM engine.
    // snarkjs.wtns.calculate writes the witness binary directly to a file.
    await snarkjs.wtns.calculate(witness, WASM_PATH, wtnsPath);

    // Step 2: Run rapidsnark to generate proof from witness + zkey.
    await execFileAsync(rapidsnarkPath, [
      ZKEY_PATH,
      wtnsPath,
      proofPath,
      publicPath,
    ]);

    // Step 3: Read and parse the proof output files.
    const proofJson = JSON.parse(fs.readFileSync(proofPath, "utf-8"));
    const publicSignals: string[] = JSON.parse(
      fs.readFileSync(publicPath, "utf-8"),
    );

    return formatProof(proofJson, publicSignals);
  } finally {
    // Clean up temp files.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

/**
 * Generate a proof using the best available prover.
 */
async function generateProof(
  witness: CircuitSignals,
): Promise<ProofResult> {
  if (proverType === "rapidsnark" && rapidsnarkPath) {
    return proveWithRapidsnark(witness);
  }
  return proveWithSnarkjs(witness);
}

// ---------------------------------------------------------------------------
// Express server
// ---------------------------------------------------------------------------

function createServer(): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  /**
   * POST /prove
   * Body: witness JSON (the circuit's private + public inputs).
   * Returns: { proof, publicSignals } formatted for the contract.
   */
  app.post("/prove", async (req, res) => {
    const startTime = Date.now();

    try {
      const witness = req.body;

      if (!witness || typeof witness !== "object" || Object.keys(witness).length === 0) {
        res.status(400).json({ error: "Missing or empty witness body" });
        return;
      }

      const result = await generateProof(witness);
      const elapsed = Date.now() - startTime;

      process.stdout.write(
        `[prover] Proof generated in ${elapsed}ms (${proverType})\n`,
      );

      res.json(result);
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[prover] Proof generation failed after ${elapsed}ms: ${message}\n`,
      );
      res.status(500).json({ error: `Proof generation failed: ${message}` });
    }
  });

  /**
   * GET /health
   * Returns server health and prover type.
   */
  app.get("/health", (_req, res) => {
    const wasmExists = fs.existsSync(WASM_PATH);
    const zkeyExists = fs.existsSync(ZKEY_PATH);

    res.json({
      status: "ok",
      proverType,
      rapidsnarkPath: rapidsnarkPath ?? null,
      artifacts: {
        wasmPath: WASM_PATH,
        wasmExists,
        zkeyPath: ZKEY_PATH,
        zkeyExists,
      },
    });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stdout.write("[prover] Starting Shade Protocol Prover Server...\n");

  // Check if artifact files exist.
  if (!fs.existsSync(WASM_PATH)) {
    process.stderr.write(
      `[prover] WARNING: WASM artifact not found at ${WASM_PATH}\n`,
    );
  }
  if (!fs.existsSync(ZKEY_PATH)) {
    process.stderr.write(
      `[prover] WARNING: zkey artifact not found at ${ZKEY_PATH}\n`,
    );
  }

  // Detect the available prover type.
  await detectProverType();

  // Start the Express server.
  const app = createServer();
  app.listen(PORT, () => {
    process.stdout.write(
      `[prover] REST API listening on port ${PORT} (prover: ${proverType})\n`,
    );
  });

  // Graceful shutdown.
  const shutdown = () => {
    process.stdout.write("[prover] Shutting down...\n");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`[prover] Fatal error: ${err}\n`);
  process.exit(1);
});
