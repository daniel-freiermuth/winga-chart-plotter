WASM_PACK := $(HOME)/.cargo/bin/wasm-pack
CORE := crates/core
APP := app
WASM_OUT := $(APP)/src/wasm

.PHONY: all build build-wasm dev test test-watch lint check-all clean install help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

all: install build ## Install deps and build everything

install: ## Install frontend dependencies
	cd $(APP) && npm install

build-wasm: ## Compile Rust core to WebAssembly
	$(WASM_PACK) build $(CORE) --target web --out-dir ../../$(WASM_OUT)

build: build-wasm ## Build WASM + frontend for production
	cd $(APP) && npm run build

package: build ## Build and assemble Signal K npm package (output: public/)
	rm -rf public && cp -r $(APP)/dist public

dev: build-wasm ## Build WASM then start the Vite dev server
	cd $(APP) && npm run dev

test: ## Run all Rust unit tests
	cargo test

test-watch: ## Run Rust tests in watch mode (requires cargo-watch)
	cargo watch -x test

lint: ## Run all linters and type-checkers (Rust + TypeScript)
	cargo fmt --check
	cargo clippy --all-targets --all-features -- -D warnings
	cd $(APP) && npm run check && npm run lint

check-all: lint test ## Run all lints and tests

clean: ## Remove build artifacts
	rm -rf target $(WASM_OUT) $(APP)/dist

publish:
	make package && npm pack && npm publish