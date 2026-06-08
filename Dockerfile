# Build stage
FROM rust:1.87-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy workspace files
COPY Cargo.toml Cargo.lock ./
COPY apps/control-plane apps/control-plane

# Build release binary
RUN cargo build --release --bin opengpu-control-plane

# Runtime stage
FROM debian:bookworm-slim

# Install curl (required for Supabase REST API calls) and CA certs for TLS
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/opengpu-control-plane /usr/local/bin/opengpu-control-plane

EXPOSE 8080

CMD ["opengpu-control-plane"]
