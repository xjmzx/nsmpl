PREFIX  ?= $(HOME)/.local
BINDIR  ?= $(PREFIX)/bin
APPDIR  ?= $(PREFIX)/share/applications
ICONDIR ?= $(PREFIX)/share/icons/hicolor/scalable/apps

DESKTOP_OUT := $(APPDIR)/smpl-tool.desktop
TAURI_BIN   := src-tauri/target/release/smpl-tool

.PHONY: help deps dev build install uninstall check clean

help:
	@echo "Targets:"
	@echo "  make deps       npm install + cargo fetch (one-time setup)"
	@echo "  make dev        run 'tauri dev' (hot-reload)"
	@echo "  make build      release build of frontend + Rust binary"
	@echo "  make install    copy binary + desktop entry under PREFIX"
	@echo "                  (default PREFIX=\$$HOME/.local; sudo PREFIX=/usr/local for system-wide)"
	@echo "  make uninstall  remove what 'install' put down"
	@echo "  make check      typecheck + cargo check (no build)"
	@echo "  make clean      remove dist/ and src-tauri/target/"

deps:
	npm install
	cd src-tauri && cargo fetch

dev:
	npm run tauri dev

build: $(TAURI_BIN)

$(TAURI_BIN): $(shell find src src-tauri/src -type f) package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
	npm run tauri build -- --no-bundle

check:
	npm run build
	cd src-tauri && cargo check

install: $(TAURI_BIN)
	install -d $(BINDIR) $(APPDIR) $(ICONDIR)
	install -m 0755 $(TAURI_BIN) $(BINDIR)/smpl-tool
	install -m 0644 icon.svg     $(ICONDIR)/smpl-tool.svg
	sed -e 's|@BINDIR@|$(BINDIR)|g' \
	    -e 's|@ICONDIR@|$(ICONDIR)|g' \
	    smpl-tool.desktop.in > $(DESKTOP_OUT)
	chmod 0644 $(DESKTOP_OUT)
	@if command -v update-desktop-database >/dev/null 2>&1; then \
		update-desktop-database $(APPDIR) >/dev/null 2>&1 || true; \
	fi
	@echo "installed to $(PREFIX)"
	@echo "  binary  -> $(BINDIR)/smpl-tool"
	@echo "  desktop -> $(DESKTOP_OUT)"

uninstall:
	rm -f $(BINDIR)/smpl-tool
	rm -f $(ICONDIR)/smpl-tool.svg
	rm -f $(DESKTOP_OUT)
	@if command -v update-desktop-database >/dev/null 2>&1; then \
		update-desktop-database $(APPDIR) >/dev/null 2>&1 || true; \
	fi
	@echo "uninstalled from $(PREFIX)"

clean:
	rm -rf dist src-tauri/target
