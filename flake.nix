{
  description = "A basic flake with a shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed (
          system: f nixpkgs.legacyPackages.${system}
        );
    in
    {
      devShells = forAllSystems (
        pkgs:
        let
          deps = with pkgs; lib.optionals stdenvNoCC.isLinux [
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
          ] ++ lib.optionals stdenvNoCC.isDarwin [
            #
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
            buildInputs = with pkgs; [
              pkg-config
              # nix-ld
            ] ++ deps;

            packages = with pkgs; [
              biome
              pnpm
            ];

            shellHook = ''
              export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:${pkgs.lib.makeLibraryPath deps}"
            '' + pkgs.lib.optionalString pkgs.stdenvNoCC.isLinux ''
              export GTK_IM_MODULE_FILE=${gtk3ImmodulesCache}
            '';
          };
        }
      );
    };
}
