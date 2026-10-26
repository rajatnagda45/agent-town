import * as Phaser from "phaser";
import { OfficeScene } from "./scenes/OfficeScene";
import { GAME_WIDTH, GAME_HEIGHT } from "@/lib/constants";

export const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  pixelArt: true,
  antialias: false,
  roundPixels: true,
  // Music uses HTML audio and calls own their AudioContext. The office has no Phaser sounds.
  audio: { noAudio: true },
  scene: [OfficeScene],
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.NO_CENTER,
  },
  physics: {
    default: "arcade",
    arcade: {
      gravity: { x: 0, y: 0 },
    },
  },
};
