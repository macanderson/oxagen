/**
 * ASCII art frames for the animated dragon creature.
 * 
 * Dragon animation cycles through 6 frames:
 * - Frame 0-1: Wings up (inhale)
 * - Frame 2-3: Wings down (exhale) 
 * - Frame 4-5: Fire breathing
 * 
 * Animation speed: 200ms per frame (5 FPS)
 * Total cycle: 1200ms
 */

export const DRAGON_FRAMES = [
  // Frame 0: Wings up - inhale start
  `
                 ^    ^
                / \\  / \\
               /   \\/   \\
          __  /  /\\  /\\  \\  __
         /  \\/  /  \\/  \\  \\/  \\
        |    \\ | () () | /    |
         \\    \\|   <>   |/    /
          \\    \\  ___  /    /
           \\    \\/   \\/    /
            |    |   |    |
            |    |   |    |
            /_/\\_|   |_/\\_\\
           /    |   |    \\
          /     |___|     \\
         {_____)     (_____)
  `,
  // Frame 1: Wings higher - inhale peak
  `
               ^      ^
              / \\    / \\
             /   \\  /   \\
        __  /  /\\  /\\  \\  __
       /  \\/  /  \\/  \\  \\/  \\
      |    \\ | () () | /    |
       \\    \\|   <>   |/    /
        \\    \\  ___  /    /
         \\    \\/   \\/    /
          |    |   |    |
          |    |   |    |
          /_/\\_|   |_/\\_\\
         /    |   |    \\
        /     |___|     \\
       {_____)     (_____)
  `,
  // Frame 2: Wings down - exhale start
  `
                 
                 
          __          __
         /  \\  /\\  /  \\
        |    \\ |  | /    |
       / \\    \\ () () /    / \\
      /   \\    |  <>  |    /   \\
     /     \\   | ___ |   /     \\
    |       \\  |/   \\|  /       |
    |        \\ |     | /        |
    |         \\|     |/         |
    /_/\\_     |     |     _/\\_\\
   /    |     |_____|     |    \\
  /     |               |     \\
 {_____)                 (_____)
  `,
  // Frame 3: Wings lowest - exhale peak
  `
                 
                 
          __          __
         /  \\  /\\  /  \\
        |    \\ |  | /    |
       /      \\ () () /      \\
      /        |  <>  |        \\
     /         | ___ |         \\
    |          |/   \\|          |
    |          |     |          |
    /_/\\_      |     |      _/\\_\\
   /    |      |_____|      |    \\
  /     |                 |     \\
 {_____)                   (_____)
  `,
  // Frame 4: Fire breath start
  `
                 
                ~*~
          __   ≈≈*≈≈   __
         /  \\  /\\*≈/  \\
        |    \\ |≈*| /    |
       /      \\ () () /      \\
      /        |  <>  |*~≈     \\
     /         | ___ |≈*~      \\
    |          |/   \\|*≈        |
    |          |     |≈~        |
    /_/\\_      |     |      _/\\_\\
   /    |      |_____|      |    \\
  /     |                 |     \\
 {_____)                   (_____)
  `,
  // Frame 5: Fire breath peak
  `
               ~*~≈*~
             ≈*~≈*≈~*≈
          __  *≈~*≈~*  __
         /  \\ *≈~*≈~* /  \\
        |    \\*≈~*≈~*/    |
       /     *≈ () () /      \\
      /      *≈  <>  |*~≈*~   \\
     /        *| ___ |≈*~≈*    \\
    |         *|/   \\|*≈~*≈     |
    |          *     |≈~*       |
    /_/\\_      |     |      _/\\_\\
   /    |      |_____|      |    \\
  /     |                 |     \\
 {_____)                   (_____)
  `,
] as const;

export const ANIMATION_CONFIG = {
  /** Milliseconds per frame */
  frameDelay: 200,
  /** Total frames in the animation cycle */
  totalFrames: DRAGON_FRAMES.length,
  /** Total duration of one animation cycle */
  cycleDuration: 1200,
} as const;
