PREFIX  ?= $(HOME)/.local
BINDIR  ?= $(PREFIX)/bin
APPDIR  ?= $(PREFIX)/share/applications
ICONDIR ?= $(PREFIX)/share/icons/hicolor/scalable/apps

# Linux icons crop the grid margin. The masters carry the art in an 824 square
# on a 1024 canvas (Apple's grid, ndisc/SUITE.md), which fills 80.5% of the tile --
# visibly smaller in the dock than Yaru's own icons, which fill 89%. Cropping to
# this viewBox gets the same 89% out of the master with no re-export. The Windows
# .ico takes the same crop (native Windows icons fill ~100%, so the margin reads
# small on the taskbar too); only the .icns keeps the full canvas.
LINUX_VIEWBOX ?= 49 49 926 926

DESKTOP_OUT := $(APPDIR)/nsmpl.desktop
TAURI_BIN   := src-tauri/target/release/nsmpl

.PHONY: help deps dev build install uninstall check clean icons version install-guard

help:
	@echo "Targets:"
	@echo "  make deps       npm install + cargo fetch (one-time setup)"
	@echo "  make dev        run 'tauri dev' (hot-reload)"
	@echo "  make build      release build of frontend + Rust binary"
	@echo "  make install    copy binary + desktop entry under PREFIX  [Linux]"
	@echo "                  (default PREFIX=\$$HOME/.local; sudo PREFIX=/usr/local for system-wide)"
	@echo "  ./install.sh    build a .app and install it to /Applications  [macOS]"
	@echo "  make uninstall  remove what 'install' put down"
	@echo "  make check      typecheck + cargo check (no build)"
	@echo "  make clean      remove dist/ and src-tauri/target/"
	@echo "  make version V=0.1.2   bump the version in all five files at once"

deps:
	npm install
	cd src-tauri && cargo fetch

dev:
	npm run tauri dev

# Regenerate the Tauri bundle icon set from icon.svg (run once per icon change).
icons:
	@if command -v rsvg-convert >/dev/null 2>&1; then \
		rsvg-convert -w 2048 -h 2048 icon.svg -o app-icon.png; \
	elif command -v convert >/dev/null 2>&1; then \
		convert -background none -resize 2048x2048 icon.svg app-icon.png; \
	else \
		echo "need rsvg-convert (librsvg2-bin) or imagemagick"; exit 1; \
	fi
	npm run tauri icon ./app-icon.png
	rm -f app-icon.png
	@# Linux raster set: these are what the .deb and the AppImage install into
	@# hicolor, and what Linux uses as the window icon, so re-render them from
	@# the margin-cropped canvas (ndisc/SUITE.md, 2026-09-18). The .icns and the
	@# mobile sets keep Apple's grid and stay as `tauri icon` wrote them.
	@# Needs rsvg-convert and ImageMagick. PNG32: because ImageMagick writes
	@# palette PNGs at the small sizes, which tauri::generate_context! rejects
	@# as "not RGBA".
	sed '1s|viewBox="[^"]*"|viewBox="$(LINUX_VIEWBOX)"|' icon.svg > app-icon-linux.svg
	rsvg-convert -w 2048 -h 2048 app-icon-linux.svg -o app-icon-linux.png
	@for n in 32x32 64x64 128x128 128x128@2x 256x256 icon; do \
		p=src-tauri/icons/$$n.png; \
		[ -f $$p ] || continue; \
		s=$$(identify -format '%w' $$p); \
		convert app-icon-linux.png -resize $${s}x$${s} PNG32:$$p; \
		echo "  linux icon -> $$p ($$s)"; \
	done
	@# Windows .ico from the same crop, at the sizes `tauri icon` writes.
	convert app-icon-linux.png -define icon:auto-resize=256,64,48,32,24,16 src-tauri/icons/icon.ico
	@echo "  windows icon -> src-tauri/icons/icon.ico"
	rm -f app-icon-linux.svg app-icon-linux.png

build: $(TAURI_BIN)

$(TAURI_BIN): $(shell find src src-tauri/src -type f) package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
	npm run tauri build -- --no-bundle

check:
	npm run build
	cd src-tauri && cargo check

# Guard, not part of the recipe: as a prerequisite this runs BEFORE
# $(TAURI_BIN), so macOS is turned away immediately instead of after paying for
# a full release build it is not going to install.
install-guard:
	@if [ "$$(uname)" = "Darwin" ]; then \
		echo "'make install' is the Linux layout (bare binary + .desktop)."; \
		echo "On macOS run ./install.sh — it builds a .app and installs it to /Applications."; \
		exit 1; \
	fi

