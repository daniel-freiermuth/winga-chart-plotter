# wasm-pack pin — keep in sync with WASM_PACK_VERSION in
# .github/workflows/{ci,deploy}.yml and .gitlab-ci.yml.
wasm_pack_version := "0.15.0"
wasm_pack := env_var_or_default('CARGO_HOME', env_var('HOME') / ".cargo") / "bin/wasm-pack"
core      := "crates/core"
app       := "app"
wasm_out  := app / "src/wasm"

# Show available recipes
help:
    @just --list

# Install frontend dependencies
install:
    cd {{app}} && pnpm install

# Install the pinned wasm-pack (wasm_pack_version) via cargo
install-wasm-pack:
    cargo install wasm-pack --locked --version {{wasm_pack_version}}

# Fail unless the local wasm-pack is the pinned version CI builds with
check-wasm-pack:
    #!/usr/bin/env sh
    found="$("{{wasm_pack}}" --version 2>/dev/null)"
    if [ "$found" != "wasm-pack {{wasm_pack_version}}" ]; then
        echo "error: {{wasm_pack}} is '${found:-missing}', expected 'wasm-pack {{wasm_pack_version}}' (the version CI builds with). Run: just install-wasm-pack" >&2
        exit 1
    fi

# Compile Rust core to WebAssembly
build-wasm: check-wasm-pack
    {{wasm_pack}} build {{core}} --target web --out-dir ../../{{wasm_out}}

# Build WASM + frontend for production
build: build-wasm
    cd {{app}} && pnpm run build

# Build and assemble Signal K npm package (output: public/)
package: build
    rm -rf public && cp -r {{app}}/dist public

# Build WASM then start the Vite dev server
dev: build-wasm
    cd {{app}} && pnpm run dev

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
    cd {{app}} && pnpm run check && pnpm run lint

# Run all lints and tests
check-all: lint test

# Remove build artifacts
clean:
    rm -rf target {{wasm_out}} {{app}}/dist

# Install deps and build everything
all: install build

# Build and publish npm package
publish: package
    pnpm pack && pnpm publish --no-git-checks
