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

      # Per-system output hashes for the bun deps FOD below. bun downloads
      # only the current platform's optional dependencies (platform
      # binaries), so the tree differs per system. `just bump-hash` refreshes
      # the running system's entry (adding it first if missing); an empty
      # string makes Nix print the correct hash on the first build.
      bunDepsHash = {
        x86_64-linux = "sha256-wBWykUutYf3AD4afZRpMjx7KM8iH8wargY5NDQguuNg=";
      };

      # Offline node_modules trees, shared by the package build and the
      # node-based checks so there is a single hash to bump when the lockfile
      # changes. bun cannot install offline — even a --frozen-lockfile
      # install consults registry manifests to resolve workspace
      # dependencies, and bun's manifest cache is HTTP metadata
      # (nondeterministic) — so instead of an offline store this FOD ships
      # the fully *linked* trees: a dev flavor for building/checking and a
      # prod flavor for the shipped app. The isolated-linker layout is
      # relative-symlinked throughout (verified: independent installs are
      # NAR-identical), so plain copies preserve it.
      bunDepsFor =
        pkgs:
        pkgs.stdenvNoCC.mkDerivation {
          pname = "ved-bun-deps";
          inherit version;
          src = self;
          nativeBuildInputs = [
            pkgs.bun
            pkgs.cacert
          ];
          buildPhase = ''
            runHook preBuild
            export HOME=$TMPDIR
            export BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
            export ELECTRON_SKIP_BINARY_DOWNLOAD=1
            export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
            for flavor in dev prod; do
              work=$TMPDIR/work-$flavor
              cp -rT . $work
              flag=""
              [ $flavor = prod ] && flag="--production"
              (cd $work && bun install --frozen-lockfile --ignore-scripts $flag)
              for d in . editor desktop vim web; do
                if [ -d $work/$d/node_modules ]; then
                  mkdir -p $out/$flavor/$d
                  mv $work/$d/node_modules $out/$flavor/$d/node_modules
                fi
              done
            done
            runHook postBuild
          '';
          dontInstall = true;
          dontFixup = true;
          outputHashAlgo = "sha256";
          outputHashMode = "recursive";
          outputHash = bunDepsHash.${pkgs.stdenv.hostPlatform.system} or "";
        };

      # Materializes one flavor's node_modules trees into the unpacked source
      # (the bun analogue of nixpkgs' pnpmConfigHook). u+w because tools
      # write next to their packages (vite's dep cache). patchShebangs:
      # bun's .bin entries are symlinks to the packages' own bin scripts,
      # whose `#!/usr/bin/env node` does not exist in the build sandbox
      # (pnpm's shims were #!/bin/sh, which does). Patching happens here, on
      # the copies — never in the FOD, whose hash must stay layout-pure.
      copyBunDeps = deps: flavor: ''
        for d in . editor desktop vim web; do
          if [ -d ${deps}/${flavor}/$d/node_modules ]; then
            cp -r ${deps}/${flavor}/$d/node_modules $d/node_modules
            chmod -R u+w $d/node_modules
            patchShebangs --build $d/node_modules >/dev/null
          fi
        done
      '';

      # A sandboxed check that runs a bun script against the offline
      # node_modules (mirrors the package build's env).
      nodeCheck =
        pkgs: name: command:
        pkgs.stdenv.mkDerivation {
          name = "ved-${name}";
          src = self;
          nativeBuildInputs = with pkgs; [
            nodejs_26
            bun
          ];
          env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
          # vitest 4 starts a Vite server bound to localhost; the macOS build
          # sandbox blocks loopback by default (Linux already allows it).
          __darwinAllowLocalNetworking = true;
          buildPhase = ''
            runHook preBuild
            ${copyBunDeps (bunDepsFor pkgs) "dev"}
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

        typecheck = nodeCheck pkgs "typecheck" "bun run typecheck";

        test = nodeCheck pkgs "test" "bun run test";

        build = self.packages.${pkgs.stdenv.hostPlatform.system}.ved;
      });

      devShells = forAllSystems (
        pkgs:
        let
          # IM module cache so Electron's gtk3 can resolve
          # GTK_IM_MODULE=fcitx/fcitx5 — required for IME on X11.
          # (The gtk3 package's own cache knows nothing about fcitx5-gtk.)
          gtk3ImmodulesCache = pkgs.runCommand "gtk3-immodules.cache" { } ''
            ${pkgs.gtk3.dev}/bin/gtk-query-immodules-3.0 \
              ${pkgs.fcitx5-gtk}/lib/gtk-3.0/3.0.0/immodules/*.so > $out
          '';
        in
        {
          default = pkgs.mkShell {
            packages =
              with pkgs;
              [
                biome
                bun
                just
                ni
                nodejs_26
                pinact
                zizmor
              ]
              # Wayland key injection for the real-mozc e2e suite (test/e2e/mozc):
              # wtype speaks the virtual-keyboard protocol (wlroots/sway), ydotool
              # goes through uinput. The suite's X11 path uses xdotool, already on
              # NixOS hosts via /run/current-system.
              #
              # These are the WAYLAND injectors, but the gate is `isLinux`, not
              # "isWayland": a pure flake can't see the entering session's
              # XDG_SESSION_TYPE (the devShell closure is evaluated once and shared;
              # builtins.getEnv is empty under pure eval), so there is no eval-time
              # Wayland predicate. They are tiny and inert on X11 (unused — the
              # harness picks xdotool there). A Wayland-only closure would need a
              # separate `devShells.wayland`, not runtime detection.
              ++ pkgs.lib.optionals pkgs.stdenvNoCC.isLinux [
                wtype
                ydotool
              ];

            shellHook = pkgs.lib.optionalString pkgs.stdenvNoCC.isLinux ''
              # Dev runs nixpkgs' rpath-linked Electron — the same binary the
              # packaged app wraps — instead of the npm prebuilt (which has no
              # rpath and would need a global LD_LIBRARY_PATH; that variable
              # shadows the RUNPATH of every other Nix program launched from
              # this shell, e.g. breaking the system browser). The electron
              # npm module honors this override; keep pkgs.electron_43 in
              # step with desktop/package.json's electron version.
              #
              # Both variables MUST point at the bin/ WRAPPER, never the raw
              # libexec/ binary: the wrapper exports CHROME_DEVEL_SANDBOX,
              # without which Electron requires a SUID chrome-sandbox next to
              # the exe (impossible in /nix/store) and dies on a release
              # CHECK — a silent SIGILL, no output at all. The e2e harness
              # runs with chromiumSandbox: true to keep this path covered.
              export ELECTRON_OVERRIDE_DIST_PATH=${pkgs.electron_43}/bin
              # electron-vite resolves node_modules/electron/dist itself and
              # ignores the override above; it honors this full-path variable
              # instead (`just dev` breaks without it).
              export ELECTRON_EXEC_PATH=${pkgs.lib.getExe pkgs.electron_43}
              export ELECTRON_SKIP_BINARY_DOWNLOAD=1
              export GTK_IM_MODULE_FILE=${gtk3ImmodulesCache}
              # GSettings schemas: GTK's file/print dialogs abort at runtime
              # ("No GSettings schemas are installed") unless the default
              # schema source can find a gschemas.compiled. gtk3 provides
              # org.gtk.Settings.FileChooser; gsettings-desktop-schemas the
              # org.gnome.desktop.* set.
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

          # nodejs_26 is the build-tooling Node (vite/tsc/vitest); the shipped
          # app runs on the Node bundled in nixpkgs' electron, not this one.
          nativeBuildInputs = with pkgs; [
            nodejs_26
            bun
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

          # `just bump-hash` builds .#packages.<system>.ved.bunDeps.
          passthru.bunDeps = bunDepsFor pkgs;

          # The electron npm package's binary download is skipped; the wrapper
          # below runs the app with the nixpkgs electron instead.
          env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

          buildPhase = ''
            runHook preBuild
            ${copyBunDeps (bunDepsFor pkgs) "dev"}
            (cd desktop && ./node_modules/.bin/electron-vite build)
            runHook postBuild
          '';

          # The bun analogue of `pnpm deploy`: a workspace-shaped prod tree
          # under $out/share/ved — the workspace manifests and sources plus
          # the FOD's prod node_modules, whose relative symlinks (including
          # the @ved/* workspace links) stay intact inside the copied tree.
          # electron-vite externalizes the main/preload `dependencies`
          # (@electron-toolkit/*, node-pty, …), which desktop/node_modules
          # provides; the renderer bundle is self-contained. The app dir the
          # wrapper points at is $out/share/ved/desktop.
          installPhase = ''
            runHook preInstall
            mkdir -p $out/share/ved $out/bin
            cp package.json $out/share/ved/
            for p in editor vim web; do
              mkdir -p $out/share/ved/$p
              cp $p/package.json $out/share/ved/$p/
              cp -r $p/src $out/share/ved/$p/src
            done
            mkdir -p $out/share/ved/desktop
            cp desktop/package.json $out/share/ved/desktop/
            cp -r desktop/out $out/share/ved/desktop/out
            cp -r desktop/resources $out/share/ved/desktop/resources
            for d in . editor desktop vim web; do
              if [ -d ${bunDepsFor pkgs}/prod/$d/node_modules ]; then
                cp -r ${bunDepsFor pkgs}/prod/$d/node_modules \
                  $out/share/ved/$d/node_modules
              fi
            done
            runHook postInstall
          '';

          # Wrap in preFixup: wrapGAppsHook3 populates $gappsWrapperArgs in its
          # own preFixup hook, so the array is ready by the time this runs.
          preFixup = ''
            makeWrapper ${pkgs.lib.getExe pkgs.electron_43} $out/bin/ved \
              "''${gappsWrapperArgs[@]}" \
              --add-flags $out/share/ved/desktop
          '';

          meta.mainProgram = "ved";
        };
      });
    };
}
