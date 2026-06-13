# treefmt-nix module, evaluated from flake.nix. Owns Nix formatting only;
# the renderer's JS/TS is handled by biome via `just check`.
{
  projectRootFile = "flake.nix";
  programs.nixfmt.enable = true;
}