install: install-guard $(TAURI_BIN)
	install -d $(BINDIR) $(APPDIR) $(ICONDIR)
	install -m 0755 $(TAURI_BIN) $(BINDIR)/nsmpl
	@# Linux fill: crop the grid margin on the way in (see LINUX_VIEWBOX).
	sed '1s|viewBox="[^"]*"|viewBox="$(LINUX_VIEWBOX)"|' icon.svg > $(ICONDIR)/nsmpl.svg
	chmod 0644 $(ICONDIR)/nsmpl.svg
	sed -e 's|@BINDIR@|$(BINDIR)|g' \
	    -e 's|@ICONDIR@|$(ICONDIR)|g' \
	    nsmpl.desktop.in > $(DESKTOP_OUT)
	chmod 0644 $(DESKTOP_OUT)
	@# Tidy up the pre-rename smpl-tool install if it's still on disk.
	@rm -f $(BINDIR)/smpl-tool \
	       $(APPDIR)/smpl-tool.desktop \
	       $(ICONDIR)/smpl-tool.svg
	@if command -v update-desktop-database >/dev/null 2>&1; then \
		update-desktop-database $(APPDIR) >/dev/null 2>&1 || true; \
	fi
	@if command -v gtk-update-icon-cache >/dev/null 2>&1; then \
		gtk-update-icon-cache -f -t $(PREFIX)/share/icons/hicolor >/dev/null 2>&1 || true; \
	fi
	@echo "installed to $(PREFIX)"
	@echo "  binary  -> $(BINDIR)/nsmpl"
	@echo "  desktop -> $(DESKTOP_OUT)"

uninstall:
	rm -f $(BINDIR)/nsmpl
	rm -f $(ICONDIR)/nsmpl.svg
	rm -f $(DESKTOP_OUT)
	@if command -v update-desktop-database >/dev/null 2>&1; then \
		update-desktop-database $(APPDIR) >/dev/null 2>&1 || true; \
	fi
	@if command -v gtk-update-icon-cache >/dev/null 2>&1; then \
		gtk-update-icon-cache -f -t $(PREFIX)/share/icons/hicolor >/dev/null 2>&1 || true; \
	fi
	@echo "uninstalled from $(PREFIX)"

clean:
	rm -rf dist src-tauri/target

# Bump every file that carries the version, in one step.
#
# There are five, and nothing in a build complains when they disagree: two in
# package-lock.json, one each in package.json, Cargo.toml and tauri.conf.json,
# plus the entry Cargo.lock keeps for this crate. Hand-editing a subset is the
# whole failure mode — six repositories in this suite had drifted that way, one
# of them four releases back, and npm's lockfile does not self-heal because
# nothing rewrites it until someone runs `npm install`.
#
#   make version V=0.1.2
version:
	@test -n "$(V)" || { echo "usage: make version V=0.1.2" >&2; exit 2; }
	@npm version --no-git-tag-version --allow-same-version "$(V)" >/dev/null
	@sed -i.bak -E 's/^version = ".*"/version = "$(V)"/' src-tauri/Cargo.toml && rm -f src-tauri/Cargo.toml.bak
	@python3 -c 'import re,sys; v=sys.argv[1]; p="src-tauri/tauri.conf.json"; s=open(p).read(); s2,k=re.subn(r"^(  \"version\"\s*:\s*)\"[^\"]*\"", lambda m: m.group(1)+"\""+v+"\"", s, count=1, flags=re.M); open(p,"w").write(s2) if k==1 else sys.exit("no top-level version key in "+p)' "$(V)"
	@name=$$(grep -m1 '^name = ' src-tauri/Cargo.toml | cut -d'"' -f2); python3 -c 'import re,sys; n,v=sys.argv[1],sys.argv[2]; p="src-tauri/Cargo.lock"; s=open(p).read(); s2,k=re.subn(r"(\[\[package\]\]\nname = \""+re.escape(n)+r"\"\nversion = )\"[^\"]*\"", lambda m: m.group(1)+"\""+v+"\"", s, count=1); open(p,"w").write(s2) if k==1 else sys.exit("no Cargo.lock entry for "+n)' "$$name" "$(V)"
	@echo "version set to $(V) in all five places:"
	@git diff --stat -- package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
