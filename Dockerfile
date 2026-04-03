FROM node:20-bookworm AS builder

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# -------------------------------------------------------------------
# Production image
# -------------------------------------------------------------------
FROM node:20-bookworm-slim

WORKDIR /app

# Install runtime dependencies.
# - curl: for healthchecks
# - git, build-essential, cmake: only needed if building rapidsnark from source
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Optionally install rapidsnark for ARM64 Linux.
# The binary is significantly faster than snarkjs WASM (~0.5s vs ~15-45s).
# If rapidsnark is not available for the platform, snarkjs WASM is used as fallback.
#
# To build rapidsnark from source (requires build tools):
# RUN apt-get update && \
#     apt-get install -y --no-install-recommends git build-essential cmake libgmp-dev nasm && \
#     git clone https://github.com/nicecash/rapidsnark.git /tmp/rapidsnark && \
#     cd /tmp/rapidsnark && \
#     git submodule update --init --recursive && \
#     mkdir build && cd build && cmake .. && make -j$(nproc) && \
#     cp /tmp/rapidsnark/build/prover /usr/local/bin/rapidsnark && \
#     rm -rf /tmp/rapidsnark && \
#     apt-get purge -y git build-essential cmake && \
#     apt-get autoremove -y && \
#     rm -rf /var/lib/apt/lists/*
#
# If you have a pre-built rapidsnark binary, copy it in:
# COPY rapidsnark /usr/local/bin/rapidsnark
# RUN chmod +x /usr/local/bin/rapidsnark

COPY package.json ./
RUN npm install --omit=dev

# Copy compiled JavaScript from builder.
COPY --from=builder /app/dist ./dist

# Artifacts directory for .wasm and .zkey files.
# Mount a volume here with the circuit artifacts.
RUN mkdir -p /app/artifacts
ENV ARTIFACTS_DIR=/app/artifacts

EXPOSE 5000

CMD ["node", "dist/index.js"]
