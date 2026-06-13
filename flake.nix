{
  description = "ved — an Electron + React text editor";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { self, nixpkgs, ... }:
    let
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed (
          system: f nixpkgs.legacyPackages.${system}
        );
    in
    {
      packages = forAllSystems (pkgs: rec {
        default = ved;

        ved = pkgs.stdenv.mkDerivation (finalAttrs: {
          pname = "ved";
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
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
          ];

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            pnpm = pkgs.pnpm_10;
            fetcherVersion = 3;
            hash = "sha256-FLhJ2VAS/xTdjRaO8cx+NfUCjAtBq//2czsM395irF8=";
          };

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
            makeWrapper ${pkgs.lib.getExe pkgs.electron_42} $out/bin/ved \
              --add-flags $out/share/ved
            runHook postInstall
          '';

          meta.mainProgram = "ved";
        });
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
            ];

            shellHook =
              pkgs.lib.optionalString pkgs.stdenvNoCC.isLinux ''
                export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:${pkgs.lib.makeLibraryPath deps}"
                export GTK_IM_MODULE_FILE=${gtk3ImmodulesCache}
              '';
          };
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);
    };
}
