{
  description = "ved — an Electron + React text editor";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      treefmt-nix,
      ...
    }:
    let
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed (system: f nixpkgs.legacyPackages.${system});

      # treefmt configuration (see ./treefmt.nix). The renderer's JS/TS is
      # formatted by biome via `just check`, so treefmt only owns the Nix.
      treefmtEval = forAllSystems (pkgs: treefmt-nix.lib.evalModule pkgs ./treefmt.nix);

      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

      # Offline pnpm store, shared by the package build and the node-based
      # checks so there is a single hash to bump when the lockfile changes.
      pnpmDepsFor =
        pkgs:
        pkgs.fetchPnpmDeps {
          pname = "ved";
          inherit version;
          src = self;
          pnpm = pkgs.pnpm_10;
          fetcherVersion = 3;
          hash = "sha256-Gp4kTiJXKz3CAIRgVTmZk600yWHRP+rDOjj4LooQ4e8=";
        };

      # A sandboxed check that runs a pnpm script against a node_modules
      # materialized from the offline store (mirrors the package build's env).
      nodeCheck =
        pkgs: name: command:
        pkgs.stdenv.mkDerivation {
          name = "ved-${name}";
          src = self;
          nativeBuildInputs = with pkgs; [
            nodejs_24
            pnpm_10
            pnpmConfigHook
          ];
          pnpmDeps = pnpmDepsFor pkgs;
          env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
          # vitest 4 starts a Vite server bound to localhost; the macOS build
          # sandbox blocks loopback by default (Linux already allows it).
          __darwinAllowLocalNetworking = true;
          buildPhase = ''
            runHook preBuild
            ${command}
            runHook postBuild
          '';
          installPhase = "touch $out";
        };

    in
    {
      checks = forAllSystems (pkgs: {
        gha-lint =
          pkgs.runCommand "ved-workflow-check"
            {
              nativeBuildInputs = with pkgs; [
                zizmor
              ];
            }
            ''
              cd ${self}
              zizmor --offline .
              touch $out
            '';

        format = treefmtEval.${pkgs.stdenv.hostPlatform.system}.config.build.check self;

        # biome is a standalone binary, so linting needs no node_modules.
        lint = pkgs.runCommand "ved-lint" { nativeBuildInputs = [ pkgs.biome ]; } ''
          cd ${self}
          biome check
          touch $out
        '';

        typecheck = nodeCheck pkgs "typecheck" "pnpm run typecheck";

        test = nodeCheck pkgs "test" "pnpm run test";

        build = self.packages.${pkgs.stdenv.hostPlatform.system}.ved;
      });

      devShells = forAllSystems (
        pkgs:
        let
          deps =
            with pkgs;
            lib.optionals stdenvNoCC.isLinux [
              glib
              util-linux
              nss
              nspr
              dbus
              atk
              cups
              gtk3
              # GSettings schemas: GTK's file/print dialogs abort at runtime
              # ("No GSettings schemas are installed") unless the default
              # schema source can find a gschemas.compiled. gtk3 provides
              # org.gtk.Settings.FileChooser; gsettings-desktop-schemas the
              # org.gnome.desktop.* set. Wired onto XDG_DATA_DIRS in shellHook.
              gsettings-desktop-schemas
              pango
              cairo
              # Wayland (required for native Wayland and its text-input IME protocol)
              wayland
              libx11
              libxcomposite
              libxdamage
              libxext
              libxfixes
              libxrandr
              libxcb
              libgbm
              expat
              libxkbcommon
              alsa-lib
              libdrm
              libGL
              # libudev.so.1 — Electron 42 dynamically links it (was loaded via
              # NixOS' /run/current-system on host setups; explicit here so
              # `LD_LIBRARY_PATH` from `nix develop` is enough on its own).
              udev
            ];

          # IM module cache so the prebuilt Electron's gtk3 can resolve
          # GTK_IM_MODULE=fcitx/fcitx5 — required for IME on X11.
          # (The gtk3 package's own cache knows nothing about fcitx5-gtk.)
          gtk3ImmodulesCache = pkgs.runCommand "gtk3-immodules.cache" { } ''
            ${pkgs.gtk3.dev}/bin/gtk-query-immodules-3.0 \
              ${pkgs.fcitx5-gtk}/lib/gtk-3.0/3.0.0/immodules/*.so > $out
          '';
        in
        {
          default = pkgs.mkShell {
            buildInputs = with pkgs; [ pkg-config ] ++ deps;

            packages = with pkgs; [
              biome
              just
              nodejs_24
              pnpm
              pinact
              zizmor
            ];

            shellHook = pkgs.lib.optionalString pkgs.stdenvNoCC.isLinux ''
              export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:${pkgs.lib.makeLibraryPath deps}"
              export GTK_IM_MODULE_FILE=${gtk3ImmodulesCache}
              # Expose compiled GSettings schemas to GLib (see deps note above).
              export XDG_DATA_DIRS="${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:$XDG_DATA_DIRS"
            '';
          };
        }
      );

      formatter = forAllSystems (
        pkgs: treefmtEval.${pkgs.stdenv.hostPlatform.system}.config.build.wrapper
      );

      packages = forAllSystems (pkgs: rec {
        default = ved;

        ved = pkgs.stdenv.mkDerivation {
          pname = "ved";
          inherit version;
          src = self;

          # pnpm 10, not 11: pnpm 11's store writes a SQLite index whose file
          # descriptor is guarded on macOS; pnpm's cleanup closes fds by number
          # and gets SIGKILLed with EXC_GUARD inside the fetchDeps build.
          # nodejs_24 matches the Node bundled in Electron 42 (24.15.0).
          nativeBuildInputs = with pkgs; [
            nodejs_24
            pnpm_10
            pnpmConfigHook
            makeWrapper
            # Collects GSettings schemas (and GIO modules) from buildInputs into
            # $gappsWrapperArgs so the shipped wrapper can find a
            # gschemas.compiled — without it GTK's file dialog aborts at runtime
            # with "No GSettings schemas are installed". gtk3 variant (gtk3).
            wrapGAppsHook3
          ];

          # Provide the schema sets the wrapper hook collects: gtk3 for
          # org.gtk.Settings.FileChooser, gsettings-desktop-schemas for the
          # org.gnome.desktop.* set.
          buildInputs = with pkgs; [
            gtk3
            gsettings-desktop-schemas
          ];

          # We build the launcher wrapper by hand below (it needs --add-flags
          # for the app dir), so suppress wrapGAppsHook's automatic wrapping and
          # splice its $gappsWrapperArgs into our makeWrapper call instead.
          dontWrapGApps = true;

          pnpmDeps = pnpmDepsFor pkgs;

          # The electron npm package's binary download is skipped; the wrapper
          # below runs the app with the nixpkgs electron instead.
          env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

          buildPhase = ''
            runHook preBuild
            pnpm exec electron-vite build
            runHook postBuild
          '';

          # electron-vite externalizes package.json `dependencies` in the
          # main/preload bundles, so they need a node_modules at runtime —
          # reshape it to production-only before shipping it.
          installPhase = ''
            runHook preInstall
            pnpm install --offline --prod --frozen-lockfile --ignore-scripts
            mkdir -p $out/share/ved $out/bin
            cp -r out node_modules package.json $out/share/ved/
            runHook postInstall
          '';

          # Wrap in preFixup: wrapGAppsHook3 populates $gappsWrapperArgs in its
          # own preFixup hook, so the array is ready by the time this runs.
          preFixup = ''
            makeWrapper ${pkgs.lib.getExe pkgs.electron_42} $out/bin/ved \
              "''${gappsWrapperArgs[@]}" \
              --add-flags $out/share/ved
          '';

          meta.mainProgram = "ved";
        };
      });
    };
}
