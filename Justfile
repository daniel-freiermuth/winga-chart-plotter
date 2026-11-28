# wasm-pack pin — keep in sync with WASM_PACK_VERSION in
# .github/workflows/{ci,deploy}.yml and .gitlab-ci.yml.
wasm_pack_version := "0.15.0"
wasm_pack := env_var_or_default('CARGO_HOME', env_var('HOME') / ".cargo") / "bin/wasm-pack"
# cargo-mutants pin — keep in sync with CARGO_MUTANTS_VERSION in
# .github/workflows/mutants.yml.
cargo_mutants_version := "27.1.0"
core      := "crates/core"
app       := "app"
wasm_out  := app / "src/wasm"

# Show available recipes
help:
    @just --list

# Install frontend dependencies
install:
    cd {{app}} && pnpm install

# Install the pinned wasm-pack (wasm_pack_version) via cargo; --force replaces
# binaries cargo does not track (e.g. from the upstream installer script)
install-wasm-pack:
    cargo install wasm-pack --locked --force --version {{wasm_pack_version}}

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

# Install the pinned cargo-mutants (cargo_mutants_version) via cargo
install-cargo-mutants:
    cargo install cargo-mutants --locked --force --version {{cargo_mutants_version}}

# Mutation-test the Rust lines changed since `base`, like the Mutants CI gate
mutants-diff base="origin/main":
    #!/usr/bin/env sh
    set -eu
    found="$(cargo mutants --version 2>/dev/null || true)"
    if [ "$found" != "cargo-mutants {{cargo_mutants_version}}" ]; then
        echo "error: cargo mutants is '${found:-missing}', expected 'cargo-mutants {{cargo_mutants_version}}' (the version CI runs). Run: just install-cargo-mutants" >&2
        exit 1
    fi
    # Diff against the working tree: uncommitted edits to tracked files are
    # included, untracked files are not. Config: .cargo/mutants.toml.
    merge_base="$(git merge-base "{{base}}" HEAD)"
    mkdir -p target
    git diff --relative "$merge_base" > target/mutants.diff
    cargo mutants --in-diff target/mutants.diff

# Run all linters and type-checkers (Rust + TypeScript)
lint:
    cargo fmt --check
    cargo clippy --all-targets --all-features -- -D warnings
    cargo clippy --target wasm32-unknown-unknown -p signalk-chart-core --all-features -- -D warnings
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
