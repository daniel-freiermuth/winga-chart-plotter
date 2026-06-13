wasm_pack := env_var('HOME') / ".cargo/bin/wasm-pack"
core      := "crates/core"
app       := "app"
wasm_out  := app / "src/wasm"

# Show available recipes
help:
    @just --list

# Install frontend dependencies
install:
    cd {{app}} && npm install

# Compile Rust core to WebAssembly
build-wasm:
    {{wasm_pack}} build {{core}} --target web --out-dir ../../{{wasm_out}}

# Build WASM + frontend for production
build: build-wasm
    cd {{app}} && npm run build

# Build and assemble Signal K npm package (output: public/)
package: build
    rm -rf public && cp -r {{app}}/dist public

# Build WASM then start the Vite dev server
dev: build-wasm
    cd {{app}} && npm run dev

# Run all Rust unit tests
test:
    cargo test

# Run Rust tests in watch mode (requires cargo-watch)
test-watch:
    cargo watch -x test

# Run all linters and type-checkers (Rust + TypeScript)
lint:
    cargo fmt --check
    cargo clippy --all-targets --all-features -- -D warnings
    cd {{app}} && npm run check && npm run lint

# Run all lints and tests
check-all: lint test

# Remove build artifacts
clean:
    rm -rf target {{wasm_out}} {{app}}/dist

# Install deps and build everything
all: install build

# Build and publish npm package
publish: package
    npm pack && npm publish
