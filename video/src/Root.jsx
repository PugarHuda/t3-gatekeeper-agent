import { Composition } from "remotion";
import { Demo } from "./Demo.jsx";
import timing from "./timing.json";

// Length comes from the measured narration, so the composition can never be
// shorter than the audio it is carrying.
export const Root = () => (
  <Composition
    id="Demo"
    component={Demo}
    durationInFrames={timing.totalFrames}
    fps={timing.fps}
    width={1920}
    height={1080}
  />
);
