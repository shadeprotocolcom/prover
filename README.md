# @shade-protocol/prover

ZK proof generation server for Shade Protocol. Receives a witness, generates a Groth16 proof, returns it.

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/prove` | Generate Groth16 proof from witness JSON |
| `GET` | `/health` | Service health and prover type |

### POST /prove

Request body: circuit witness JSON (signal names as keys, decimal strings as values).

Response:
```json
{
  "proof": {
    "a": ["0x...", "0x..."],
    "b": [["0x...", "0x..."], ["0x...", "0x..."]],
    "c": ["0x...", "0x..."]
  },
  "publicSignals": ["..."]
}
```

## Run

```bash
npm install
npm run build
npm start
```

Place circuit artifacts in `./artifacts/`:
- `joinsplit.wasm` — Witness generator
- `joinsplit_final.zkey` — Proving key

Uses rapidsnark (native ARM64, <1s) if available, falls back to snarkjs WASM.

## Docker

```bash
docker build -t shade-prover .
docker run -p 5000:5000 -v ./artifacts:/app/artifacts shade-prover
```

## Related Repos

- [circuits](https://github.com/shadeprotocolcom/circuits) — ZK circuits (produces the artifacts)
- [sdk](https://github.com/shadeprotocolcom/sdk) — TypeScript SDK (calls this server)
- [frontend](https://github.com/shadeprotocolcom/frontend) — Web app

## License

MIT
