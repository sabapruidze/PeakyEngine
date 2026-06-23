import { Peaky, Platformer, Solid } from "@peaky/runtime";

new Peaky({ width: 800, height: 600, backgroundColor: 0x1a1a2e }).start((game) => {
  // Player
  game
    .sprite({ color: 0x44ddff, w: 32, h: 48 })
    .at(100, 100)
    .addBehavior(Platformer, { maxSpeed: 220, jumpStrength: 460 });

  // Ground
  game.sprite({ color: 0x665544, w: 800, h: 40 }).at(400, 580).addBehavior(Solid);

  // Floating platforms
  game.sprite({ color: 0x665544, w: 200, h: 20 }).at(500, 420).addBehavior(Solid);
  game.sprite({ color: 0x665544, w: 160, h: 20 }).at(220, 320).addBehavior(Solid);
  game.sprite({ color: 0x665544, w: 120, h: 20 }).at(640, 240).addBehavior(Solid);
});
