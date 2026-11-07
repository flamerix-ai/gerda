{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      # Vineflower — the modern Fernflower fork the MC modding toolchain uses; cleaner
      # output than nixpkgs' cfr (records, switch exprs, MC's lambda-heavy code). Not in
      # nixpkgs, but it's one runnable JAR → fetch it + wrap `java -jar`. Bump version+hash
      # from github.com/Vineflower/vineflower/releases.
      vineflower = pkgs.stdenvNoCC.mkDerivation rec {
        pname = "vineflower";
        version = "1.12.0";
        src = pkgs.fetchurl {
          url = "https://github.com/Vineflower/vineflower/releases/download/${version}/vineflower-${version}.jar";
          hash = "sha256-Hfz+l0OVc0+kZ85iBmHHYj0FuoNnDeBSmx+9Y/9Ui50=";
        };
        dontUnpack = true;
        nativeBuildInputs = [ pkgs.makeWrapper ];
        installPhase = ''
          mkdir -p $out/share/java
          cp $src $out/share/java/vineflower.jar
          makeWrapper ${pkgs.jdk21}/bin/java $out/bin/vineflower \
            --add-flags "-jar $out/share/java/vineflower.jar"
        '';
      };
    in
    {
      devShells.${system} = {
        default = pkgs.mkShell {
          packages = with pkgs; [
            python312
            nodejs_22
            # The TS toolchain runner (`bun install`, `bun run check|build`): a fork's `nix develop`
            # takes it from here, not from a per-user install.
            bun
            just
            fd
            entr
            git
            # Secret scan of the public snapshot (maintainer release tooling, absent from a
            # fork) — required there, not optional: the guard aborts when it is missing.
            gitleaks
            # ffmpeg + ffprobe for the offline suites: motion_probe's luma/motion checks and the
            # sandbox `record` step run on real clips. Required, not optional — the mutant run
            # refuses a skipped CONTROL, and test_devshell_tools.py fails without them.
            # The headless build: no X/GL/audio stack to fetch.
            ffmpeg-headless
            # SRG/decompile tooling (scripts/dev/decompile.sh): Vineflower + a JDK to run it.
            vineflower
            jdk21
          ];
        };

        # `nix develop .#capture` — demo-video capture rig ONLY (scripts/ops/capture_rig.sh).
        # Deliberately SEPARATE from the default shell so nobody who only writes bot code has
        # to fetch the recording tools.
        #
        # Capture model (settled after a supervised bake-off — see the
        # capture_rig.sh header): run the game inside an INDEPENDENT headless sway
        # (WLR_BACKENDS=headless, off-screen output HEADLESS-1 — nothing on any monitor) and
        # record that output with `wf-recorder` (wlr-screencopy). The requirement was a
        # BACKGROUND recording invisible to the person at the desk — no fullscreen takeover,
        # no focus stealing — so recording off the real niri output (which must fullscreen the
        # game on a physical monitor) was rejected.
        #
        # Two dead ends this replaces: (1) gamescope→PipeWire export is unfixably BLACK on the
        # proprietary NVIDIA driver (zero DMA-BUF modifiers → suspended node; gamescope#477).
        # (2) niri has no headless backend and frame-callback-throttles an off-viewport nested
        # window, starving the recorder. sway's wlroots HEADLESS output renders continuously
        # off-screen and wlr-screencopy exports NON-BLACK on NVIDIA (the DMA-BUF wall is a
        # gamescope PipeWire problem, not a screencopy one). The headless output MUST carry an
        # explicit refresh (`mode WxH@60Hz`) or it emits no frame callbacks and the client
        # renders a single frame — see the capture_rig.sh @60Hz gotcha.
        #
        # MC runs via XWAYLAND, not native Wayland (hence the `xwayland` package + `xwayland
        # enable`): the modded client's main window is wrapped by borderless/window-position
        # mixins that call glfwSetWindowPos, which LWJGL's GLFW rejects on Wayland ("The platform
        # does not provide the window position") — the game crashes at the FML-loader→main-window
        # handoff. Under Xwayland (X11 backend) positioning works; sway still composites the X
        # window onto HEADLESS-1, so capture is identical. See the capture_rig.sh Phase 3 comment.
        #
        # Why wf-recorder over gpu-screen-recorder (the other contender): wf-recorder is a
        # single wlroots-screencopy binary — NO root, NO setcap, NO xdg-desktop-portal
        # picker — and still gets NVENC via `-c h264_nvenc` (with a clean `-c libx264` CPU
        # fallback). gpu-screen-recorder's monitor capture on Wayland needs a privileged
        # `gsr-kms-server` (cap_sys_admin / setuid) or an interactive portal grant, which is
        # a much higher bar for a fork to reproduce. Simplicity-for-forkers was the decider.
        capture = pkgs.mkShell {
          packages = with pkgs; [
            sway # independent headless compositor — hosts MC off-screen (HEADLESS-1)
            xwayland # MC runs via Xwayland (native-Wayland GLFW crashes on this modpack)
            wf-recorder # wlr-screencopy recorder — captures the headless output to a file
            ffmpeg # codec probe (nvenc vs libx264) + post-processing (crop/scale/concat)
            fontconfig # fc-match — assemble.py verifies the burned-in caption fonts are installed
            grim # single-frame wlr-screencopy — cheap frame grab for probes/verify
            python312 # local_config.py (instances root) + small JSON helpers in the rig
          ];
        };
      };
    };
}
