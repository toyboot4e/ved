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
          ] ++ lib.optionals stdenvNoCC.isDarwin [
            #
          ];
        in
        {
          default = pkgs.mkShell {
            buildInputs = with pkgs; [
              pkg-config
              # nix-ld
            ] ++ deps;

            packages = with pkgs; [
              biome
            ];

            shellHook = ''
              export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:${pkgs.lib.makeLibraryPath deps}"
            '';
          };
        }
      );
    };
}
