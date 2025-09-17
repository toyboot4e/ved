{
  description = "A basic flake with a shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };
        deps = with pkgs; [
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
          # TODO: support Wayland?
          xorg.libX11
          xorg.libXcomposite
          xorg.libXdamage
          xorg.libXext
          xorg.libXfixes
          xorg.libXrandr
          xorg.libxcb
          libgbm
          expat
          libxkbcommon
          alsa-lib
          libdrm
          libGL
        ];
      in
      {
        devShells.default =
          with pkgs;
          mkShell {
            buildInputs = [
              pkg-config
              # nix-ld
            ] ++ deps;

            packages = [
              nodePackages.prettier
              vite
            ];
            shellHook = ''
              export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:${pkgs.lib.makeLibraryPath deps}"
            '';
          };
      }
    );
}
